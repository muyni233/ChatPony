use std::sync::atomic::{AtomicI64, Ordering};

use chrono::{Duration, Utc};
use rusqlite::{Connection, OptionalExtension, Row, params_from_iter, types::Value as SqlValue};
use serde_json::Value;
use url::Url;

use crate::db::Db;
use crate::error::AppResult;
use crate::models::{
    RequestAudit, RequestAuditDetail, RequestAuditList, RequestAuditStats, iso_from_utc, new_id,
    now_iso,
};

const MAX_AUDIT_BODY_BYTES: usize = 16 * 1024;
const PRUNE_INTERVAL_SECS: i64 = 15 * 60;
static LAST_AUDIT_PRUNE_TS: AtomicI64 = AtomicI64::new(0);

#[derive(Debug, Clone)]
pub struct AuditBeginInput {
    pub kind: String,
    pub user_id: Option<String>,
    pub user_name: Option<String>,
    pub conversation_id: Option<String>,
    pub character_id: Option<String>,
    pub character_name: Option<String>,
    pub supplier_id: Option<String>,
    pub supplier_name: Option<String>,
    pub model_id: Option<String>,
    pub protocol: String,
    pub model: String,
    pub endpoint: String,
    pub request_id: Option<String>,
    pub attempt: i64,
    pub request_body: Option<Value>,
}

#[derive(Debug, Clone, Default)]
pub struct AuditFinishInput {
    pub status: String,
    pub http_status: Option<i64>,
    pub duration_ms: Option<i64>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub response_body: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct AuditQuery {
    pub page: i64,
    pub page_size: i64,
    pub status: Option<String>,
    pub kind: Option<String>,
    pub supplier_id: Option<String>,
    pub user_id: Option<String>,
    pub search: Option<String>,
}

pub fn redact_url(raw: &str) -> String {
    let Ok(mut parsed) = Url::parse(raw) else {
        return raw.to_string();
    };
    let pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .map(|(k, v)| {
            let lower = k.to_ascii_lowercase();
            let redacted = matches!(
                lower.as_str(),
                "key" | "api_key" | "apikey" | "token" | "secret" | "access_token"
            );
            (
                k.into_owned(),
                if redacted {
                    "[REDACTED]".to_string()
                } else {
                    v.into_owned()
                },
            )
        })
        .collect();
    if !pairs.is_empty() {
        let mut ser = parsed.query_pairs_mut();
        ser.clear();
        for (k, v) in pairs {
            ser.append_pair(&k, &v);
        }
    }
    parsed.to_string()
}

pub fn redact_json_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (k, v) in map {
                let lower = k.to_ascii_lowercase();
                let is_secret = matches!(
                    lower.as_str(),
                    "authorization"
                        | "x-api-key"
                        | "x-goog-api-key"
                        | "api_key"
                        | "apikey"
                        | "token"
                        | "access_token"
                        | "refresh_token"
                        | "secret"
                        | "password"
                        | "cookie"
                        | "set-cookie"
                );
                if is_secret {
                    out.insert(k.clone(), Value::String("[REDACTED]".to_string()));
                } else if lower == "data" && v.as_str().map(|s| s.len() > 256).unwrap_or(false) {
                    let len = v.as_str().map(|s| s.len()).unwrap_or(0);
                    out.insert(k.clone(), Value::String(format!("[base64:{len} chars]")));
                } else if (lower == "url" || lower == "image_url")
                    && v.as_str().map(|s| s.starts_with("data:")).unwrap_or(false)
                {
                    let len = v.as_str().map(|s| s.len()).unwrap_or(0);
                    out.insert(k.clone(), Value::String(format!("[data-url:{len} chars]")));
                } else {
                    out.insert(k.clone(), redact_json_value(v));
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(redact_json_value).collect()),
        _ => value.clone(),
    }
}

pub fn truncate_audit_text(text: &str) -> (String, bool) {
    if text.len() <= MAX_AUDIT_BODY_BYTES {
        return (text.to_string(), false);
    }
    let mut end = MAX_AUDIT_BODY_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}...(truncated)", &text[..end]), true)
}

fn read_audit_settings(conn: &Connection) -> (bool, i64) {
    let capture = conn
        .query_row(
            "SELECT value FROM settings WHERE key='auditCaptureContent'",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|v| serde_json::from_str::<bool>(&v).ok())
        .unwrap_or(false);
    let retention = conn
        .query_row(
            "SELECT value FROM settings WHERE key='auditRetentionDays'",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|v| serde_json::from_str::<i64>(&v).ok())
        .unwrap_or(7)
        .clamp(1, 365);
    (capture, retention)
}

pub fn begin_audit(db: &Db, input: AuditBeginInput) -> Option<(String, bool)> {
    let now_ts = Utc::now().timestamp();
    let last_prune = LAST_AUDIT_PRUNE_TS.load(Ordering::Relaxed);
    let should_prune = now_ts - last_prune > PRUNE_INTERVAL_SECS;

    let res = db.write(|tx| {
        let (capture, retention_days) = read_audit_settings(tx);
        if should_prune {
            LAST_AUDIT_PRUNE_TS.store(now_ts, Ordering::Relaxed);
            let cutoff = iso_from_utc(Utc::now() - Duration::days(retention_days));
            let _ = tx.execute(
                "DELETE FROM request_audits WHERE created_at < ?",
                rusqlite::params![cutoff],
            );
        }

        let id = new_id();
        let now = now_iso();
        let endpoint = redact_url(&input.endpoint);
        let (req_body, req_truncated) = if capture {
            if let Some(ref body) = input.request_body {
                let redacted = redact_json_value(body);
                let serialized = serde_json::to_string_pretty(&redacted)
                    .unwrap_or_else(|_| redacted.to_string());
                let (txt, trunc) = truncate_audit_text(&serialized);
                (Some(txt), trunc)
            } else {
                (None, false)
            }
        } else {
            (None, false)
        };

        tx.execute(
            "INSERT INTO request_audits(
                id, kind, user_id, user_name, conversation_id, character_id, character_name,
                supplier_id, supplier_name, model_id, protocol, model, endpoint, status,
                created_at, request_id, attempt, request_body, request_truncated
             ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            rusqlite::params![
                id,
                input.kind,
                input.user_id,
                input.user_name,
                input.conversation_id,
                input.character_id,
                input.character_name,
                input.supplier_id,
                input.supplier_name,
                input.model_id,
                input.protocol,
                input.model,
                endpoint,
                "pending",
                now,
                input.request_id,
                input.attempt.max(1),
                req_body,
                if req_truncated { 1 } else { 0 },
            ],
        )?;
        Ok((id, capture))
    });

    match res {
        Ok(pair) => Some(pair),
        Err(err) => {
            tracing::warn!("Failed to insert request audit: {:?}", err);
            None
        }
    }
}

pub fn finish_audit(db: &Db, audit_id: Option<&str>, capture: bool, input: AuditFinishInput) {
    let Some(id) = audit_id else {
        return;
    };
    let finished_at = now_iso();
    let (resp_body, resp_truncated) = if capture {
        if let Some(ref raw) = input.response_body {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                (None, false)
            } else if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
                let redacted = redact_json_value(&parsed);
                let pretty = serde_json::to_string_pretty(&redacted).unwrap_or_else(|_| raw.clone());
                let (txt, trunc) = truncate_audit_text(&pretty);
                (Some(txt), trunc)
            } else {
                let (txt, trunc) = truncate_audit_text(trimmed);
                (Some(txt), trunc)
            }
        } else {
            (None, false)
        }
    } else {
        (None, false)
    };

    let err_msg = input
        .error_message
        .as_deref()
        .map(|m| m.chars().take(1000).collect::<String>());

    let res = db.write(|tx| {
        tx.execute(
            "UPDATE request_audits
             SET status=?, http_status=?, duration_ms=?, input_tokens=?, output_tokens=?,
                 error_code=?, error_message=?, finished_at=?, response_body=?, response_truncated=?
             WHERE id=?",
            rusqlite::params![
                input.status,
                input.http_status,
                input.duration_ms,
                input.input_tokens,
                input.output_tokens,
                input.error_code,
                err_msg,
                finished_at,
                resp_body,
                if resp_truncated { 1 } else { 0 },
                id,
            ],
        )?;
        Ok(())
    });
    if let Err(err) = res {
        tracing::warn!("Failed to finish request audit {}: {:?}", id, err);
    }
}

fn row_to_audit(row: &Row<'_>) -> rusqlite::Result<RequestAudit> {
    Ok(RequestAudit {
        id: row.get("id")?,
        kind: row.get::<_, Option<String>>("kind")?.unwrap_or_else(|| "chat".to_string()),
        user_id: row.get("user_id")?,
        user_name: row.get("user_name")?,
        conversation_id: row.get("conversation_id")?,
        character_id: row.get("character_id")?,
        character_name: row.get("character_name")?,
        supplier_id: row.get("supplier_id")?,
        supplier_name: row.get("supplier_name")?,
        model_id: row.get("model_id")?,
        protocol: row.get("protocol")?,
        model: row.get("model")?,
        endpoint: row.get("endpoint")?,
        status: row.get("status")?,
        http_status: row.get("http_status")?,
        duration_ms: row.get("duration_ms")?,
        input_tokens: row.get("input_tokens")?,
        output_tokens: row.get("output_tokens")?,
        error_code: row.get("error_code")?,
        error_message: row.get("error_message")?,
        created_at: row.get("created_at")?,
        finished_at: row.get("finished_at")?,
        request_id: row.get("request_id")?,
        attempt: row.get("attempt")?,
        request_truncated: row.get::<_, i64>("request_truncated")? != 0,
        response_truncated: row.get::<_, i64>("response_truncated")? != 0,
    })
}

pub fn list_audits(db: &Db, query: AuditQuery) -> AppResult<RequestAuditList> {
    let page = query.page.max(1);
    let page_size = if query.page_size <= 0 {
        30
    } else {
        query.page_size.clamp(1, 100)
    };
    let offset = (page - 1) * page_size;

    let mut clauses: Vec<String> = Vec::new();
    let mut values: Vec<SqlValue> = Vec::new();

    if let Some(status) = query.status.as_deref().map(str::trim).filter(|s| !s.is_empty() && *s != "all") {
        clauses.push("status = ?".to_string());
        values.push(SqlValue::Text(status.to_string()));
    }
    if let Some(kind) = query.kind.as_deref().map(str::trim).filter(|s| !s.is_empty() && *s != "all") {
        clauses.push("kind = ?".to_string());
        values.push(SqlValue::Text(kind.to_string()));
    }
    if let Some(sid) = query.supplier_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        clauses.push("supplier_id = ?".to_string());
        values.push(SqlValue::Text(sid.to_string()));
    }
    if let Some(uid) = query.user_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        clauses.push("user_id = ?".to_string());
        values.push(SqlValue::Text(uid.to_string()));
    }
    if let Some(search) = query.search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let escaped = search
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let pattern = format!("%{escaped}%");
        clauses.push(
            "(model LIKE ? ESCAPE '\\' OR endpoint LIKE ? ESCAPE '\\' OR COALESCE(user_name,'') LIKE ? ESCAPE '\\' OR COALESCE(character_name,'') LIKE ? ESCAPE '\\' OR COALESCE(supplier_name,'') LIKE ? ESCAPE '\\' OR COALESCE(error_message,'') LIKE ? ESCAPE '\\' OR COALESCE(request_id,'') LIKE ? ESCAPE '\\')"
                .to_string(),
        );
        for _ in 0..7 {
            values.push(SqlValue::Text(pattern.clone()));
        }
    }

    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };

    db.read(|conn| {
        let count_sql = format!("SELECT COUNT(*) FROM request_audits{where_sql}");
        let total: i64 = conn.query_row(&count_sql, params_from_iter(values.iter()), |r| r.get(0))?;

        let list_sql = format!(
            "SELECT id,kind,user_id,user_name,conversation_id,character_id,character_name,
                    supplier_id,supplier_name,model_id,protocol,model,endpoint,status,
                    http_status,duration_ms,input_tokens,output_tokens,error_code,error_message,
                    created_at,finished_at,request_id,attempt,request_truncated,response_truncated
             FROM request_audits{where_sql}
             ORDER BY created_at DESC, rowid DESC
             LIMIT ? OFFSET ?"
        );
        let mut page_params = values.clone();
        page_params.push(SqlValue::Integer(page_size));
        page_params.push(SqlValue::Integer(offset));
        let mut stmt = conn.prepare(&list_sql)?;
        let items = stmt
            .query_map(params_from_iter(page_params.iter()), row_to_audit)?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(RequestAuditList {
            items,
            total,
            page,
            page_size,
        })
    })
}

pub fn get_audit(db: &Db, id: &str) -> AppResult<Option<RequestAuditDetail>> {
    db.read(|conn| {
        conn.query_row(
            "SELECT id,kind,user_id,user_name,conversation_id,character_id,character_name,
                    supplier_id,supplier_name,model_id,protocol,model,endpoint,status,
                    http_status,duration_ms,input_tokens,output_tokens,error_code,error_message,
                    created_at,finished_at,request_id,attempt,request_truncated,response_truncated,
                    request_body,response_body
             FROM request_audits WHERE id=?",
            rusqlite::params![id],
            |row| {
                let meta = row_to_audit(row)?;
                Ok(RequestAuditDetail {
                    meta,
                    request_body: row.get("request_body")?,
                    response_body: row.get("response_body")?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
    })
}

pub fn get_audit_stats(db: &Db, hours: Option<i64>) -> AppResult<RequestAuditStats> {
    db.read(|conn| {
        let cutoff = hours
            .filter(|&h| h > 0)
            .map(|h| iso_from_utc(Utc::now() - Duration::hours(h)));
        let (sql, params): (&str, Vec<SqlValue>) = if let Some(c) = cutoff {
            (
                "SELECT
                    COUNT(*),
                    COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END),0),
                    COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0),
                    COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0),
                    COALESCE(CAST(ROUND(AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END)) AS INTEGER),0),
                    COALESCE(SUM(COALESCE(input_tokens,0)),0),
                    COALESCE(SUM(COALESCE(output_tokens,0)),0)
                 FROM request_audits WHERE created_at >= ?",
                vec![SqlValue::Text(c)],
            )
        } else {
            (
                "SELECT
                    COUNT(*),
                    COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END),0),
                    COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0),
                    COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0),
                    COALESCE(CAST(ROUND(AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END)) AS INTEGER),0),
                    COALESCE(SUM(COALESCE(input_tokens,0)),0),
                    COALESCE(SUM(COALESCE(output_tokens,0)),0)
                 FROM request_audits",
                Vec::new(),
            )
        };
        conn.query_row(sql, params_from_iter(params.iter()), |row| {
            Ok(RequestAuditStats {
                total: row.get(0)?,
                success: row.get(1)?,
                failed: row.get(2)?,
                pending: row.get(3)?,
                avg_duration_ms: row.get(4)?,
                input_tokens: row.get(5)?,
                output_tokens: row.get(6)?,
            })
        })
        .map_err(Into::into)
    })
}

pub fn clear_audits(db: &Db) -> AppResult<i64> {
    db.write(|tx| {
        let count = tx.execute("DELETE FROM request_audits", [])? as i64;
        Ok(count)
    })
}
