use std::time::{Duration, Instant};

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use lettre::message::{Mailbox, MultiPart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use rand::Rng;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::crypto::CryptoService;
use crate::db::Db;
use crate::email_policy::{assert_registration_allowed, normalize_email};
use crate::error::{AppError, AppResult};
use crate::mail_diagnostics::{
    MailDeliveryBegin, begin_mail_delivery, diagnose_smtp_error, finish_mail_delivery_failure,
    finish_mail_delivery_success, get_mail_delivery,
};
use crate::models::{MailConfig, MailDelivery, iso_from_utc, now_iso};

const CODE_TTL_MINS: i64 = 15;
const CODE_COOLDOWN_SECS: i64 = 60;
const MAX_CODE_ATTEMPTS: i64 = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredMailConfig {
    #[serde(default)]
    host: String,
    #[serde(default = "default_port")]
    port: u16,
    #[serde(default)]
    secure: bool,
    #[serde(default, rename = "requireTLS")]
    require_tls: bool,
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    from_email: String,
    #[serde(default = "default_from_name")]
    from_name: String,
}

fn default_port() -> u16 {
    587
}

fn default_from_name() -> String {
    "ChatPony".to_string()
}

impl Default for StoredMailConfig {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: 587,
            secure: false,
            require_tls: false,
            username: String::new(),
            password: String::new(),
            from_email: String::new(),
            from_name: default_from_name(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedMailConfig {
    pub public: MailConfig,
    pub password: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailConfigInput {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub secure: bool,
    #[serde(default, rename = "requireTLS")]
    pub require_tls: bool,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub from_email: String,
    #[serde(default)]
    pub from_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailTestResult {
    pub ok: bool,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery: Option<MailDelivery>,
}

fn read_stored_mail_config(conn: &Connection) -> StoredMailConfig {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key='mailConfig'", [], |r| {
            r.get(0)
        })
        .optional()
        .unwrap_or(None);
    raw.and_then(|s| serde_json::from_str::<StoredMailConfig>(&s).ok())
        .unwrap_or_default()
}

pub fn get_mail_config(conn: &Connection) -> MailConfig {
    let stored = read_stored_mail_config(conn);
    MailConfig {
        host: stored.host,
        port: stored.port,
        secure: stored.secure,
        require_tls: stored.require_tls,
        username: stored.username,
        has_password: !stored.password.is_empty(),
        from_email: stored.from_email,
        from_name: if stored.from_name.trim().is_empty() {
            "ChatPony".to_string()
        } else {
            stored.from_name
        },
    }
}

pub fn resolve_mail_config(db: &Db, crypto: &CryptoService) -> AppResult<ResolvedMailConfig> {
    let stored = db.read(|conn| Ok(read_stored_mail_config(conn)))?;
    let password = if stored.password.is_empty() {
        String::new()
    } else {
        crypto.decrypt(&stored.password)?
    };
    let has_password = !stored.password.is_empty();
    Ok(ResolvedMailConfig {
        public: MailConfig {
            host: stored.host,
            port: stored.port,
            secure: stored.secure,
            require_tls: stored.require_tls,
            username: stored.username,
            has_password,
            from_email: stored.from_email,
            from_name: if stored.from_name.trim().is_empty() {
                "ChatPony".to_string()
            } else {
                stored.from_name
            },
        },
        password,
    })
}

pub fn update_mail_config(
    db: &Db,
    crypto: &CryptoService,
    input: MailConfigInput,
) -> AppResult<MailConfig> {
    let host = input.host.trim().to_string();
    if host.len() > 253 {
        return Err(AppError::validation("SMTP 主机名过长。"));
    }
    if input.port == 0 {
        return Err(AppError::validation("SMTP 端口号无效。"));
    }
    let username = input.username.trim().to_string();
    if username.len() > 200 {
        return Err(AppError::validation("SMTP 用户名过长。"));
    }
    let from_email = if input.from_email.trim().is_empty() {
        String::new()
    } else {
        normalize_email(&input.from_email)?
    };
    let from_name = if input.from_name.trim().is_empty() {
        "ChatPony".to_string()
    } else {
        input.from_name.trim().chars().take(80).collect()
    };

    db.write(|tx| {
        let prev = read_stored_mail_config(tx);
        let password = match input.password.as_deref() {
            Some("") => String::new(),
            Some(raw) => crypto.encrypt(raw)?,
            None => prev.password,
        };
        let next = StoredMailConfig {
            host,
            port: input.port,
            secure: input.secure,
            require_tls: input.require_tls,
            username,
            password,
            from_email,
            from_name,
        };
        let json = serde_json::to_string(&next).map_err(|_| AppError::internal())?;
        tx.execute(
            "INSERT INTO settings(key,value) VALUES('mailConfig',?)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            rusqlite::params![json],
        )?;
        Ok(get_mail_config(tx))
    })
}

pub fn assert_mail_configured(db: &Db, crypto: &CryptoService) -> AppResult<ResolvedMailConfig> {
    let cfg = resolve_mail_config(db, crypto)?;
    if cfg.public.host.trim().is_empty() || cfg.public.from_email.trim().is_empty() {
        return Err(AppError::service_unavailable(
            "MAIL_NOT_CONFIGURED",
            "平台尚未完成邮件服务（SMTP）配置，请联系管理员。",
        ));
    }
    Ok(cfg)
}

fn build_transport(cfg: &ResolvedMailConfig) -> AppResult<AsyncSmtpTransport<Tokio1Executor>> {
    let host = cfg.public.host.trim();
    if host.is_empty() {
        return Err(AppError::service_unavailable(
            "MAIL_NOT_CONFIGURED",
            "SMTP 主机不能为空。",
        ));
    }
    let tls_params = TlsParameters::new(host.to_string()).map_err(|err| {
        tracing::error!("Invalid TLS parameters for SMTP host {}: {:?}", host, err);
        AppError::bad_request("SMTP_CONFIG_ERROR", "无法初始化 SMTP TLS 配置。")
    })?;
    let tls = if cfg.public.secure {
        Tls::Wrapper(tls_params)
    } else if cfg.public.require_tls {
        Tls::Required(tls_params)
    } else {
        Tls::Opportunistic(tls_params)
    };

    let mut builder = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host)
        .port(cfg.public.port)
        .tls(tls)
        .timeout(Some(Duration::from_secs(15)));

    if !cfg.public.username.is_empty() || !cfg.password.is_empty() {
        builder = builder.credentials(Credentials::new(
            cfg.public.username.clone(),
            cfg.password.clone(),
        ));
    }

    Ok(builder.build())
}

fn build_message(
    cfg: &ResolvedMailConfig,
    recipient: &str,
    subject: &str,
    text_body: &str,
    html_body: &str,
) -> AppResult<Message> {
    let from_addr = cfg
        .public
        .from_email
        .parse()
        .map_err(|_| AppError::validation("发件邮箱格式无效。"))?;
    let to_addr = recipient
        .parse()
        .map_err(|_| AppError::validation("收件邮箱格式无效。"))?;
    let from_name = if cfg.public.from_name.trim().is_empty() {
        None
    } else {
        Some(cfg.public.from_name.clone())
    };
    Message::builder()
        .from(Mailbox::new(from_name, from_addr))
        .to(Mailbox::new(None, to_addr))
        .subject(subject)
        .multipart(MultiPart::alternative_plain_html(
            text_body.to_string(),
            html_body.to_string(),
        ))
        .map_err(|err| {
            tracing::error!("Failed to build email message: {:?}", err);
            AppError::internal()
        })
}

pub async fn send_tracked_email(
    db: &Db,
    cfg: &ResolvedMailConfig,
    kind: &str,
    recipient: &str,
    subject: &str,
    text_body: &str,
    html_body: &str,
) -> AppResult<Option<MailDelivery>> {
    let delivery_id = begin_mail_delivery(
        db,
        MailDeliveryBegin {
            kind: kind.to_string(),
            recipient: recipient.to_string(),
            smtp_host: cfg.public.host.clone(),
            smtp_port: i64::from(cfg.public.port),
            from_email: cfg.public.from_email.clone(),
        },
    );
    let started = Instant::now();

    let message = match build_message(cfg, recipient, subject, text_body, html_body) {
        Ok(m) => m,
        Err(err) => {
            let diag = diagnose_smtp_error(&err.message, "send");
            finish_mail_delivery_failure(
                db,
                delivery_id.as_deref(),
                started.elapsed().as_millis() as i64,
                &diag,
            );
            return Err(err);
        }
    };

    let transport = match build_transport(cfg) {
        Ok(t) => t,
        Err(err) => {
            let diag = diagnose_smtp_error(&err.message, "connect");
            finish_mail_delivery_failure(
                db,
                delivery_id.as_deref(),
                started.elapsed().as_millis() as i64,
                &diag,
            );
            return Err(err);
        }
    };

    match transport.send(message).await {
        Ok(resp) => {
            let msg = resp.message().collect::<Vec<_>>().join(" ");
            finish_mail_delivery_success(
                db,
                delivery_id.as_deref(),
                started.elapsed().as_millis() as i64,
                Some(&msg),
            );
            let record = delivery_id
                .as_deref()
                .and_then(|id| db.read(|conn| get_mail_delivery(conn, id)).ok().flatten());
            Ok(record)
        }
        Err(err) => {
            let diag = diagnose_smtp_error(&err.to_string(), "send");
            finish_mail_delivery_failure(
                db,
                delivery_id.as_deref(),
                started.elapsed().as_millis() as i64,
                &diag,
            );
            Err(AppError::service_unavailable(
                "MAIL_SEND_FAILED",
                format!("{} {}", diag.summary, diag.hint),
            ))
        }
    }
}

pub async fn test_mail(
    db: &Db,
    crypto: &CryptoService,
    recipient: Option<&str>,
) -> AppResult<MailTestResult> {
    let cfg = assert_mail_configured(db, crypto)?;
    if let Some(target) = recipient.map(str::trim).filter(|s| !s.is_empty()) {
        let email = normalize_email(target)?;
        let subject = "ChatPony SMTP 测试邮件";
        let text = "这是一封来自 ChatPony 的测试邮件，说明您的 SMTP 发信配置已经正常工作。";
        let html = format!(
            "<div style=\"font-family:sans-serif;padding:24px;color:#2e2824\"><h2>ChatPony 邮件测试成功</h2><p>{text}</p><p style=\"color:#6b645c;font-size:12px\">发送时间：{}</p></div>",
            now_iso()
        );
        let delivery = send_tracked_email(db, &cfg, "test", &email, subject, text, &html).await?;
        return Ok(MailTestResult {
            ok: true,
            summary: format!("测试邮件已发送至 {email}"),
            hint: None,
            delivery,
        });
    }

    let delivery_id = begin_mail_delivery(
        db,
        MailDeliveryBegin {
            kind: "test".to_string(),
            recipient: String::new(),
            smtp_host: cfg.public.host.clone(),
            smtp_port: i64::from(cfg.public.port),
            from_email: cfg.public.from_email.clone(),
        },
    );
    let started = Instant::now();
    let transport = build_transport(&cfg)?;
    match transport.test_connection().await {
        Ok(true) => {
            finish_mail_delivery_success(
                db,
                delivery_id.as_deref(),
                started.elapsed().as_millis() as i64,
                Some("SMTP 握手与认证测试成功"),
            );
            let delivery = delivery_id
                .as_deref()
                .and_then(|id| db.read(|conn| get_mail_delivery(conn, id)).ok().flatten());
            Ok(MailTestResult {
                ok: true,
                summary: "SMTP 连接与身份验证测试成功。".to_string(),
                hint: None,
                delivery,
            })
        }
        Ok(false) => {
            let diag = diagnose_smtp_error("SMTP test_connection returned false", "connect");
            finish_mail_delivery_failure(
                db,
                delivery_id.as_deref(),
                started.elapsed().as_millis() as i64,
                &diag,
            );
            Err(AppError::service_unavailable(
                "MAIL_TEST_FAILED",
                format!("{} {}", diag.summary, diag.hint),
            ))
        }
        Err(err) => {
            let diag = diagnose_smtp_error(&err.to_string(), "connect");
            finish_mail_delivery_failure(
                db,
                delivery_id.as_deref(),
                started.elapsed().as_millis() as i64,
                &diag,
            );
            Err(AppError::service_unavailable(
                "MAIL_TEST_FAILED",
                format!("{} {}", diag.summary, diag.hint),
            ))
        }
    }
}

fn hash_code(salt: &str, code: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update(b":");
    hasher.update(code.as_bytes());
    hex::encode(hasher.finalize())
}

pub async fn send_registration_code(
    db: &Db,
    crypto: &CryptoService,
    raw_email: &str,
) -> AppResult<()> {
    let email = normalize_email(raw_email)?;
    let cfg = assert_mail_configured(db, crypto)?;

    let (code, salt, expires_at, sent_at) = db.write(|tx| {
        let policy = assert_registration_allowed(tx, &email)?;
        if !policy.require_email_verification {
            return Err(AppError::bad_request(
                "VERIFICATION_NOT_REQUIRED",
                "当前平台未开启邮箱验证码注册。",
            ));
        }

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

        let prev: Option<(String, i64)> = tx
            .query_row(
                "SELECT sent_at, delivered FROM registration_challenges WHERE email=? COLLATE NOCASE",
                rusqlite::params![email],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((last_sent, delivered)) = prev {
            if delivered != 0 {
                if let Ok(dt) = DateTime::parse_from_rfc3339(&last_sent) {
                    let elapsed = (Utc::now() - dt.with_timezone(&Utc)).num_seconds();
                    if elapsed < CODE_COOLDOWN_SECS {
                        let wait = CODE_COOLDOWN_SECS - elapsed;
                        return Err(AppError::too_many_requests(
                            "EMAIL_COOLDOWN",
                            format!("发送过于频繁，请 {wait} 秒后再试。"),
                        ));
                    }
                }
            }
        }

        let num: u32 = rand::rngs::OsRng.gen_range(0..1_000_000);
        let code = format!("{num:06}");
        let mut salt_bytes = [0u8; 16];
        rand::rngs::OsRng.fill(&mut salt_bytes);
        let salt = hex::encode(salt_bytes);
        let code_hash = hash_code(&salt, &code);
        let now = Utc::now();
        let sent_at = iso_from_utc(now);
        let expires_at = iso_from_utc(now + ChronoDuration::minutes(CODE_TTL_MINS));

        tx.execute(
            "DELETE FROM registration_challenges WHERE expires_at < ?",
            rusqlite::params![sent_at],
        )?;
        tx.execute(
            "INSERT INTO registration_challenges(email,code_hash,salt,expires_at,sent_at,attempts,delivered)
             VALUES(?,?,?,?,?,0,0)
             ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,salt=excluded.salt,
               expires_at=excluded.expires_at,sent_at=excluded.sent_at,attempts=0,delivered=0",
            rusqlite::params![email, code_hash, salt, expires_at, sent_at],
        )?;
        Ok((code, salt, expires_at, sent_at))
    })?;
    let _ = (salt, expires_at);

    let subject = format!("ChatPony 注册验证码：{code}");
    let text = format!(
        "您的 ChatPony 注册验证码是：{code}\n验证码将在 {CODE_TTL_MINS} 分钟内有效。如非本人操作请忽略本邮件。"
    );
    let html = format!(
        "<div style=\"font-family:sans-serif;padding:24px;color:#2e2824\"><h2>ChatPony 邮箱验证</h2><p>您的注册验证码为：</p><p style=\"font-size:28px;font-weight:700;letter-spacing:6px;color:#315B52\">{code}</p><p style=\"color:#6b645c;font-size:13px\">验证码 {CODE_TTL_MINS} 分钟内有效。如非本人操作，请忽略此邮件。</p></div>"
    );

    if let Err(err) =
        send_tracked_email(db, &cfg, "verification", &email, &subject, &text, &html).await
    {
        let _ = db.write(|tx| {
            tx.execute(
                "DELETE FROM registration_challenges WHERE email=? COLLATE NOCASE AND sent_at=?",
                rusqlite::params![email, sent_at],
            )?;
            Ok(())
        });
        return Err(err);
    }

    db.write(|tx| {
        tx.execute(
            "UPDATE registration_challenges SET delivered=1 WHERE email=? COLLATE NOCASE AND sent_at=?",
            rusqlite::params![email, sent_at],
        )?;
        Ok(())
    })?;
    Ok(())
}

pub fn verify_registration_challenge(
    tx: &rusqlite::Transaction<'_>,
    email: &str,
    code: &str,
) -> AppResult<()> {
    let trimmed = code.trim();
    if trimmed.is_empty() {
        return Err(AppError::bad_request(
            "EMAIL_CODE_REQUIRED",
            "请输入邮箱验证码。",
        ));
    }

    let row: Option<(String, String, String, i64, i64)> = tx
        .query_row(
            "SELECT code_hash, salt, expires_at, attempts, delivered
             FROM registration_challenges WHERE email=? COLLATE NOCASE",
            rusqlite::params![email],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?;

    let Some((expected_hash, salt, expires_at, attempts, delivered)) = row else {
        return Err(AppError::bad_request(
            "EMAIL_CODE_INVALID",
            "请先获取邮箱验证码。",
        ));
    };

    let now = now_iso();
    if delivered == 0 || expires_at <= now {
        return Err(AppError::bad_request(
            "EMAIL_CODE_EXPIRED",
            "邮箱验证码已过期，请重新发送。",
        ));
    }

    if attempts >= MAX_CODE_ATTEMPTS {
        return Err(AppError::too_many_requests(
            "EMAIL_CODE_LOCKED",
            "验证码尝试次数过多，请重新获取验证码。",
        ));
    }

    let candidate_hash = hash_code(&salt, trimmed);
    let matches: bool = candidate_hash
        .as_bytes()
        .ct_eq(expected_hash.as_bytes())
        .into();

    if !matches {
        tx.execute(
            "UPDATE registration_challenges SET attempts=attempts+1 WHERE email=? COLLATE NOCASE",
            rusqlite::params![email],
        )?;
        return Err(AppError::bad_request(
            "EMAIL_CODE_INVALID",
            "邮箱验证码不正确。",
        ));
    }

    Ok(())
}
