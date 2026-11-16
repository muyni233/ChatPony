use chrono::{Duration, Utc};
use reqwest::Client;
use rusqlite::{Connection, OptionalExtension};

use crate::ai::context::{ContextMessage, create_extractive_summary, truncate_utf8};
use crate::ai::memory::{
    STRUCTURED_MEMORY_PROMPT, maintain_memories, parse_structured_memories, upsert_auto_memory,
};
use crate::ai::protocols::{AuditContext, PromptMessage, ResolvedModel, complete_chat};
use crate::crypto::CryptoService;
use crate::db::Db;
use crate::error::AppResult;
use crate::models::{
    MemoryKind, ModelCapability, ModelKind, PlatformSettings, Protocol, ReasoningEffort,
    iso_from_utc, new_id, now_iso,
};
use crate::mappers::parse_string_list;

pub fn resolve_language_model_conn(
    conn: &Connection,
    crypto: &CryptoService,
    preferred_model_id: Option<&str>,
) -> AppResult<Option<ResolvedModel>> {
    let row_to_resolved = |r: &rusqlite::Row<'_>| -> rusqlite::Result<(ResolvedModel, String)> {
        let caps_raw: String = r.get("capabilities")?;
        let capabilities = parse_string_list(&caps_raw)
            .into_iter()
            .filter_map(|s| ModelCapability::from_str_opt(&s))
            .collect();
        let proto_str: String = r.get("supplier_protocol")?;
        let effort_str: Option<String> = r.get("reasoning_effort")?;
        let kind_str: String = r.get("kind")?;
        let enc_key: String = r.get("supplier_api_key")?;
        Ok((
            ResolvedModel {
                id: r.get("id")?,
                name: r.get("name")?,
                supplier_id: r.get("supplier_id")?,
                supplier_name: r.get::<_, Option<String>>("supplier_name")?.unwrap_or_default(),
                protocol: Protocol::from_db(&proto_str),
                base_url: r.get::<_, Option<String>>("supplier_base_url")?.unwrap_or_default(),
                model: r.get("model")?,
                api_key: String::new(),
                kind: ModelKind::from_db(&kind_str),
                capabilities,
                reasoning_effort: ReasoningEffort::from_db(effort_str.as_deref().unwrap_or("default")),
                thinking_budget: r.get("thinking_budget")?,
                context_window: r.get("context_window")?,
                max_output: r.get("max_output")?,
                temperature: r.get("temperature")?,
            },
            enc_key,
        ))
    };

    let base_select = "SELECT p.id, p.name, p.supplier_id, s.name AS supplier_name,
                              s.protocol AS supplier_protocol, s.base_url AS supplier_base_url,
                              s.api_key AS supplier_api_key, p.model, p.kind, p.capabilities,
                              p.reasoning_effort, p.thinking_budget, p.context_window,
                              p.max_output, p.temperature
                       FROM providers p
                       JOIN suppliers s ON s.id = p.supplier_id
                       WHERE p.deleted_at IS NULL AND p.active = 1
                         AND s.deleted_at IS NULL AND s.active = 1
                         AND p.kind = 'language'";

    let found: Option<(ResolvedModel, String)> = if let Some(mid) = preferred_model_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let exact = conn
            .query_row(
                &format!("{base_select} AND p.id=? LIMIT 1"),
                rusqlite::params![mid],
                row_to_resolved,
            )
            .optional()?;
        if exact.is_some() {
            exact
        } else {
            None
        }
    } else {
        None
    };

    let pair = match found {
        Some(p) => Some(p),
        None => conn
            .query_row(
                &format!("{base_select} ORDER BY p.created_at ASC LIMIT 1"),
                [],
                row_to_resolved,
            )
            .optional()?,
    };

    match pair {
        Some((mut model, enc_key)) => {
            model.api_key = if enc_key.is_empty() {
                String::new()
            } else {
                crypto.decrypt(&enc_key)?
            };
            Ok(Some(model))
        }
        None => Ok(None),
    }
}

pub async fn compress_conversation_if_needed(
    db: &Db,
    crypto: &CryptoService,
    http: &Client,
    user_id: &str,
    conversation_id: &str,
    settings: &PlatformSettings,
) -> AppResult<bool> {
    let trigger_msgs = (settings.compression_trigger_rounds.max(6) * 2) as usize;
    let keep_msgs = (settings.compression_keep_rounds.max(2) * 2) as usize;

    let loaded = db.read(|conn| {
        let row: Option<(String, i64)> = conn
            .query_row(
                "SELECT summary, summary_boundary FROM conversations WHERE id=? AND user_id=?",
                rusqlite::params![conversation_id, user_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((summary, boundary)) = row else {
            return Ok(None);
        };
        let mut stmt = conn.prepare(
            "SELECT m.id, m.role, m.character_id, c.name, m.content
             FROM messages m
             LEFT JOIN characters c ON c.id = m.character_id
             WHERE m.conversation_id=?
             ORDER BY m.created_at ASC, m.rowid ASC",
        )?;
        let msgs: Vec<ContextMessage> = stmt
            .query_map(rusqlite::params![conversation_id], |r| {
                Ok(ContextMessage {
                    id: r.get(0)?,
                    role: r.get(1)?,
                    character_id: r.get(2)?,
                    speaker_name: r.get(3)?,
                    content: r.get(4)?,
                    attachment_ids: Vec::new(),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let model_pref = if settings.compression_model_id.is_empty() {
            None
        } else {
            Some(settings.compression_model_id.as_str())
        };
        let model = resolve_language_model_conn(conn, crypto, model_pref)?;
        Ok(Some((summary, boundary.max(0) as usize, msgs, model)))
    })?;

    let Some((old_summary, boundary, msgs, model_opt)) = loaded else {
        return Ok(false);
    };

    let safe_boundary = boundary.min(msgs.len());
    let unsummarized = &msgs[safe_boundary..];
    if unsummarized.len() <= trigger_msgs || unsummarized.len() <= keep_msgs {
        return Ok(false);
    }

    let split_rel = unsummarized.len() - keep_msgs;
    let to_compress = &unsummarized[..split_rel];
    let next_boundary = (safe_boundary + split_rel) as i64;

    let mut next_summary = String::new();
    if let Some(ref model) = model_opt {
        let mut transcript = String::new();
        if !old_summary.trim().is_empty() {
            transcript.push_str("已有前情摘要：\n");
            transcript.push_str(old_summary.trim());
            transcript.push_str("\n\n");
        }
        transcript.push_str("新增对话内容：\n");
        for m in to_compress {
            let speaker = m
                .speaker_name
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or(if m.role == "user" { "用户" } else { "角色" });
            transcript.push_str(&format!("{speaker}: {}\n", truncate_utf8(&m.content, 600)));
        }

        let prompt_msgs = vec![PromptMessage {
            role: "user".to_string(),
            text: truncate_utf8(&transcript, 12_000),
            images: Vec::new(),
        }];
        let res = complete_chat(
            db,
            http,
            model,
            "你是剧情与对话整理助手。请将既有摘要与新增对话合并为简明连贯的第三人称中文前情提要（保留关键事实、承诺、情感变化与未完成事项），不超过 500 字。",
            &prompt_msgs,
            false,
            &AuditContext {
                kind: "compression".to_string(),
                user_id: Some(user_id.to_string()),
                user_name: None,
                conversation_id: Some(conversation_id.to_string()),
                character_id: None,
                character_name: None,
                request_id: None,
            },
            None,
        )
        .await;
        if let Ok(out) = res {
            let trimmed = out.text.trim();
            if !trimmed.is_empty() {
                next_summary = truncate_utf8(trimmed, 3000);
            }
        }
    }

    if next_summary.is_empty() {
        let extra = create_extractive_summary(to_compress, 1600);
        let merged = if old_summary.trim().is_empty() {
            extra
        } else {
            format!("{}\n{}", old_summary.trim(), extra)
        };
        next_summary = truncate_utf8(&merged, 3000);
    }

    let now = now_iso();
    db.write(|tx| {
        tx.execute(
            "UPDATE conversations SET summary=?, summary_boundary=?, updated_at=? WHERE id=? AND summary_boundary <= ?",
            rusqlite::params![next_summary, next_boundary, now, conversation_id, next_boundary],
        )?;
        Ok(())
    })?;
    Ok(true)
}

pub fn register_memory_reply(
    db: &Db,
    user_id: &str,
    character_id: &str,
    message_id: &str,
) -> AppResult<()> {
    let now = now_iso();
    db.write(|tx| {
        tx.execute(
            "INSERT OR IGNORE INTO memory_summary_events(message_id, user_id, character_id, created_at)
             VALUES(?,?,?,?)",
            rusqlite::params![message_id, user_id, character_id, now],
        )?;
        Ok(())
    })
}

pub async fn summarize_memories_detailed(
    db: &Db,
    crypto: &CryptoService,
    http: &Client,
    user_id: &str,
    character_id: &str,
    settings: &PlatformSettings,
    force: bool,
) -> AppResult<usize> {
    if !force && !settings.automatic_memory_enabled {
        return Ok(0);
    }

    let now = Utc::now();
    let now_str = iso_from_utc(now);
    let lock_token = new_id();
    let lock_expires = iso_from_utc(now + Duration::seconds(90));
    let interval = settings.memory_summary_interval.max(1);

    let claimed = db.write(|tx| {
        let state: Option<(i64, Option<String>, Option<String>, Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT last_event_seq, lock_token, lock_expires_at, retry_after, maintained_at
                 FROM memory_summary_state WHERE user_id=? AND character_id=?",
                rusqlite::params![user_id, character_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;

        let (last_seq, cur_lock, cur_lock_exp, retry_after, maintained_at) =
            state.unwrap_or((0, None, None, None, None));

        if cur_lock.is_some() && cur_lock_exp.as_deref().unwrap_or("") > now_str.as_str() {
            return Ok(None);
        }
        if !force && retry_after.as_deref().unwrap_or("") > now_str.as_str() {
            return Ok(None);
        }

        let (pending_count, max_seq): (i64, Option<i64>) = tx.query_row(
            "SELECT COUNT(*), MAX(seq) FROM memory_summary_events WHERE user_id=? AND character_id=? AND seq > ?",
            rusqlite::params![user_id, character_id, last_seq],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;

        let should_run = force || pending_count >= interval;
        if !should_run {
            let need_maint = maintained_at
                .as_deref()
                .map(|m| m < iso_from_utc(now - Duration::hours(1)).as_str())
                .unwrap_or(true);
            return Ok(Some((false, last_seq, last_seq, need_maint)));
        }

        let target_seq = max_seq.unwrap_or(last_seq);
        tx.execute(
            "INSERT INTO memory_summary_state(user_id,character_id,last_event_seq,pending_through_seq,lock_token,lock_expires_at,updated_at)
             VALUES(?,?,?,?,?,?,?)
             ON CONFLICT(user_id,character_id) DO UPDATE SET
               pending_through_seq=excluded.pending_through_seq,
               lock_token=excluded.lock_token,
               lock_expires_at=excluded.lock_expires_at,
               updated_at=excluded.updated_at",
            rusqlite::params![user_id, character_id, last_seq, target_seq, lock_token, lock_expires, now_str],
        )?;
        Ok(Some((true, last_seq, target_seq, true)))
    })?;

    let Some((run_extract, last_seq, target_seq, need_maint)) = claimed else {
        return Ok(0);
    };

    if !run_extract {
        if need_maint {
            let _ = maintain_memories(db, user_id, character_id, settings);
        }
        return Ok(0);
    }

    let (snippets, model_opt, char_name) = db.read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT m.conversation_id, m.created_at, m.content
             FROM memory_summary_events e
             JOIN messages m ON m.id = e.message_id
             WHERE e.user_id=? AND e.character_id=? AND e.seq > ? AND e.seq <= ?
             ORDER BY e.seq ASC LIMIT 24",
        )?;
        let reply_rows: Vec<(String, String, String)> = stmt
            .query_map(rusqlite::params![user_id, character_id, last_seq, target_seq], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        let mut lines = Vec::new();
        for (conv_id, created_at, reply_text) in &reply_rows {
            let prev_user: Option<String> = conn
                .query_row(
                    "SELECT content FROM messages
                     WHERE conversation_id=? AND role='user' AND created_at <= ?
                     ORDER BY created_at DESC, rowid DESC LIMIT 1",
                    rusqlite::params![conv_id, created_at],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(u) = prev_user {
                lines.push(format!("用户: {}", truncate_utf8(&u, 360)));
            }
            lines.push(format!("角色: {}", truncate_utf8(reply_text, 480)));
        }

        let char_name: Option<String> = conn
            .query_row(
                "SELECT name FROM characters WHERE id=?",
                rusqlite::params![character_id],
                |r| r.get(0),
            )
            .optional()?;

        let pref = if settings.memory_summary_model_id.is_empty() {
            None
        } else {
            Some(settings.memory_summary_model_id.as_str())
        };
        let model = resolve_language_model_conn(conn, crypto, pref)?;
        Ok((lines, model, char_name))
    })?;

    if snippets.is_empty() {
        let _ = db.write(|tx| {
            tx.execute(
                "UPDATE memory_summary_state SET lock_token=NULL, lock_expires_at=NULL, pending_through_seq=0, updated_at=?
                 WHERE user_id=? AND character_id=? AND lock_token=?",
                rusqlite::params![now_iso(), user_id, character_id, lock_token],
            )?;
            Ok(())
        });
        return Ok(0);
    }

    let mut saved_count = 0usize;
    let mut ai_failed = false;

    if let Some(ref model) = model_opt {
        let dialogue_text = truncate_utf8(&snippets.join("\n"), 12_000);
        let prompt = if settings.memory_structured_extraction {
            format!("对话片段：\n{dialogue_text}\n\n{STRUCTURED_MEMORY_PROMPT}")
        } else {
            format!(
                "请用一条简洁第三人称中文记忆概括上述对话的关键事实：\n{dialogue_text}"
            )
        };
        match complete_chat(
            db,
            http,
            model,
            "你是精准的长期记忆整理助手，只输出要求格式的事实信息，不添加主观寒暄。",
            &[PromptMessage {
                role: "user".to_string(),
                text: prompt,
                images: Vec::new(),
            }],
            false,
            &AuditContext {
                kind: "memory".to_string(),
                user_id: Some(user_id.to_string()),
                user_name: None,
                conversation_id: None,
                character_id: Some(character_id.to_string()),
                character_name: char_name,
                request_id: None,
            },
            None,
        )
        .await
        {
            Ok(out) => {
                if settings.memory_structured_extraction {
                    let parsed = parse_structured_memories(&out.text);
                    for item in parsed {
                        if let Ok(id) = upsert_auto_memory(db, user_id, character_id, &item, None) {
                            if !id.is_empty() {
                                saved_count += 1;
                            }
                        }
                    }
                } else {
                    let trimmed = out.text.trim();
                    if !trimmed.is_empty() {
                        let item = crate::ai::memory::StructuredMemoryItem {
                            kind: MemoryKind::Summary,
                            content: truncate_utf8(trimmed, 480),
                            importance: 0.6,
                            tags: Vec::new(),
                            ttl_days: None,
                        };
                        if let Ok(id) = upsert_auto_memory(db, user_id, character_id, &item, None) {
                            if !id.is_empty() {
                                saved_count += 1;
                            }
                        }
                    }
                }
            }
            Err(err) => {
                tracing::warn!("Memory extraction AI call failed: {:?}", err);
                ai_failed = true;
            }
        }
    }

    let retry_at = if ai_failed {
        Some(iso_from_utc(Utc::now() + Duration::seconds(60)))
    } else {
        None
    };

    let next_seq = if ai_failed { last_seq } else { target_seq };
    let finish_ts = now_iso();
    db.write(|tx| {
        tx.execute(
            "UPDATE memory_summary_state
             SET last_event_seq=?, pending_through_seq=0, lock_token=NULL, lock_expires_at=NULL,
                 retry_after=?, updated_at=?
             WHERE user_id=? AND character_id=? AND lock_token=?",
            rusqlite::params![
                next_seq,
                retry_at,
                finish_ts,
                user_id,
                character_id,
                lock_token
            ],
        )?;
        Ok(())
    })?;

    if !ai_failed {
        let _ = maintain_memories(db, user_id, character_id, settings);
    }

    Ok(saved_count)
}
