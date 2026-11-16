use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::response::sse::{Event, KeepAlive, Sse};
use chrono::{Duration as ChronoDuration, Utc};
use futures_util::stream::Stream;
use reqwest::Client;
use rusqlite::OptionalExtension;
use tokio::sync::mpsc;

use crate::ai::context::{ContextMessage, extract_explicit_memories, prepare_context};
use crate::ai::embeddings::test_embedding_model;
use crate::ai::group::GroupQueue;
use crate::ai::maintenance::{
    compress_conversation_if_needed, register_memory_reply, resolve_language_model_conn,
    summarize_memories_detailed,
};
use crate::ai::memory::{hybrid_recall, remember_explicit};
use crate::ai::metadata::build_metadata_block;
use crate::ai::persona::build_persona_block;
use crate::ai::protocols::{AuditContext, PromptImage, PromptMessage, complete_chat};
use crate::attachments::{bind_attachments_to_message, load_attachments_with_blobs, load_message_attachments};
use crate::crypto::CryptoService;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mappers::{row_to_character, row_to_conversation, row_to_message};
use crate::models::{
    Character, ChatEvent, Conversation, Message, ModelKind, PlatformSettings, User, iso_from_utc,
    new_id, now_iso,
};
use crate::quota::{finish_call, get_quota_conn, reserve_call};
use crate::repository::{read_settings, resolve_model_for_test};

const LOCK_LEASE_SECS: i64 = 180;
const IMAGE_TURNS: usize = 3;
const MAX_PROMPT_IMAGES: usize = 8;

#[derive(Debug, Clone)]
pub struct SendChatInput {
    pub content: String,
    pub request_id: String,
    pub attachment_ids: Vec<String>,
    pub retry_of: Option<String>,
}

struct LockGuard {
    db: Db,
    conversation_id: String,
    lock_token: String,
    released: bool,
}

impl LockGuard {
    fn release_now(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        let _ = self.db.write(|tx| {
            tx.execute(
                "UPDATE conversations SET lock_token=NULL, lock_expires_at=NULL WHERE id=? AND lock_token=?",
                rusqlite::params![self.conversation_id, self.lock_token],
            )?;
            Ok(())
        });
    }
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        self.release_now();
    }
}

fn emit_event(tx: &mpsc::UnboundedSender<ChatEvent>, ev: ChatEvent) {
    let _ = tx.send(ev);
}

fn load_conversation_messages_for_prompt(
    conn: &rusqlite::Connection,
    conv_id: &str,
) -> AppResult<Vec<ContextMessage>> {
    let mut stmt = conn.prepare(
        "SELECT m.id, m.role, m.character_id, c.name, m.content
         FROM messages m
         LEFT JOIN characters c ON c.id = m.character_id
         WHERE m.conversation_id=?
         ORDER BY m.created_at ASC, m.rowid ASC
         LIMIT 200",
    )?;
    let mut rows: Vec<ContextMessage> = stmt
        .query_map(rusqlite::params![conv_id], |r| {
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
    drop(stmt);

    let ids: Vec<String> = rows.iter().map(|m| m.id.clone()).collect();
    let mut att_map = load_message_attachments(conn, &ids)?;
    for row in &mut rows {
        if let Some(atts) = att_map.remove(&row.id) {
            row.attachment_ids = atts.into_iter().map(|a| a.id).collect();
        }
    }
    Ok(rows)
}

fn build_character_system_prompt(
    character: &Character,
    conv: &Conversation,
    all_members: &[Character],
    persona_block: &str,
    metadata_block: &str,
    memories_text: &str,
    context_summary: &str,
) -> String {
    let mut sections: Vec<String> = Vec::new();
    let personality = character.personality.as_deref().unwrap_or("").trim();
    sections.push(format!(
        "你将扮演角色「{}」。\n{}\n{}",
        character.name,
        if personality.is_empty() {
            &character.description
        } else {
            personality
        },
        if !personality.is_empty() && !character.description.trim().is_empty() {
            format!("角色简介：{}", character.description.trim())
        } else {
            String::new()
        }
    ));

    if conv.kind == "group" {
        let others: Vec<String> = all_members
            .iter()
            .filter(|m| m.id != character.id)
            .map(|m| format!("{} (@{})", m.name, m.slug))
            .collect();
        sections.push(format!(
            "当前为群聊场景，参与者除你和用户外还有：{}\n群聊规则：\n1. 只以「{}」自己的视角与口吻发言，严禁代写其他角色或用户的台词与动作。\n2. 回复开头不要加“{}：”前缀。\n3. 只有需要点名呼应某位群成员继续接话时，才可在正文中使用一次 `@角色名` 或 `@slug`。",
            others.join("、"),
            character.name,
            character.name
        ));
    }

    if !memories_text.is_empty() {
        sections.push(format!("关于用户与过往互动的长期记忆：\n{memories_text}"));
    }
    if !persona_block.is_empty() {
        sections.push(persona_block.to_string());
    }
    if !metadata_block.is_empty() {
        sections.push(metadata_block.to_string());
    }
    if !context_summary.trim().is_empty() {
        sections.push(format!("更早对话的剧情摘要：\n{}", context_summary.trim()));
    }

    sections.join("\n\n")
}

pub async fn start_chat_sse(
    db: Db,
    crypto: Arc<CryptoService>,
    http: Client,
    user: User,
    conv_id: String,
    input: SendChatInput,
) -> AppResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    let req_id = if input.request_id.trim().is_empty() {
        new_id()
    } else {
        input.request_id.trim().chars().take(80).collect()
    };

    // Check existing replay OR acquire lock + insert user message atomically
    enum StartOutcome {
        Replay {
            user_msg: Message,
            replies: Vec<Message>,
            rounds: i64,
            limited: bool,
        },
        Stream {
            conv: Conversation,
            members: Vec<Character>,
            settings: PlatformSettings,
            user_msg: Message,
            lock_token: String,
        },
    }

    let outcome = db.write(|tx| {
        let conv: Option<Conversation> = tx
            .query_row(
                "SELECT id,user_id,title,kind,character_ids,summary,max_rounds,created_at,updated_at
                 FROM conversations WHERE id=? AND user_id=?",
                rusqlite::params![conv_id, user.id],
                row_to_conversation,
            )
            .optional()?;
        let Some(conv) = conv else {
            return Err(AppError::not_found("CONVERSATION_NOT_FOUND", "会话不存在。"));
        };
        let settings = read_settings(tx)?;

        // Idempotent replay check
        let existing_req: Option<(String, String, String, i64, i64)> = tx
            .query_row(
                "SELECT status, user_message_id, response_ids, rounds, limited
                 FROM chat_requests WHERE conversation_id=? AND request_id=?",
                rusqlite::params![conv_id, req_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;

        if let Some((status, umsg_id, resp_ids_raw, rounds, limited)) = existing_req {
            if status == "complete" {
                let mut umsg = tx.query_row(
                    "SELECT id,conversation_id,role,character_id,content,created_at FROM messages WHERE id=?",
                    rusqlite::params![umsg_id],
                    row_to_message,
                )?;
                let mut att_map = load_message_attachments(tx, std::slice::from_ref(&umsg.id))?;
                umsg.attachments = att_map.remove(&umsg.id);

                let resp_ids: Vec<String> = serde_json::from_str(&resp_ids_raw).unwrap_or_default();
                let mut replies = Vec::new();
                for rid in resp_ids {
                    if let Some(m) = tx
                        .query_row(
                            "SELECT id,conversation_id,role,character_id,content,created_at FROM messages WHERE id=?",
                            rusqlite::params![rid],
                            row_to_message,
                        )
                        .optional()?
                    {
                        replies.push(m);
                    }
                }
                return Ok(StartOutcome::Replay {
                    user_msg: umsg,
                    replies,
                    rounds,
                    limited: limited != 0,
                });
            }
        }

        // Check conversation lock
        let lock_row: (Option<String>, Option<String>) = tx.query_row(
            "SELECT lock_token, lock_expires_at FROM conversations WHERE id=?",
            rusqlite::params![conv_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let now = Utc::now();
        let now_str = iso_from_utc(now);
        if lock_row.0.is_some() && lock_row.1.as_deref().unwrap_or("") > now_str.as_str() {
            return Err(AppError::conflict(
                "CONVERSATION_BUSY",
                "当前会话仍有回复正在生成，请等待完成。",
            ));
        }

        // Load characters (admin=true because prompt generation needs personality & provider_id!)
        let mut members = Vec::new();
        for cid in &conv.character_ids {
            if let Some(ch) = tx
                .query_row(
                    "SELECT id,owner_id,name,slug,description,avatar,color,tags,personality,greeting,provider_id,active,created_at
                     FROM characters
                     WHERE id=? AND deleted_at IS NULL AND (owner_id IS NULL OR owner_id=?)",
                    rusqlite::params![cid, user.id],
                    |r| row_to_character(r, true),
                )
                .optional()?
            {
                members.push(ch);
            }
        }
        if members.is_empty() {
            return Err(AppError::bad_request(
                "CHARACTER_UNAVAILABLE",
                "当前会话中的角色已被移除或不可用。",
            ));
        }

        // Determine user message (new or retry)
        let mut dedup_atts: Vec<String> = Vec::new();
        for id in &input.attachment_ids {
            let trimmed = id.trim().to_string();
            if !trimmed.is_empty() && !dedup_atts.contains(&trimmed) {
                dedup_atts.push(trimmed);
            }
        }
        if !dedup_atts.is_empty() {
            if !settings.image_input_enabled {
                return Err(AppError::forbidden(
                    "IMAGE_INPUT_DISABLED",
                    "平台暂未开放图片输入。",
                ));
            }
            if dedup_atts.len() as i64 > settings.max_images_per_message {
                return Err(AppError::validation(format!(
                    "单条消息最多附加 {} 张图片。",
                    settings.max_images_per_message
                )));
            }
        }

        let user_msg: Message = if let Some(ref retry_id) = input.retry_of {
            let target: Option<Message> = tx
                .query_row(
                    "SELECT id,conversation_id,role,character_id,content,created_at FROM messages WHERE id=? AND conversation_id=?",
                    rusqlite::params![retry_id, conv_id],
                    row_to_message,
                )
                .optional()?;
            let Some(found) = target else {
                return Err(AppError::not_found("MESSAGE_NOT_FOUND", "重发目标消息不存在。"));
            };
            if found.role == "assistant" {
                let target_ts = found.created_at.clone();
                let target_rowid: i64 = tx.query_row(
                    "SELECT rowid FROM messages WHERE id=?",
                    rusqlite::params![found.id],
                    |r| r.get(0),
                )?;
                let prior_user: Option<Message> = tx
                    .query_row(
                        "SELECT id,conversation_id,role,character_id,content,created_at
                         FROM messages
                         WHERE conversation_id=? AND role='user' AND (created_at < ? OR (created_at = ? AND rowid < ?))
                         ORDER BY created_at DESC, rowid DESC LIMIT 1",
                        rusqlite::params![conv_id, target_ts, target_ts, target_rowid],
                        row_to_message,
                    )
                    .optional()?;
                tx.execute("DELETE FROM messages WHERE id=?", rusqlite::params![found.id])?;
                let mut u = prior_user.ok_or_else(|| {
                    AppError::bad_request("RETRY_UNSUPPORTED", "找不到对应的用户提问，无法重新生成。")
                })?;
                let mut amap = load_message_attachments(tx, std::slice::from_ref(&u.id))?;
                u.attachments = amap.remove(&u.id);
                u
            } else if found.role == "user" {
                let mut u = found;
                let mut amap = load_message_attachments(tx, std::slice::from_ref(&u.id))?;
                u.attachments = amap.remove(&u.id);
                u
            } else {
                return Err(AppError::bad_request("RETRY_UNSUPPORTED", "不支持重试该类型消息。"));
            }
        } else {
            let trimmed = input.content.trim().to_string();
            if trimmed.is_empty() && dedup_atts.is_empty() {
                return Err(AppError::validation("请输入消息内容或附加图片。"));
            }
            if trimmed.chars().count() > 12_000 {
                return Err(AppError::validation("单条消息内容不能超过 12000 个字符。"));
            }

            let msg_id = new_id();
            tx.execute(
                "INSERT INTO messages(id,conversation_id,role,character_id,content,request_id,created_at)
                 VALUES(?,?,'user',NULL,?,?,?)",
                rusqlite::params![msg_id, conv_id, trimmed, req_id, now_str],
            )?;
            let bound = bind_attachments_to_message(tx, &user.id, &conv_id, &msg_id, &dedup_atts)?;
            Message {
                id: msg_id,
                conversation_id: conv_id.clone(),
                role: "user".to_string(),
                character_id: None,
                content: trimmed,
                created_at: now_str.clone(),
                attachments: if bound.is_empty() { None } else { Some(bound) },
            }
        };

        // Acquire lease lock + upsert pending chat_requests row
        let lock_token = new_id();
        let lock_expires = iso_from_utc(now + ChronoDuration::seconds(LOCK_LEASE_SECS));
        tx.execute(
            "UPDATE conversations SET lock_token=?, lock_expires_at=?, updated_at=? WHERE id=?",
            rusqlite::params![lock_token, lock_expires, now_str, conv_id],
        )?;
        tx.execute(
            "INSERT INTO chat_requests(conversation_id,request_id,user_message_id,status,response_ids,rounds,limited,created_at,updated_at)
             VALUES(?,?,?,'pending','[]',0,0,?,?)
             ON CONFLICT(conversation_id,request_id) DO UPDATE SET
               user_message_id=excluded.user_message_id, status='pending', error_code=NULL, error_message=NULL, updated_at=excluded.updated_at",
            rusqlite::params![conv_id, req_id, user_msg.id, now_str, now_str],
        )?;

        Ok(StartOutcome::Stream {
            conv,
            members,
            settings,
            user_msg,
            lock_token,
        })
    })?;

    let (ev_tx, ev_rx) = mpsc::unbounded_channel::<ChatEvent>();

    match outcome {
        StartOutcome::Replay {
            user_msg,
            replies,
            rounds,
            limited,
        } => {
            let quota = db.read(|conn| get_quota_conn(conn, &user.id))?;
            emit_event(&ev_tx, ChatEvent::User { message: user_msg });
            for m in replies {
                emit_event(
                    &ev_tx,
                    ChatEvent::Message {
                        message: m,
                        stream_id: None,
                    },
                );
            }
            emit_event(
                &ev_tx,
                ChatEvent::Done {
                    quota,
                    rounds,
                    limited,
                },
            );
            drop(ev_tx);
        }
        StartOutcome::Stream {
            conv,
            members,
            settings,
            user_msg,
            lock_token,
        } => {
            let task_db = db.clone();
            let task_crypto = crypto.clone();
            let task_http = http.clone();
            let task_user = user.clone();
            let task_req_id = req_id.clone();

            tokio::spawn(async move {
                let mut lock_guard = LockGuard {
                    db: task_db.clone(),
                    conversation_id: conv.id.clone(),
                    lock_token: lock_token.clone(),
                    released: false,
                };

                emit_event(
                    &ev_tx,
                    ChatEvent::User {
                        message: user_msg.clone(),
                    },
                );

                // Save explicit remember intents immediately
                let explicit = extract_explicit_memories(&user_msg.content);
                if !explicit.is_empty() {
                    let target_cid = &members[0].id;
                    for (content, kind) in explicit {
                        let _ = remember_explicit(
                            &task_db,
                            &task_user.id,
                            target_cid,
                            &content,
                            kind,
                            Some(&user_msg.id),
                        );
                    }
                }

                // Background lease renewal task while generation runs
                let lease_db = task_db.clone();
                let lease_conv = conv.id.clone();
                let lease_tok = lock_token.clone();
                let lease_handle = tokio::spawn(async move {
                    let mut interval = tokio::time::interval(Duration::from_secs(45));
                    loop {
                        interval.tick().await;
                        let exp = iso_from_utc(Utc::now() + ChronoDuration::seconds(LOCK_LEASE_SECS));
                        let updated = lease_db
                            .write(|tx| {
                                let n = tx.execute(
                                    "UPDATE conversations SET lock_expires_at=? WHERE id=? AND lock_token=?",
                                    rusqlite::params![exp, lease_conv, lease_tok],
                                )?;
                                Ok(n)
                            })
                            .unwrap_or(0);
                        if updated == 0 {
                            break;
                        }
                    }
                });

                let max_rounds = if conv.kind == "group" {
                    conv.max_rounds.min(settings.max_group_rounds).clamp(1, 12)
                } else {
                    1
                };
                let mut queue = GroupQueue::new(&user_msg.content, &members, max_rounds);
                let mut member_map: HashMap<String, Character> =
                    members.iter().cloned().map(|c| (c.id.clone(), c)).collect();
                let mut response_ids: Vec<String> = Vec::new();
                let mut rounds_done: i64 = 0;
                let mut limited = false;
                let mut fatal_err: Option<(String, String)> = None;
                let mut replied_char_ids: HashSet<String> = HashSet::new();

                let persona_block = build_persona_block(task_user.persona.as_ref());
                let metadata_block = build_metadata_block(&settings, &task_user.timezone);

                while let Some(char_id) = queue.pop_next() {
                    let Some(ch) = member_map.get(&char_id).cloned() else {
                        continue;
                    };

                    // Reserve quota per model invocation
                    let call_id = match reserve_call(
                        &task_db,
                        &task_user.id,
                        Some(&conv.id),
                        Some(&ch.id),
                    ) {
                        Ok(id) => id,
                        Err(err) => {
                            if rounds_done == 0 {
                                fatal_err = Some((err.code, err.message));
                            } else {
                                limited = true;
                            }
                            break;
                        }
                    };

                    let model_opt = task_db
                        .read(|conn| {
                            resolve_language_model_conn(
                                conn,
                                &task_crypto,
                                ch.provider_id.as_deref(),
                            )
                        })
                        .ok()
                        .flatten();

                    let Some(model) = model_opt else {
                        finish_call(&task_db, &call_id, false);
                        let msg = format!(
                            "角色「{}」尚未配置可用的语言模型，请管理员在后台启用供应商与模型。",
                            ch.name
                        );
                        if rounds_done == 0 {
                            fatal_err = Some(("MODEL_NOT_CONFIGURED".to_string(), msg));
                        } else {
                            emit_event(
                                &ev_tx,
                                ChatEvent::Status {
                                    text: msg,
                                    character_id: Some(ch.id.clone()),
                                },
                            );
                        }
                        break;
                    };

                    emit_event(
                        &ev_tx,
                        ChatEvent::Status {
                            text: format!("{} 正在翻看记忆...", ch.name),
                            character_id: Some(ch.id.clone()),
                        },
                    );

                    // Recall LivingMemory
                    let recalled = hybrid_recall(
                        &task_db,
                        &task_crypto,
                        &task_http,
                        &task_user.id,
                        &ch.id,
                        &user_msg.content,
                        &settings,
                        true,
                    )
                    .await
                    .unwrap_or_default();

                    let memories_text = recalled
                        .iter()
                        .map(|m| format!("- [{}] {}", m.kind.label_zh(), m.content))
                        .collect::<Vec<_>>()
                        .join("\n");

                    let history = task_db
                        .read(|conn| load_conversation_messages_for_prompt(conn, &conv.id))
                        .unwrap_or_default();

                    let temp_sys = build_character_system_prompt(
                        &ch,
                        &conv,
                        &members,
                        &persona_block,
                        &metadata_block,
                        &memories_text,
                        &conv.summary,
                    );
                    let sys_tokens = crate::ai::context::estimate_tokens(&temp_sys);
                    let prepared = prepare_context(
                        &history,
                        &conv.summary,
                        model.context_window,
                        model.max_output,
                        sys_tokens,
                    );
                    let system_prompt = build_character_system_prompt(
                        &ch,
                        &conv,
                        &members,
                        &persona_block,
                        &metadata_block,
                        &memories_text,
                        &prepared.summary,
                    );

                    // Load images for last IMAGE_TURNS user messages when vision supported
                    let can_vision = settings.image_input_enabled && model.supports_images();
                    let mut att_ids_to_load: Vec<String> = Vec::new();
                    if can_vision {
                        let start_img_idx = prepared.messages.len().saturating_sub(IMAGE_TURNS * 2);
                        for m in prepared.messages.iter().skip(start_img_idx).rev() {
                            if m.role == "user" {
                                for aid in &m.attachment_ids {
                                    if att_ids_to_load.len() < MAX_PROMPT_IMAGES {
                                        att_ids_to_load.push(aid.clone());
                                    }
                                }
                            }
                        }
                    }
                    let blobs = if att_ids_to_load.is_empty() {
                        HashMap::new()
                    } else {
                        task_db
                            .read(|conn| load_attachments_with_blobs(conn, &att_ids_to_load))
                            .unwrap_or_default()
                    };

                    let mut prompt_messages: Vec<PromptMessage> =
                        Vec::with_capacity(prepared.messages.len());
                    for m in &prepared.messages {
                        let role = if m.role == "user" {
                            "user".to_string()
                        } else if m.character_id.as_deref() == Some(&ch.id) {
                            "assistant".to_string()
                        } else {
                            // Other group chat participants rendered as user turn with speaker prefix
                            "user".to_string()
                        };

                        let text = if role == "user" && m.role == "assistant" {
                            let speaker = m.speaker_name.as_deref().unwrap_or("其他角色");
                            format!("[{speaker}]: {}", m.content)
                        } else if !can_vision && !m.attachment_ids.is_empty() {
                            if m.content.is_empty() {
                                "[用户发送了一张图片，当前模型暂不支持图像识别]".to_string()
                            } else {
                                format!("{}\n[附带 {} 张图片]", m.content, m.attachment_ids.len())
                            }
                        } else {
                            m.content.clone()
                        };

                        let mut imgs = Vec::new();
                        if can_vision && m.role == "user" {
                            for aid in &m.attachment_ids {
                                if let Some((att, data)) = blobs.get(aid) {
                                    imgs.push(PromptImage::from_bytes(&att.mime, data));
                                }
                            }
                        }

                        // Merge consecutive messages with identical role when needed cleanly
                        if let Some(last) = prompt_messages.last_mut() {
                            if last.role == role && imgs.is_empty() && last.images.is_empty() {
                                last.text.push('\n');
                                last.text.push_str(&text);
                                continue;
                            }
                        }
                        prompt_messages.push(PromptMessage {
                            role,
                            text,
                            images: imgs,
                        });
                    }

                    // Ensure conversation ends with a user turn for Anthropic/Gemini compatibility
                    if prompt_messages.is_empty() {
                        prompt_messages.push(PromptMessage {
                            role: "user".to_string(),
                            text: user_msg.content.clone(),
                            images: Vec::new(),
                        });
                    }

                    emit_event(
                        &ev_tx,
                        ChatEvent::Status {
                            text: format!("{} 正在输入...", ch.name),
                            character_id: Some(ch.id.clone()),
                        },
                    );

                    let stream_mode = settings.streaming_enabled;
                    let stream_id = new_id();
                    let mut fwd_handle = None;
                    let delta_sender = if stream_mode {
                        emit_event(
                            &ev_tx,
                            ChatEvent::StreamStart {
                                stream_id: stream_id.clone(),
                                character_id: ch.id.clone(),
                            },
                        );
                        let (dtx, mut drx) = mpsc::unbounded_channel::<String>();
                        let out_tx = ev_tx.clone();
                        let sid = stream_id.clone();
                        fwd_handle = Some(tokio::spawn(async move {
                            while let Some(chunk) = drx.recv().await {
                                emit_event(
                                    &out_tx,
                                    ChatEvent::Delta {
                                        stream_id: sid.clone(),
                                        text: chunk,
                                    },
                                );
                            }
                        }));
                        Some(dtx)
                    } else {
                        None
                    };

                    let ai_res = complete_chat(
                        &task_db,
                        &task_http,
                        &model,
                        &system_prompt,
                        &prompt_messages,
                        stream_mode,
                        &AuditContext {
                            kind: "chat".to_string(),
                            user_id: Some(task_user.id.clone()),
                            user_name: Some(task_user.name.clone()),
                            conversation_id: Some(conv.id.clone()),
                            character_id: Some(ch.id.clone()),
                            character_name: Some(ch.name.clone()),
                            request_id: Some(task_req_id.clone()),
                        },
                        delta_sender,
                    )
                    .await;

                    if let Some(h) = fwd_handle {
                        let _ = h.await;
                    }
                    if stream_mode {
                        emit_event(
                            &ev_tx,
                            ChatEvent::StreamEnd {
                                stream_id: stream_id.clone(),
                            },
                        );
                    }

                    let output = match ai_res {
                        Ok(out) => out,
                        Err(err) => {
                            finish_call(&task_db, &call_id, false);
                            if rounds_done == 0 {
                                fatal_err = Some((err.code, err.message));
                            } else {
                                emit_event(
                                    &ev_tx,
                                    ChatEvent::Error {
                                        code: err.code,
                                        message: err.message,
                                    },
                                );
                            }
                            break;
                        }
                    };

                    let reply_text = output.text.trim().to_string();
                    if reply_text.is_empty() {
                        finish_call(&task_db, &call_id, false);
                        if rounds_done == 0 {
                            fatal_err = Some((
                                "EMPTY_RESPONSE".to_string(),
                                format!("{} 返回了空回复，请重试。", ch.name),
                            ));
                        }
                        break;
                    }

                    finish_call(&task_db, &call_id, true);
                    let msg_id = new_id();
                    let created_at = now_iso();
                    let saved = task_db.write(|tx| {
                        tx.execute(
                            "INSERT INTO messages(id,conversation_id,role,character_id,content,created_at)
                             VALUES(?,?,'assistant',?,?,?)",
                            rusqlite::params![msg_id, conv.id, ch.id, reply_text, created_at],
                        )?;
                        tx.execute(
                            "UPDATE conversations SET updated_at=? WHERE id=?",
                            rusqlite::params![created_at, conv.id],
                        )?;
                        Ok(Message {
                            id: msg_id.clone(),
                            conversation_id: conv.id.clone(),
                            role: "assistant".to_string(),
                            character_id: Some(ch.id.clone()),
                            content: reply_text.clone(),
                            created_at: created_at.clone(),
                            attachments: None,
                        })
                    });

                    match saved {
                        Ok(msg) => {
                            response_ids.push(msg.id.clone());
                            rounds_done += 1;
                            replied_char_ids.insert(ch.id.clone());
                            let _ = register_memory_reply(&task_db, &task_user.id, &ch.id, &msg.id);
                            emit_event(
                                &ev_tx,
                                ChatEvent::Message {
                                    message: msg,
                                    stream_id: if stream_mode { Some(stream_id) } else { None },
                                },
                            );
                            if conv.kind == "group" {
                                queue.enqueue_mentions_from_reply(&reply_text, &ch.id, &members);
                                if queue.is_limited() {
                                    limited = true;
                                }
                            }
                        }
                        Err(err) => {
                            if rounds_done == 0 {
                                fatal_err = Some((err.code, err.message));
                            }
                            break;
                        }
                    }

                    let _ = &mut member_map;
                }

                lease_handle.abort();

                // Update chat_requests final state
                let final_status = if fatal_err.is_some() {
                    "failed"
                } else {
                    "complete"
                };
                let resp_json = serde_json::to_string(&response_ids).unwrap_or_else(|_| "[]".into());
                let (ecode, emsg) = fatal_err
                    .as_ref()
                    .map(|(c, m)| (Some(c.as_str()), Some(m.as_str())))
                    .unwrap_or((None, None));
                let _ = task_db.write(|tx| {
                    tx.execute(
                        "UPDATE chat_requests
                         SET status=?, response_ids=?, error_code=?, error_message=?, rounds=?, limited=?, updated_at=?
                         WHERE conversation_id=? AND request_id=?",
                        rusqlite::params![
                            final_status,
                            resp_json,
                            ecode,
                            emsg,
                            rounds_done,
                            if limited { 1 } else { 0 },
                            now_iso(),
                            conv.id,
                            task_req_id
                        ],
                    )?;
                    Ok(())
                });

                lock_guard.release_now();

                if let Some((code, message)) = fatal_err {
                    emit_event(&ev_tx, ChatEvent::Error { code, message });
                } else {
                    let quota = task_db
                        .read(|conn| get_quota_conn(conn, &task_user.id))
                        .unwrap_or_else(|_| crate::models::QuotaSnapshot {
                            five_hour: crate::models::QuotaWindow {
                                used: 0,
                                limit: 0,
                                remaining: 0,
                                resets_at: None,
                            },
                            seven_day: crate::models::QuotaWindow {
                                used: 0,
                                limit: 0,
                                remaining: 0,
                                resets_at: None,
                            },
                        });
                    emit_event(
                        &ev_tx,
                        ChatEvent::Done {
                            quota,
                            rounds: rounds_done,
                            limited,
                        },
                    );
                }

                drop(ev_tx);

                // Background context compression + LivingMemory extraction
                if !replied_char_ids.is_empty() {
                    let _ = compress_conversation_if_needed(
                        &task_db,
                        &task_crypto,
                        &task_http,
                        &task_user.id,
                        &conv.id,
                        &settings,
                    )
                    .await;
                    for cid in replied_char_ids {
                        let _ = summarize_memories_detailed(
                            &task_db,
                            &task_crypto,
                            &task_http,
                            &task_user.id,
                            &cid,
                            &settings,
                            false,
                        )
                        .await;
                    }
                }
            });
        }
    }

    let sse_stream = async_stream_from_rx(ev_rx);
    Ok(Sse::new(sse_stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("heartbeat"),
    ))
}

fn async_stream_from_rx(
    rx: mpsc::UnboundedReceiver<ChatEvent>,
) -> impl Stream<Item = Result<Event, Infallible>> {
    futures_util::stream::unfold(Some(rx), |maybe_rx| async move {
        let mut rx = maybe_rx?;
        match rx.recv().await {
            Some(ev) => {
                let data = serde_json::to_string(&ev).unwrap_or_else(|_| "{}".into());
                Some((Ok(Event::default().data(data)), Some(rx)))
            }
            None => None,
        }
    })
}

pub async fn test_provider_model(
    db: &Db,
    crypto: &CryptoService,
    http: &Client,
    model_id: &str,
) -> AppResult<serde_json::Value> {
    let model = db.read(|conn| resolve_model_for_test(conn, crypto, model_id))?;
    if model.kind == ModelKind::Embedding {
        return test_embedding_model(db, crypto, http, model_id).await;
    }

    let started = Instant::now();
    let out = complete_chat(
        db,
        http,
        &model,
        "You are verifying API connectivity. Reply briefly.",
        &[PromptMessage {
            role: "user".to_string(),
            text: "Reply with OK.".to_string(),
            images: Vec::new(),
        }],
        false,
        &AuditContext {
            kind: "test".to_string(),
            user_id: None,
            user_name: None,
            conversation_id: None,
            character_id: None,
            character_name: None,
            request_id: None,
        },
        None,
    )
    .await?;

    Ok(serde_json::json!({
        "ok": !out.text.trim().is_empty(),
        "reply": out.text.trim().chars().take(160).collect::<String>(),
        "durationMs": started.elapsed().as_millis() as i64,
        "model": model.model,
        "protocol": model.protocol.as_str(),
    }))
}
