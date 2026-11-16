use std::collections::HashMap;

use chrono::{Duration, Utc};
use image::imageops::FilterType;
use rusqlite::{Connection, OptionalExtension, params_from_iter, types::Value as SqlValue};

use crate::avatars::{decode_and_normalize_image, encode_lossless_webp};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::models::{Attachment, User, iso_from_utc, new_id, now_iso};

pub const MAX_ATTACHMENT_UPLOAD_BYTES: usize = 10 * 1024 * 1024;
const MAX_ATTACHMENT_PIXELS: u64 = 40_000_000;
const MAX_ATTACHMENT_DIM: u32 = 16_384;
const TARGET_MAX_DIM: u32 = 1568;
const ORPHAN_TTL_HOURS: i64 = 2;
const MAX_ORPHAN_ATTACHMENTS: i64 = 32;

pub fn process_attachment_bytes(bytes: &[u8]) -> AppResult<(Vec<u8>, u32, u32)> {
    if bytes.is_empty() {
        return Err(AppError::validation("请选择要上传的图片。"));
    }
    if bytes.len() > MAX_ATTACHMENT_UPLOAD_BYTES {
        return Err(AppError::validation("单张图片大小不能超过 10 MB。"));
    }
    let img = decode_and_normalize_image(bytes, MAX_ATTACHMENT_PIXELS, MAX_ATTACHMENT_DIM)?;
    let normalized = if img.width() > TARGET_MAX_DIM || img.height() > TARGET_MAX_DIM {
        img.resize(TARGET_MAX_DIM, TARGET_MAX_DIM, FilterType::Lanczos3)
    } else {
        img
    };
    let width = normalized.width();
    let height = normalized.height();
    let webp = encode_lossless_webp(&normalized)?;
    Ok((webp, width, height))
}

pub async fn upload_attachment(
    db: &Db,
    user: &User,
    conversation_id: &str,
    raw_bytes: &[u8],
) -> AppResult<Attachment> {
    if conversation_id.trim().is_empty() {
        return Err(AppError::validation("会话 ID 不能为空。"));
    }
    // Check permissions before CPU-heavy image decoding
    db.read(|conn| {
        let owner: Option<String> = conn
            .query_row(
                "SELECT user_id FROM conversations WHERE id=?",
                rusqlite::params![conversation_id],
                |r| r.get(0),
            )
            .optional()?;
        if owner.as_deref() != Some(&user.id) {
            return Err(AppError::not_found("CONVERSATION_NOT_FOUND", "会话不存在。"));
        }
        let image_enabled: bool = conn
            .query_row(
                "SELECT value FROM settings WHERE key='imageInputEnabled'",
                [],
                |r| r.get::<_, String>(0),
            )
            .ok()
            .and_then(|v| serde_json::from_str::<bool>(&v).ok())
            .unwrap_or(true);
        if !image_enabled {
            return Err(AppError::forbidden(
                "IMAGE_INPUT_DISABLED",
                "平台暂未开放图片输入功能。",
            ));
        }
        Ok(())
    })?;

    let bytes = raw_bytes.to_vec();
    let (webp, width, height) =
        tokio::task::spawn_blocking(move || process_attachment_bytes(&bytes))
            .await
            .map_err(|_| AppError::internal())??;

    let size = webp.len() as i64;
    let id = new_id();
    let now = Utc::now();
    let now_str = iso_from_utc(now);
    let orphan_cutoff = iso_from_utc(now - Duration::hours(ORPHAN_TTL_HOURS));

    db.write(|tx| {
        let owner: Option<String> = tx
            .query_row(
                "SELECT user_id FROM conversations WHERE id=?",
                rusqlite::params![conversation_id],
                |r| r.get(0),
            )
            .optional()?;
        if owner.as_deref() != Some(&user.id) {
            return Err(AppError::not_found("CONVERSATION_NOT_FOUND", "会话不存在。"));
        }

        tx.execute(
            "DELETE FROM message_attachments WHERE message_id IS NULL AND created_at < ?",
            rusqlite::params![orphan_cutoff],
        )?;

        let orphan_count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM message_attachments WHERE user_id=? AND message_id IS NULL",
            rusqlite::params![user.id],
            |r| r.get(0),
        )?;
        if orphan_count >= MAX_ORPHAN_ATTACHMENTS {
            return Err(AppError::bad_request(
                "TOO_MANY_PENDING_ATTACHMENTS",
                "待发送图片数量过多，请先发送或移除部分图片。",
            ));
        }

        tx.execute(
            "INSERT INTO message_attachments(id,user_id,conversation_id,message_id,mime,width,height,size,data,position,created_at)
             VALUES(?,?,?,NULL,'image/webp',?,?,?,?,0,?)",
            rusqlite::params![
                id,
                user.id,
                conversation_id,
                i64::from(width),
                i64::from(height),
                size,
                webp,
                now_str
            ],
        )?;

        Ok(Attachment {
            id,
            mime: "image/webp".to_string(),
            width: i64::from(width),
            height: i64::from(height),
            size,
        })
    })
}

pub fn get_attachment_data(
    db: &Db,
    user: &User,
    attachment_id: &str,
) -> AppResult<(Attachment, Vec<u8>)> {
    db.read(|conn| {
        let row: Option<(String, Attachment, Vec<u8>)> = conn
            .query_row(
                "SELECT user_id, id, mime, width, height, size, data
                 FROM message_attachments WHERE id=?",
                rusqlite::params![attachment_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        Attachment {
                            id: r.get(1)?,
                            mime: r.get(2)?,
                            width: r.get(3)?,
                            height: r.get(4)?,
                            size: r.get(5)?,
                        },
                        r.get(6)?,
                    ))
                },
            )
            .optional()?;
        let Some((owner_id, att, data)) = row else {
            return Err(AppError::not_found("ATTACHMENT_NOT_FOUND", "附件不存在。"));
        };
        if owner_id != user.id && user.role != "admin" {
            return Err(AppError::not_found("ATTACHMENT_NOT_FOUND", "附件不存在。"));
        }
        Ok((att, data))
    })
}

pub fn load_message_attachments(
    conn: &Connection,
    message_ids: &[String],
) -> AppResult<HashMap<String, Vec<Attachment>>> {
    let mut map: HashMap<String, Vec<Attachment>> = HashMap::new();
    if message_ids.is_empty() {
        return Ok(map);
    }
    let placeholders = vec!["?"; message_ids.len()].join(",");
    let sql = format!(
        "SELECT message_id, id, mime, width, height, size
         FROM message_attachments
         WHERE message_id IN ({placeholders})
         ORDER BY position ASC, created_at ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params: Vec<SqlValue> = message_ids.iter().map(|s| SqlValue::Text(s.clone())).collect();
    let mut rows = stmt.query(params_from_iter(params.iter()))?;
    while let Some(row) = rows.next()? {
        let msg_id: String = row.get(0)?;
        let att = Attachment {
            id: row.get(1)?,
            mime: row.get(2)?,
            width: row.get(3)?,
            height: row.get(4)?,
            size: row.get(5)?,
        };
        map.entry(msg_id).or_default().push(att);
    }
    Ok(map)
}

pub fn load_attachments_with_blobs(
    conn: &Connection,
    attachment_ids: &[String],
) -> AppResult<HashMap<String, (Attachment, Vec<u8>)>> {
    let mut map = HashMap::new();
    if attachment_ids.is_empty() {
        return Ok(map);
    }
    let placeholders = vec!["?"; attachment_ids.len()].join(",");
    let sql = format!(
        "SELECT id, mime, width, height, size, data
         FROM message_attachments
         WHERE id IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params: Vec<SqlValue> = attachment_ids
        .iter()
        .map(|s| SqlValue::Text(s.clone()))
        .collect();
    let mut rows = stmt.query(params_from_iter(params.iter()))?;
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let att = Attachment {
            id: id.clone(),
            mime: row.get(1)?,
            width: row.get(2)?,
            height: row.get(3)?,
            size: row.get(4)?,
        };
        let data: Vec<u8> = row.get(5)?;
        map.insert(id, (att, data));
    }
    Ok(map)
}

pub fn bind_attachments_to_message(
    tx: &rusqlite::Transaction<'_>,
    user_id: &str,
    conversation_id: &str,
    message_id: &str,
    attachment_ids: &[String],
) -> AppResult<Vec<Attachment>> {
    if attachment_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut bound = Vec::with_capacity(attachment_ids.len());
    for (idx, att_id) in attachment_ids.iter().enumerate() {
        let row: Option<(String, String, Option<String>, Attachment)> = tx
            .query_row(
                "SELECT user_id, conversation_id, message_id, id, mime, width, height, size
                 FROM message_attachments WHERE id=?",
                rusqlite::params![att_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        Attachment {
                            id: r.get(3)?,
                            mime: r.get(4)?,
                            width: r.get(5)?,
                            height: r.get(6)?,
                            size: r.get(7)?,
                        },
                    ))
                },
            )
            .optional()?;

        let Some((owner_id, conv_id, existing_msg, att)) = row else {
            return Err(AppError::bad_request(
                "INVALID_ATTACHMENT",
                "包含不存在的图片附件，请重新上传。",
            ));
        };
        if owner_id != user_id || conv_id != conversation_id {
            return Err(AppError::forbidden(
                "INVALID_ATTACHMENT",
                "图片附件不属于当前会话。",
            ));
        }
        if let Some(bound_msg) = existing_msg {
            if bound_msg != message_id {
                return Err(AppError::bad_request(
                    "ATTACHMENT_ALREADY_USED",
                    "图片附件已被使用，请重新上传。",
                ));
            }
        } else {
            tx.execute(
                "UPDATE message_attachments SET message_id=?, position=? WHERE id=?",
                rusqlite::params![message_id, idx as i64, att_id],
            )?;
        }
        bound.push(att);
    }
    let _ = now_iso();
    Ok(bound)
}
