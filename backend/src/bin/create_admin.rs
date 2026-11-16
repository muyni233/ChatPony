use std::env;
use std::io::{self, Write};

use rusqlite::OptionalExtension;

use chatpony_backend::auth::{hash_password, validate_name, validate_password};
use chatpony_backend::config::Config;
use chatpony_backend::db::Db;
use chatpony_backend::email_policy::normalize_email;
use chatpony_backend::models::{new_id, now_iso};

fn prompt_line(label: &str) -> String {
    print!("{label}");
    io::stdout().flush().ok();
    let mut buf = String::new();
    io::stdin().read_line(&mut buf).ok();
    buf.trim().to_string()
}

fn read_arg(args: &[String], flag: &str) -> Option<String> {
    args.windows(2)
        .find(|w| w[0] == flag)
        .map(|w| w[1].clone())
}

fn main() {
    let _ = dotenvy::dotenv();
    let args: Vec<String> = env::args().collect();

    let raw_email = read_arg(&args, "--email")
        .or_else(|| env::var("ADMIN_EMAIL").ok())
        .unwrap_or_else(|| prompt_line("Admin email: "));
    let raw_name = read_arg(&args, "--name")
        .or_else(|| env::var("ADMIN_NAME").ok())
        .unwrap_or_else(|| prompt_line("Admin name: "));
    let raw_password = read_arg(&args, "--password")
        .or_else(|| env::var("ADMIN_PASSWORD").ok())
        .unwrap_or_else(|| {
            rpassword::prompt_password("Admin password (min 8 chars): ").unwrap_or_default()
        });

    let email = normalize_email(&raw_email).expect("invalid email address");
    let name = validate_name(&raw_name).expect("invalid display name");
    validate_password(&raw_password).expect("password must be between 8 and 128 characters");
    let pw_hash = hash_password(&raw_password).expect("failed to hash password");

    let config = Config::from_env();
    let db = Db::open(&config).expect("failed to open database");

    db.write(|tx| {
        let existing: Option<String> = tx
            .query_row(
                "SELECT id FROM users WHERE email=? COLLATE NOCASE",
                rusqlite::params![email],
                |r| r.get(0),
            )
            .optional()?;

        if let Some(uid) = existing {
            tx.execute(
                "UPDATE users SET name=?, password_hash=?, role='admin', disabled=0 WHERE id=?",
                rusqlite::params![name, pw_hash, uid],
            )?;
            println!("Updated existing account {email} ({uid}) to active admin.");
        } else {
            let id = new_id();
            let now = now_iso();
            tx.execute(
                "INSERT INTO users(id,email,name,password_hash,role,disabled,timezone,limit_5h,limit_7d,quota_reset_at,created_at,email_verified_at,character_slots)
                 VALUES(?,?,?,?,'admin',0,'Asia/Shanghai',500,5000,'1970-01-01T00:00:00.000Z',?,?,20)",
                rusqlite::params![id, email, name, pw_hash, now, now],
            )?;
            println!("Created admin account {email} ({id}).");
        }
        Ok(())
    })
    .expect("failed to save admin user");
}
