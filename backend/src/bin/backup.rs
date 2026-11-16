use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::Local;
use rusqlite::Connection;
use rusqlite::backup::Backup;

use chatpony_backend::config::Config;

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<usize> {
    if !src.is_dir() {
        return Ok(0);
    }
    fs::create_dir_all(dst)?;
    let mut count = 0;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        let target = dst.join(entry.file_name());
        if path.is_dir() {
            count += copy_dir_recursive(&path, &target)?;
        } else if path.is_file() {
            fs::copy(&path, &target)?;
            count += 1;
        }
    }
    Ok(count)
}

fn main() {
    let _ = dotenvy::dotenv();
    let args: Vec<String> = env::args().collect();
    let dest_root = args
        .windows(2)
        .find(|w| w[0] == "--dest")
        .map(|w| PathBuf::from(&w[1]))
        .or_else(|| args.get(1).filter(|a| !a.starts_with('-')).map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("./backups"));

    let config = Config::from_env();
    let db_path = PathBuf::from(&config.database_path);
    if !db_path.is_file() {
        eprintln!("Database file not found: {}", db_path.display());
        std::process::exit(1);
    }

    let stamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
    let backup_dir = dest_root.join(format!("backup-{stamp}"));
    fs::create_dir_all(&backup_dir).expect("failed to create backup directory");

    let target_db = backup_dir.join("chatpony.db");
    {
        let src = Connection::open(&db_path).expect("failed to open source database");
        let mut dst = Connection::open(&target_db).expect("failed to create backup database");
        let backup = Backup::new(&src, &mut dst).expect("failed to start SQLite backup");
        backup
            .run_to_completion(64, Duration::from_millis(25), None)
            .expect("SQLite backup failed");
    }

    if let Some(parent) = db_path.parent() {
        let key_file = parent.join(".encryption-key");
        if key_file.is_file() {
            fs::copy(&key_file, backup_dir.join(".encryption-key"))
                .expect("failed to copy .encryption-key");
        }
    }

    let avatars_src = config.avatar_directory();
    let avatars_count =
        copy_dir_recursive(&avatars_src, &backup_dir.join("avatars")).unwrap_or(0);

    println!(
        "Backup created at {} (database + {} avatar files)",
        backup_dir.display(),
        avatars_count
    );
}
