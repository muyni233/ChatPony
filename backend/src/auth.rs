use std::net::SocketAddr;

use argon2::password_hash::SaltString;
use argon2::password_hash::rand_core::OsRng as ArgonOsRng;
use argon2::{Algorithm, Argon2, Params, PasswordHash, PasswordHasher, PasswordVerifier, Version};
use axum::http::header::{COOKIE, CONTENT_TYPE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use chrono::{Duration, Utc};
use rand::RngCore;
use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::config::Config;
use crate::db::Db;
use crate::email_policy::{assert_registration_allowed, normalize_email};
use crate::error::{AppError, AppResult};
use crate::mail::verify_registration_challenge;
use crate::mappers::row_to_user;
use crate::models::{User, iso_from_utc, new_id, now_iso};

pub const SESSION_COOKIE_NAME: &str = "chatpony_session";
const SESSION_TTL_DAYS: i64 = 30;

fn argon2_instance() -> Argon2<'static> {
    let params = Params::new(19_456, 2, 1, None).expect("valid Argon2id params");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

pub fn hash_password(password: &str) -> AppResult<String> {
    let salt = SaltString::generate(&mut ArgonOsRng);
    argon2_instance()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|err| {
            tracing::error!("Argon2 hash failed: {:?}", err);
            AppError::internal()
        })
}

pub fn verify_password(password: &str, stored_hash: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(stored_hash) else {
        return false;
    };
    argon2_instance()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

pub fn make_dummy_hash() -> String {
    hash_password("chatpony-dummy-password-padding-value")
        .unwrap_or_else(|_| "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string())
}

pub fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn generate_session_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

pub fn extract_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    for value in headers.get_all(COOKIE) {
        let Ok(raw) = value.to_str() else {
            continue;
        };
        for part in raw.split(';') {
            let trimmed = part.trim();
            if let Some((k, v)) = trimmed.split_once('=') {
                if k.trim() == name {
                    let val = v.trim();
                    if !val.is_empty() {
                        return Some(val.to_string());
                    }
                }
            }
        }
    }
    None
}

pub fn is_https_request(headers: &HeaderMap, config: &Config) -> bool {
    if config.trust_proxy {
        if let Some(proto) = headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
        {
            if proto
                .split(',')
                .next()
                .map(|s| s.trim().eq_ignore_ascii_case("https"))
                .unwrap_or(false)
            {
                return true;
            }
        }
    }
    if let Some(origin) = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    {
        return origin.to_ascii_lowercase().starts_with("https://");
    }
    false
}

pub fn build_session_cookie(token: &str, secure: bool, max_age_secs: i64) -> HeaderValue {
    let secure_attr = if secure { "; Secure" } else { "" };
    let val = format!(
        "{SESSION_COOKIE_NAME}={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={max_age_secs}{secure_attr}"
    );
    HeaderValue::from_str(&val).expect("valid session cookie header")
}

pub fn session_set_cookie(token: &str, headers: &HeaderMap, config: &Config) -> HeaderValue {
    build_session_cookie(token, is_https_request(headers, config), SESSION_TTL_DAYS * 86_400)
}

pub fn session_clear_cookie(headers: &HeaderMap, config: &Config) -> HeaderValue {
    build_session_cookie("", is_https_request(headers, config), 0)
}

pub fn assert_mutation_request(headers: &HeaderMap) -> AppResult<()> {
    if let Some(sfs) = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) {
        if sfs.trim().eq_ignore_ascii_case("cross-site") {
            return Err(AppError::forbidden(
                "CSRF_BLOCKED",
                "拒绝跨站提交的修改请求。",
            ));
        }
    }
    Ok(())
}

pub fn assert_json_mutation(headers: &HeaderMap) -> AppResult<()> {
    assert_mutation_request(headers)?;
    let ct = headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let media_type = ct.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if media_type != "application/json" {
        return Err(AppError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "UNSUPPORTED_MEDIA_TYPE",
            "请求体必须使用 application/json 格式。",
        ));
    }
    Ok(())
}

pub fn client_ip(headers: &HeaderMap, peer: Option<SocketAddr>, trust_proxy: bool) -> String {
    if trust_proxy {
        if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
            if let Some(first) = xff.split(',').next().map(str::trim).filter(|s| !s.is_empty()) {
                return first.to_string();
            }
        }
        if let Some(xri) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
            let trimmed = xri.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    peer.map(|addr| addr.ip().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

pub fn check_rate_limit(db: &Db, key: &str, max_attempts: i64, window_secs: i64) -> AppResult<()> {
    db.write(|tx| {
        let now = Utc::now();
        let now_str = iso_from_utc(now);
        tx.execute(
            "DELETE FROM rate_limits WHERE expires_at <= ?",
            rusqlite::params![now_str],
        )?;

        let existing: Option<(i64, String)> = tx
            .query_row(
                "SELECT attempts, expires_at FROM rate_limits WHERE key=?",
                rusqlite::params![key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;

        if let Some((attempts, _)) = existing {
            if attempts >= max_attempts {
                return Err(AppError::too_many_requests(
                    "RATE_LIMITED",
                    "请求过于频繁，请稍后再试。",
                ));
            }
            tx.execute(
                "UPDATE rate_limits SET attempts=attempts+1 WHERE key=?",
                rusqlite::params![key],
            )?;
        } else {
            let expires = iso_from_utc(now + Duration::seconds(window_secs));
            tx.execute(
                "INSERT INTO rate_limits(key,attempts,expires_at) VALUES(?,1,?)",
                rusqlite::params![key, expires],
            )?;
        }
        Ok(())
    })
}

pub fn current_user(db: &Db, headers: &HeaderMap) -> AppResult<Option<User>> {
    let Some(token) = extract_cookie(headers, SESSION_COOKIE_NAME) else {
        return Ok(None);
    };
    let token_hash = hash_token(&token);
    let now = now_iso();
    db.read(|conn| {
        let user: Option<User> = conn
            .query_row(
                "SELECT u.id,u.email,u.name,u.role,u.disabled,u.timezone,u.created_at,
                        u.email_verified_at,u.avatar,u.persona,u.limit_5h,u.limit_7d,u.character_slots
                 FROM sessions s JOIN users u ON u.id=s.user_id
                 WHERE s.token_hash=? AND s.expires_at > ?",
                rusqlite::params![token_hash, now],
                row_to_user,
            )
            .optional()?;
        match user {
            Some(u) if !u.disabled => Ok(Some(u)),
            _ => Ok(None),
        }
    })
}

pub fn require_user(db: &Db, headers: &HeaderMap) -> AppResult<User> {
    let Some(token) = extract_cookie(headers, SESSION_COOKIE_NAME) else {
        return Err(AppError::unauthorized("请先登录。"));
    };
    let token_hash = hash_token(&token);
    let now = now_iso();
    let user: Option<User> = db.read(|conn| {
        conn.query_row(
            "SELECT u.id,u.email,u.name,u.role,u.disabled,u.timezone,u.created_at,
                    u.email_verified_at,u.avatar,u.persona,u.limit_5h,u.limit_7d,u.character_slots
             FROM sessions s JOIN users u ON u.id=s.user_id
             WHERE s.token_hash=? AND s.expires_at > ?",
            rusqlite::params![token_hash, now],
            row_to_user,
        )
        .optional()
        .map_err(Into::into)
    })?;
    let Some(u) = user else {
        return Err(AppError::unauthorized("登录已过期，请重新登录。"));
    };
    if u.disabled {
        return Err(AppError::forbidden("ACCOUNT_DISABLED", "该账号已被停用。"));
    }
    Ok(u)
}

pub fn require_admin(db: &Db, headers: &HeaderMap) -> AppResult<User> {
    let user = require_user(db, headers)?;
    if user.role != "admin" {
        return Err(AppError::forbidden("FORBIDDEN", "仅管理员可执行此操作。"));
    }
    Ok(user)
}

pub fn create_session_conn(conn: &Connection, user_id: &str) -> AppResult<String> {
    let token = generate_session_token();
    let token_hash = hash_token(&token);
    let now = Utc::now();
    let created_at = iso_from_utc(now);
    let expires_at = iso_from_utc(now + Duration::days(SESSION_TTL_DAYS));
    conn.execute(
        "DELETE FROM sessions WHERE expires_at <= ?",
        rusqlite::params![created_at],
    )?;
    conn.execute(
        "INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)",
        rusqlite::params![token_hash, user_id, created_at, expires_at],
    )?;
    Ok(token)
}

pub fn destroy_session(db: &Db, headers: &HeaderMap) -> AppResult<()> {
    let Some(token) = extract_cookie(headers, SESSION_COOKIE_NAME) else {
        return Ok(());
    };
    let token_hash = hash_token(&token);
    db.write(|tx| {
        tx.execute(
            "DELETE FROM sessions WHERE token_hash=?",
            rusqlite::params![token_hash],
        )?;
        Ok(())
    })
}

pub fn revoke_user_sessions_tx(
    tx: &rusqlite::Transaction<'_>,
    user_id: &str,
    keep_token_hash: Option<&str>,
) -> AppResult<()> {
    if let Some(keep) = keep_token_hash {
        tx.execute(
            "DELETE FROM sessions WHERE user_id=? AND token_hash != ?",
            rusqlite::params![user_id, keep],
        )?;
    } else {
        tx.execute(
            "DELETE FROM sessions WHERE user_id=?",
            rusqlite::params![user_id],
        )?;
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct RegisterInput {
    pub email: String,
    pub password: String,
    pub name: String,
    pub timezone: Option<String>,
    pub verification_code: Option<String>,
}

pub fn normalize_timezone(tz: Option<&str>) -> String {
    let candidate = tz.map(str::trim).filter(|s| !s.is_empty());
    if let Some(name) = candidate {
        if name.parse::<chrono_tz::Tz>().is_ok() {
            return name.to_string();
        }
    }
    "Asia/Shanghai".to_string()
}

pub fn validate_password(password: &str) -> AppResult<()> {
    if password.chars().count() < 8 {
        return Err(AppError::validation("密码至少需要 8 个字符。"));
    }
    if password.len() > 128 {
        return Err(AppError::validation("密码不能超过 128 个字符。"));
    }
    Ok(())
}

pub fn validate_name(name: &str) -> AppResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::validation("请输入昵称。"));
    }
    if trimmed.chars().count() > 60 {
        return Err(AppError::validation("昵称不能超过 60 个字符。"));
    }
    Ok(trimmed.to_string())
}

fn read_default_limits(conn: &Connection) -> (i64, i64, i64) {
    let read_i64 = |key: &str, default_val: i64| -> i64 {
        conn.query_row("SELECT value FROM settings WHERE key=?", [key], |r| {
            r.get::<_, String>(0)
        })
        .ok()
        .and_then(|raw| serde_json::from_str::<i64>(&raw).ok())
        .unwrap_or(default_val)
    };
    (
        read_i64("defaultLimit5h", 50).max(0),
        read_i64("defaultLimit7d", 500).max(0),
        read_i64("defaultCharacterSlots", 3).clamp(0, 100),
    )
}

pub async fn register_user(db: &Db, input: RegisterInput) -> AppResult<(User, String)> {
    let email = normalize_email(&input.email)?;
    let name = validate_name(&input.name)?;
    validate_password(&input.password)?;
    let timezone = normalize_timezone(input.timezone.as_deref());
    let verification_code = input.verification_code.unwrap_or_default();

    // Hash off the async thread before entering SQLite write lock
    let raw_pw = input.password;
    let password_hash = tokio::task::spawn_blocking(move || hash_password(&raw_pw))
        .await
        .map_err(|_| AppError::internal())??;

    db.write(move |tx| {
        let policy = assert_registration_allowed(tx, &email)?;
        let existing: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM users WHERE email=? COLLATE NOCASE",
                rusqlite::params![email],
                |r| r.get(0),
            )
            .optional()?;
        if existing.is_some() {
            return Err(AppError::conflict("EMAIL_EXISTS", "该邮箱已被注册。"));
        }

        let email_verified_at = if policy.require_email_verification {
            verify_registration_challenge(tx, &email, &verification_code)?;
            Some(now_iso())
        } else {
            None
        };

        let (limit_5h, limit_7d, slots) = read_default_limits(tx);
        let id = new_id();
        let now = now_iso();
        tx.execute(
            "INSERT INTO users(id,email,name,password_hash,role,disabled,timezone,limit_5h,limit_7d,quota_reset_at,created_at,email_verified_at,character_slots)
             VALUES(?,?,?,?,'user',0,?,?,?,'1970-01-01T00:00:00.000Z',?,?,?)",
            rusqlite::params![
                id,
                email,
                name,
                password_hash,
                timezone,
                limit_5h,
                limit_7d,
                now,
                email_verified_at,
                slots
            ],
        )?;
        tx.execute(
            "DELETE FROM registration_challenges WHERE email=? COLLATE NOCASE",
            rusqlite::params![email],
        )?;
        let token = create_session_conn(tx, &id)?;
        let user = tx.query_row(
            "SELECT id,email,name,role,disabled,timezone,created_at,email_verified_at,avatar,persona,limit_5h,limit_7d,character_slots
             FROM users WHERE id=?",
            rusqlite::params![id],
            row_to_user,
        )?;
        Ok((user, token))
    })
}

pub async fn login_user(
    db: &Db,
    dummy_hash: &str,
    raw_email: &str,
    password: &str,
) -> AppResult<(User, String)> {
    let email = normalize_email(raw_email)?;
    if password.is_empty() || password.len() > 256 {
        return Err(AppError::unauthorized("邮箱或密码错误。"));
    }

    let found: Option<(User, String)> = db.read(|conn| {
        conn.query_row(
            "SELECT id,email,name,role,disabled,timezone,created_at,email_verified_at,avatar,persona,limit_5h,limit_7d,character_slots,password_hash
             FROM users WHERE email=? COLLATE NOCASE",
            rusqlite::params![email],
            |row| {
                let u = row_to_user(row)?;
                let hash: String = row.get("password_hash")?;
                Ok((u, hash))
            },
        )
        .optional()
        .map_err(Into::into)
    })?;

    let hash_to_check = found
        .as_ref()
        .map(|(_, h)| h.clone())
        .unwrap_or_else(|| dummy_hash.to_string());
    let pw = password.to_string();
    let verified = tokio::task::spawn_blocking(move || verify_password(&pw, &hash_to_check))
        .await
        .map_err(|_| AppError::internal())?;

    let Some((user, _)) = found.filter(|_| verified) else {
        return Err(AppError::unauthorized("邮箱或密码错误。"));
    };
    if user.disabled {
        return Err(AppError::forbidden("ACCOUNT_DISABLED", "该账号已被停用。"));
    }

    let token = db.write(|tx| create_session_conn(tx, &user.id))?;
    Ok((user, token))
}
