use std::sync::atomic::{AtomicI64, Ordering};

use chrono::{Duration, Utc};
use regex::Regex;
use rusqlite::{Connection, OptionalExtension, Row, params_from_iter, types::Value as SqlValue};

use crate::db::Db;
use crate::error::AppResult;
use crate::models::{MailDelivery, MailDeliveryList, iso_from_utc, new_id, now_iso};

pub const MAIL_DELIVERY_RETENTION_DAYS: i64 = 30;
const PRUNE_INTERVAL_SECS: i64 = 15 * 60;
static LAST_MAIL_PRUNE_TS: AtomicI64 = AtomicI64::new(0);

#[derive(Debug, Clone)]
pub struct MailDiagnoseResult {
    pub stage: String,
    pub code: Option<String>,
    pub command: Option<String>,
    pub smtp_code: Option<i64>,
    pub enhanced_status: Option<String>,
    pub response: Option<String>,
    pub summary: String,
    pub hint: String,
}

#[derive(Debug, Clone)]
pub struct MailDeliveryBegin {
    pub kind: String,
    pub recipient: String,
    pub smtp_host: String,
    pub smtp_port: i64,
    pub from_email: String,
}

fn redact_mail_text(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let truncated: String = trimmed.chars().take(1000).collect();
    truncated
}

pub fn diagnose_smtp_error(err_str: &str, default_stage: &str) -> MailDiagnoseResult {
    let raw = redact_mail_text(err_str);
    let lower = raw.to_ascii_lowercase();

    let smtp_code = Regex::new(r"\b([245]\d{2})\b")
        .ok()
        .and_then(|re| re.captures(&raw))
        .and_then(|cap| cap.get(1))
        .and_then(|m| m.as_str().parse::<i64>().ok());

    let enhanced_status = Regex::new(r"\b([245]\.\d+\.\d+)\b")
        .ok()
        .and_then(|re| re.captures(&raw))
        .and_then(|cap| cap.get(1))
        .map(|m| m.as_str().to_string());

    let command = if lower.contains("auth ") || lower.contains("authentication") {
        Some("AUTH".to_string())
    } else if lower.contains("mail from") {
        Some("MAIL FROM".to_string())
    } else if lower.contains("rcpt to") {
        Some("RCPT TO".to_string())
    } else if lower.contains("starttls") {
        Some("STARTTLS".to_string())
    } else if lower.contains("ehlo") || lower.contains("helo") {
        Some("EHLO".to_string())
    } else if lower.contains("data") {
        Some("DATA".to_string())
    } else {
        None
    };

    let stage = if lower.contains("timeout")
        || lower.contains("connection refused")
        || lower.contains("connect")
        || lower.contains("dns")
        || lower.contains("tls")
        || lower.contains("certificate")
        || lower.contains("handshake")
    {
        "connect".to_string()
    } else if smtp_code == Some(535)
        || smtp_code == Some(534)
        || lower.contains("auth")
        || lower.contains("credential")
        || lower.contains("username and password")
    {
        "auth".to_string()
    } else if smtp_code.is_some() {
        "send".to_string()
    } else {
        default_stage.to_string()
    };

    let (code, summary, hint) = if lower.contains("timed out") || lower.contains("timeout") {
        (
            Some("ETIMEDOUT".to_string()),
            "连接 SMTP 服务器超时。".to_string(),
            "请检查主机名、端口、网络连通性，以及是否与隐式 TLS（465）/ STARTTLS（587）设置匹配。".to_string(),
        )
    } else if lower.contains("connection refused") {
        (
            Some("ECONNREFUSED".to_string()),
            "SMTP 服务器拒绝了连接。".to_string(),
            "请确认 SMTP 主机地址与端口号正确，且目标端口正在监听。".to_string(),
        )
    } else if lower.contains("failed to lookup")
        || lower.contains("dns")
        || lower.contains("no such host")
    {
        (
            Some("EDNS".to_string()),
            "无法解析 SMTP 服务器域名。".to_string(),
            "请核对 SMTP 主机域名拼写与服务器 DNS 解析配置。".to_string(),
        )
    } else if lower.contains("certificate")
        || lower.contains("tls")
        || lower.contains("ssl")
        || lower.contains("handshake")
    {
        (
            Some("ETLS".to_string()),
            "TLS/SSL 握手失败。".to_string(),
            "若使用 465 端口请开启“隐式 TLS”，若使用 587 端口请关闭“隐式 TLS”并按需开启 STARTTLS。".to_string(),
        )
    } else if smtp_code == Some(535) || smtp_code == Some(534) || stage == "auth" {
        (
            Some("EAUTH".to_string()),
            "SMTP 身份认证失败。".to_string(),
            "请检查用户名与授权码/密码；QQ、163、Gmail 等邮箱通常需要使用应用专用授权码而非登录密码。".to_string(),
        )
    } else if smtp_code == Some(550) || smtp_code == Some(551) || smtp_code == Some(553) {
        (
            Some("ERECIPIENT".to_string()),
            "发件人或收件人地址被服务器拒收。".to_string(),
            "请确认发件邮箱与认证账号一致，且目标收件人地址存在有效邮箱账户。".to_string(),
        )
    } else if smtp_code == Some(554) || smtp_code == Some(552) {
        (
            Some("ECONTENT".to_string()),
            "邮件内容或投递策略被服务器拒绝。".to_string(),
            "请检查发件域名 SPF/DKIM 记录，或确认主题与正文未触发反垃圾策略。".to_string(),
        )
    } else if matches!(smtp_code, Some(421 | 450 | 451 | 452 | 454)) {
        (
            Some("ETEMPFAIL".to_string()),
            "SMTP 服务器暂时拒绝处理请求。".to_string(),
            "这通常是频率限制或服务端临时繁忙导致，请稍后重试。".to_string(),
        )
    } else {
        (
            Some("ESMTP".to_string()),
            "发送邮件失败。".to_string(),
            "请查看诊断详情与服务器响应以定位具体原因。".to_string(),
        )
    };

    MailDiagnoseResult {
        stage,
        code,
        command,
        smtp_code,
        enhanced_status,
        response: if raw.is_empty() { None } else { Some(raw) },
        summary,
        hint,
    }
}

pub fn begin_mail_delivery(db: &Db, input: MailDeliveryBegin) -> Option<String> {
    let now_ts = Utc::now().timestamp();
    let should_prune = now_ts - LAST_MAIL_PRUNE_TS.load(Ordering::Relaxed) > PRUNE_INTERVAL_SECS;

    let res = db.write(|tx| {
        if should_prune {
            LAST_MAIL_PRUNE_TS.store(now_ts, Ordering::Relaxed);
            let cutoff = iso_from_utc(Utc::now() - Duration::days(MAIL_DELIVERY_RETENTION_DAYS));
            let _ = tx.execute(
                "DELETE FROM mail_deliveries WHERE created_at < ?",
                rusqlite::params![cutoff],
            );
        }
        let id = new_id();
        let now = now_iso();
        tx.execute(
            "INSERT INTO mail_deliveries(
                id, kind, status, recipient, smtp_host, smtp_port, from_email, stage, summary, hint, created_at
             ) VALUES(?,?,?,?,?,?,?,'connect','正在投递邮件','',?)",
            rusqlite::params![
                id,
                input.kind,
                "pending",
                input.recipient,
                input.smtp_host,
                input.smtp_port,
                input.from_email,
                now
            ],
        )?;
        Ok(id)
    });

    match res {
        Ok(id) => Some(id),
        Err(err) => {
            tracing::warn!("Failed to record mail delivery start: {:?}", err);
            None
        }
    }
}

pub fn finish_mail_delivery_success(
    db: &Db,
    id: Option<&str>,
    duration_ms: i64,
    response: Option<&str>,
) {
    let Some(id) = id else {
        return;
    };
    let finished = now_iso();
    let resp = response.map(redact_mail_text).filter(|s| !s.is_empty());
    let _ = db.write(|tx| {
        tx.execute(
            "UPDATE mail_deliveries
             SET status='success', stage='done', smtp_code=250, response=?, summary='邮件投递成功',
                 hint='', finished_at=?, duration_ms=?
             WHERE id=?",
            rusqlite::params![resp, finished, duration_ms, id],
        )?;
        Ok(())
    });
}

pub fn finish_mail_delivery_failure(
    db: &Db,
    id: Option<&str>,
    duration_ms: i64,
    diag: &MailDiagnoseResult,
) {
    let Some(id) = id else {
        return;
    };
    let finished = now_iso();
    let _ = db.write(|tx| {
        tx.execute(
            "UPDATE mail_deliveries
             SET status='failed', stage=?, code=?, command=?, smtp_code=?, enhanced_status=?,
                 response=?, summary=?, hint=?, finished_at=?, duration_ms=?
             WHERE id=?",
            rusqlite::params![
                diag.stage,
                diag.code,
                diag.command,
                diag.smtp_code,
                diag.enhanced_status,
                diag.response,
                diag.summary,
                diag.hint,
                finished,
                duration_ms,
                id
            ],
        )?;
        Ok(())
    });
}

fn row_to_delivery(row: &Row<'_>) -> rusqlite::Result<MailDelivery> {
    Ok(MailDelivery {
        id: row.get("id")?,
        kind: row.get("kind")?,
        status: row.get("status")?,
        recipient: row.get("recipient")?,
        smtp_host: row.get("smtp_host")?,
        smtp_port: row.get("smtp_port")?,
        from_email: row.get("from_email")?,
        stage: row.get("stage")?,
        code: row.get("code")?,
        command: row.get("command")?,
        smtp_code: row.get("smtp_code")?,
        enhanced_status: row.get("enhanced_status")?,
        response: row.get("response")?,
        summary: row.get("summary")?,
        hint: row.get("hint")?,
        created_at: row.get("created_at")?,
        finished_at: row.get("finished_at")?,
        duration_ms: row.get("duration_ms")?,
    })
}

pub fn list_mail_deliveries(
    db: &Db,
    page: i64,
    page_size: i64,
    status: Option<&str>,
    kind: Option<&str>,
) -> AppResult<MailDeliveryList> {
    let page = page.max(1);
    let page_size = if page_size <= 0 {
        20
    } else {
        page_size.clamp(1, 100)
    };
    let offset = (page - 1) * page_size;

    let mut clauses: Vec<String> = Vec::new();
    let mut values: Vec<SqlValue> = Vec::new();
    if let Some(st) = status.map(str::trim).filter(|s| !s.is_empty() && *s != "all") {
        clauses.push("status = ?".to_string());
        values.push(SqlValue::Text(st.to_string()));
    }
    if let Some(k) = kind.map(str::trim).filter(|s| !s.is_empty() && *s != "all") {
        clauses.push("kind = ?".to_string());
        values.push(SqlValue::Text(k.to_string()));
    }
    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };

    db.read(|conn| {
        let count_sql = format!("SELECT COUNT(*) FROM mail_deliveries{where_sql}");
        let total: i64 = conn.query_row(&count_sql, params_from_iter(values.iter()), |r| r.get(0))?;

        let list_sql = format!(
            "SELECT id,kind,status,recipient,smtp_host,smtp_port,from_email,stage,code,command,
                    smtp_code,enhanced_status,response,summary,hint,created_at,finished_at,duration_ms
             FROM mail_deliveries{where_sql}
             ORDER BY created_at DESC, rowid DESC
             LIMIT ? OFFSET ?"
        );
        let mut qparams = values.clone();
        qparams.push(SqlValue::Integer(page_size));
        qparams.push(SqlValue::Integer(offset));
        let mut stmt = conn.prepare(&list_sql)?;
        let items = stmt
            .query_map(params_from_iter(qparams.iter()), row_to_delivery)?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(MailDeliveryList {
            items,
            total,
            page,
            page_size,
            retention_days: MAIL_DELIVERY_RETENTION_DAYS,
        })
    })
}

pub fn get_mail_delivery(conn: &Connection, id: &str) -> AppResult<Option<MailDelivery>> {
    conn.query_row(
        "SELECT id,kind,status,recipient,smtp_host,smtp_port,from_email,stage,code,command,
                smtp_code,enhanced_status,response,summary,hint,created_at,finished_at,duration_ms
         FROM mail_deliveries WHERE id=?",
        rusqlite::params![id],
        row_to_delivery,
    )
    .optional()
    .map_err(Into::into)
}
