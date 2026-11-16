use std::collections::HashMap;

use chrono_tz::Tz;
use rusqlite::{Connection, OptionalExtension, params_from_iter, types::Value as SqlValue};
use serde::Deserialize;
use serde_json::Value;

use crate::ai::maintenance::resolve_language_model_conn;
use crate::ai::protocols::{ResolvedModel, validate_provider_url};
use crate::attachments::load_message_attachments;
use crate::auth::{
    extract_cookie, hash_password, hash_token, normalize_timezone, revoke_user_sessions_tx,
    validate_name, validate_password, verify_password, SESSION_COOKIE_NAME,
};
use crate::avatars::{delete_avatar_by_url, save_avatar_file};
use crate::config::Config;
use crate::crypto::CryptoService;
use crate::db::Db;
use crate::email_policy::{normalize_email, normalize_email_domains};
use crate::error::{AppError, AppResult};
use crate::mappers::{
    parse_string_list, row_to_announcement, row_to_character, row_to_conversation, row_to_memory,
    row_to_message, row_to_provider, row_to_supplier, row_to_user,
};
use crate::models::{
    AdminOverview, Announcement, Bootstrap, Character, Conversation, ConversationCharacter,
    ConversationDetail, Memory, MemoryKind, ModelCapability, ModelKind, PlatformSettings,
    PlatformStats, Protocol, ProviderConfig, ReasoningEffort, SupplierConfig, User, UserPersona,
    new_id, now_iso,
};
use crate::quota::get_quota_conn;
use crate::user_characters::{
    normalize_hex_color, normalize_tags, validate_slug_or_generate,
};

// ---------------- Settings ----------------

fn load_settings_map(conn: &Connection) -> AppResult<HashMap<String, Value>> {
    let mut map = HashMap::new();
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let mut rows = stmt.query([])?;
    while let Some(r) = rows.next()? {
        let key: String = r.get(0)?;
        let raw: String = r.get(1)?;
        if let Ok(val) = serde_json::from_str::<Value>(&raw) {
            map.insert(key, val);
        }
    }
    Ok(map)
}

fn s_bool(map: &HashMap<String, Value>, key: &str, default: bool) -> bool {
    map.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

fn s_i64(map: &HashMap<String, Value>, key: &str, default: i64) -> i64 {
    map.get(key).and_then(|v| v.as_i64()).unwrap_or(default)
}

fn s_f64(map: &HashMap<String, Value>, key: &str, default: f64) -> f64 {
    map.get(key).and_then(|v| v.as_f64()).unwrap_or(default)
}

fn s_str(map: &HashMap<String, Value>, key: &str, default: &str) -> String {
    map.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or(default)
        .to_string()
}

fn s_list(map: &HashMap<String, Value>, key: &str, default: &[&str]) -> Vec<String> {
    map.get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(ToString::to_string))
                .collect()
        })
        .unwrap_or_else(|| default.iter().map(|s| (*s).to_string()).collect())
}

pub fn read_settings(conn: &Connection) -> AppResult<PlatformSettings> {
    let map = load_settings_map(conn)?;
    let default_meta = [
        "date",
        "time",
        "weekday",
        "timezone",
        "lunarDate",
        "solarTermToday",
        "solarTermSeason",
        "festivals",
    ];
    let default_markers = ["*", "（）", "()"];

    Ok(PlatformSettings {
        registration_open: s_bool(&map, "registrationOpen", true),
        default_limit5h: s_i64(&map, "defaultLimit5h", 50).max(0),
        default_limit7d: s_i64(&map, "defaultLimit7d", 500).max(0),
        default_character_slots: s_i64(&map, "defaultCharacterSlots", 3).clamp(0, 100),
        max_group_rounds: s_i64(&map, "maxGroupRounds", 6).clamp(1, 12),
        site_description: s_str(&map, "siteDescription", "Warm hand-journal AI roleplay studio."),
        bubble_delimiter: s_str(&map, "bubbleDelimiter", ""),
        hidden_symbols: s_list(&map, "hiddenSymbols", &[]),
        require_email_verification: s_bool(&map, "requireEmailVerification", false),
        email_domain_mode: {
            let m = s_str(&map, "emailDomainMode", "any");
            if matches!(m.as_str(), "any" | "allowlist" | "blocklist") {
                m
            } else {
                "any".to_string()
            }
        },
        email_domains: s_list(&map, "emailDomains", &[]),
        audit_capture_content: s_bool(&map, "auditCaptureContent", false),
        audit_retention_days: s_i64(&map, "auditRetentionDays", 7).clamp(1, 365),
        compression_trigger_rounds: s_i64(&map, "compressionTriggerRounds", 24).clamp(6, 200),
        compression_keep_rounds: s_i64(&map, "compressionKeepRounds", 8).clamp(2, 100),
        compression_model_id: s_str(&map, "compressionModelId", ""),
        memory_summary_interval: s_i64(&map, "memorySummaryInterval", 8).clamp(1, 100),
        memory_summary_model_id: s_str(&map, "memorySummaryModelId", ""),
        automatic_memory_enabled: s_bool(&map, "automaticMemoryEnabled", true),
        metadata_enabled: s_bool(&map, "metadataEnabled", true),
        metadata_fields: s_list(&map, "metadataFields", &default_meta),
        metadata_timezone: s_str(&map, "metadataTimezone", ""),
        metadata_custom: s_str(&map, "metadataCustom", ""),
        streaming_enabled: s_bool(&map, "streamingEnabled", true),
        image_input_enabled: s_bool(&map, "imageInputEnabled", true),
        max_images_per_message: s_i64(&map, "maxImagesPerMessage", 4).clamp(1, 10),
        action_style_enabled: s_bool(&map, "actionStyleEnabled", true),
        action_markers: s_list(&map, "actionMarkers", &default_markers),
        action_hide_markers: s_bool(&map, "actionHideMarkers", false),
        memory_structured_extraction: s_bool(&map, "memoryStructuredExtraction", true),
        memory_recall_top_k: s_i64(&map, "memoryRecallTopK", 6).clamp(1, 20),
        memory_keyword_weight: s_f64(&map, "memoryKeywordWeight", 0.45).clamp(0.0, 1.0),
        memory_decay_rate: s_f64(&map, "memoryDecayRate", 0.08).clamp(0.0, 0.5),
        memory_archive_threshold: s_f64(&map, "memoryArchiveThreshold", 0.25).clamp(0.0, 1.0),
    })
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub registration_open: Option<bool>,
    pub default_limit5h: Option<i64>,
    pub default_limit7d: Option<i64>,
    pub default_character_slots: Option<i64>,
    pub max_group_rounds: Option<i64>,
    pub site_description: Option<String>,
    pub bubble_delimiter: Option<String>,
    pub hidden_symbols: Option<Vec<String>>,
    pub require_email_verification: Option<bool>,
    pub email_domain_mode: Option<String>,
    pub email_domains: Option<Vec<String>>,
    pub audit_capture_content: Option<bool>,
    pub audit_retention_days: Option<i64>,
    pub compression_trigger_rounds: Option<i64>,
    pub compression_keep_rounds: Option<i64>,
    pub compression_model_id: Option<String>,
    pub memory_summary_interval: Option<i64>,
    pub memory_summary_model_id: Option<String>,
    pub automatic_memory_enabled: Option<bool>,
    pub metadata_enabled: Option<bool>,
    pub metadata_fields: Option<Vec<String>>,
    pub metadata_timezone: Option<String>,
    pub metadata_custom: Option<String>,
    pub streaming_enabled: Option<bool>,
    pub image_input_enabled: Option<bool>,
    pub max_images_per_message: Option<i64>,
    pub action_style_enabled: Option<bool>,
    pub action_markers: Option<Vec<String>>,
    pub action_hide_markers: Option<bool>,
    pub memory_structured_extraction: Option<bool>,
    pub memory_recall_top_k: Option<i64>,
    pub memory_keyword_weight: Option<f64>,
    pub memory_decay_rate: Option<f64>,
    pub memory_archive_threshold: Option<f64>,
}

fn save_setting_tx(tx: &rusqlite::Transaction<'_>, key: &str, value: Value) -> AppResult<()> {
    let raw = serde_json::to_string(&value).map_err(|_| AppError::internal())?;
    tx.execute(
        "INSERT INTO settings(key,value) VALUES(?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![key, raw],
    )?;
    Ok(())
}

pub fn update_settings(db: &Db, patch: SettingsPatch) -> AppResult<PlatformSettings> {
    db.write(|tx| {
        let prev = read_settings(tx)?;
        let mut next = prev.clone();

        if let Some(v) = patch.registration_open {
            next.registration_open = v;
        }
        if let Some(v) = patch.default_limit5h {
            if !(0..=100_000).contains(&v) {
                return Err(AppError::validation("默认 5 小时额度需在 0 至 100000 之间。"));
            }
            next.default_limit5h = v;
        }
        if let Some(v) = patch.default_limit7d {
            if !(0..=1_000_000).contains(&v) {
                return Err(AppError::validation("默认 7 天额度需在 0 至 1000000 之间。"));
            }
            next.default_limit7d = v;
        }
        if let Some(v) = patch.default_character_slots {
            if !(0..=100).contains(&v) {
                return Err(AppError::validation("默认私有角色栏位需在 0 至 100 之间。"));
            }
            next.default_character_slots = v;
        }
        if let Some(v) = patch.max_group_rounds {
            next.max_group_rounds = v.clamp(1, 12);
        }
        if let Some(v) = patch.site_description {
            next.site_description = v.trim().chars().take(400).collect();
        }
        if let Some(v) = patch.bubble_delimiter {
            next.bubble_delimiter = v.chars().take(16).collect();
        }
        if let Some(v) = patch.hidden_symbols {
            next.hidden_symbols = v
                .into_iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty() && s.len() <= 24)
                .take(30)
                .collect();
        }
        if let Some(v) = patch.require_email_verification {
            next.require_email_verification = v;
        }
        if let Some(m) = patch.email_domain_mode {
            if !matches!(m.as_str(), "any" | "allowlist" | "blocklist") {
                return Err(AppError::validation("邮箱域名过滤模式无效。"));
            }
            next.email_domain_mode = m;
        }
        if let Some(domains) = patch.email_domains {
            next.email_domains = normalize_email_domains(&domains)?;
        }
        if let Some(v) = patch.audit_capture_content {
            next.audit_capture_content = v;
        }
        if let Some(v) = patch.audit_retention_days {
            next.audit_retention_days = v.clamp(1, 365);
        }
        if let Some(v) = patch.compression_trigger_rounds {
            next.compression_trigger_rounds = v.clamp(6, 200);
        }
        if let Some(v) = patch.compression_keep_rounds {
            next.compression_keep_rounds = v.clamp(2, 100);
        }
        if next.compression_keep_rounds >= next.compression_trigger_rounds {
            return Err(AppError::validation("保留轮数必须小于触发摘要压缩的轮数。"));
        }
        if let Some(v) = patch.compression_model_id {
            let trimmed = v.trim().to_string();
            if !trimmed.is_empty() {
                let exists: Option<i64> = tx
                    .query_row(
                        "SELECT 1 FROM providers WHERE id=? AND deleted_at IS NULL AND kind='language'",
                        rusqlite::params![trimmed],
                        |r| r.get(0),
                    )
                    .optional()?;
                if exists.is_none() {
                    return Err(AppError::validation("指定的摘要压缩模型不存在。"));
                }
            }
            next.compression_model_id = trimmed;
        }
        if let Some(v) = patch.memory_summary_interval {
            next.memory_summary_interval = v.clamp(1, 100);
        }
        if let Some(v) = patch.memory_summary_model_id {
            let trimmed = v.trim().to_string();
            if !trimmed.is_empty() {
                let exists: Option<i64> = tx
                    .query_row(
                        "SELECT 1 FROM providers WHERE id=? AND deleted_at IS NULL AND kind='language'",
                        rusqlite::params![trimmed],
                        |r| r.get(0),
                    )
                    .optional()?;
                if exists.is_none() {
                    return Err(AppError::validation("指定的记忆整理模型不存在。"));
                }
            }
            next.memory_summary_model_id = trimmed;
        }
        if let Some(v) = patch.automatic_memory_enabled {
            next.automatic_memory_enabled = v;
        }
        if let Some(v) = patch.metadata_enabled {
            next.metadata_enabled = v;
        }
        if let Some(v) = patch.metadata_fields {
            next.metadata_fields = v
                .into_iter()
                .filter(|f| {
                    matches!(
                        f.as_str(),
                        "date"
                            | "time"
                            | "weekday"
                            | "timezone"
                            | "lunarDate"
                            | "solarTermToday"
                            | "solarTermSeason"
                            | "festivals"
                    )
                })
                .collect();
        }
        if let Some(v) = patch.metadata_timezone {
            let trimmed = v.trim().to_string();
            if !trimmed.is_empty() && trimmed.parse::<Tz>().is_err() {
                return Err(AppError::validation("环境元数据默认时区无效。"));
            }
            next.metadata_timezone = trimmed;
        }
        if let Some(v) = patch.metadata_custom {
            next.metadata_custom = v.trim().chars().take(500).collect();
        }
        if let Some(v) = patch.streaming_enabled {
            next.streaming_enabled = v;
        }
        if let Some(v) = patch.image_input_enabled {
            next.image_input_enabled = v;
        }
        if let Some(v) = patch.max_images_per_message {
            next.max_images_per_message = v.clamp(1, 10);
        }
        if let Some(v) = patch.action_style_enabled {
            next.action_style_enabled = v;
        }
        if let Some(v) = patch.action_markers {
            next.action_markers = v
                .into_iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty() && s.len() <= 16)
                .take(12)
                .collect();
        }
        if let Some(v) = patch.action_hide_markers {
            next.action_hide_markers = v;
        }
        if let Some(v) = patch.memory_structured_extraction {
            next.memory_structured_extraction = v;
        }
        if let Some(v) = patch.memory_recall_top_k {
            next.memory_recall_top_k = v.clamp(1, 20);
        }
        if let Some(v) = patch.memory_keyword_weight {
            next.memory_keyword_weight = v.clamp(0.0, 1.0);
        }
        if let Some(v) = patch.memory_decay_rate {
            next.memory_decay_rate = v.clamp(0.0, 0.5);
        }
        if let Some(v) = patch.memory_archive_threshold {
            next.memory_archive_threshold = v.clamp(0.0, 1.0);
        }

        // Persist all keys in camelCase
        save_setting_tx(tx, "registrationOpen", Value::Bool(next.registration_open))?;
        save_setting_tx(tx, "defaultLimit5h", Value::from(next.default_limit5h))?;
        save_setting_tx(tx, "defaultLimit7d", Value::from(next.default_limit7d))?;
        save_setting_tx(tx, "defaultCharacterSlots", Value::from(next.default_character_slots))?;
        save_setting_tx(tx, "maxGroupRounds", Value::from(next.max_group_rounds))?;
        save_setting_tx(tx, "siteDescription", Value::String(next.site_description.clone()))?;
        save_setting_tx(tx, "bubbleDelimiter", Value::String(next.bubble_delimiter.clone()))?;
        save_setting_tx(tx, "hiddenSymbols", serde_json::to_value(&next.hidden_symbols).unwrap())?;
        save_setting_tx(tx, "requireEmailVerification", Value::Bool(next.require_email_verification))?;
        save_setting_tx(tx, "emailDomainMode", Value::String(next.email_domain_mode.clone()))?;
        save_setting_tx(tx, "emailDomains", serde_json::to_value(&next.email_domains).unwrap())?;
        save_setting_tx(tx, "auditCaptureContent", Value::Bool(next.audit_capture_content))?;
        save_setting_tx(tx, "auditRetentionDays", Value::from(next.audit_retention_days))?;
        save_setting_tx(tx, "compressionTriggerRounds", Value::from(next.compression_trigger_rounds))?;
        save_setting_tx(tx, "compressionKeepRounds", Value::from(next.compression_keep_rounds))?;
        save_setting_tx(tx, "compressionModelId", Value::String(next.compression_model_id.clone()))?;
        save_setting_tx(tx, "memorySummaryInterval", Value::from(next.memory_summary_interval))?;
        save_setting_tx(tx, "memorySummaryModelId", Value::String(next.memory_summary_model_id.clone()))?;
        save_setting_tx(tx, "automaticMemoryEnabled", Value::Bool(next.automatic_memory_enabled))?;
        save_setting_tx(tx, "metadataEnabled", Value::Bool(next.metadata_enabled))?;
        save_setting_tx(tx, "metadataFields", serde_json::to_value(&next.metadata_fields).unwrap())?;
        save_setting_tx(tx, "metadataTimezone", Value::String(next.metadata_timezone.clone()))?;
        save_setting_tx(tx, "metadataCustom", Value::String(next.metadata_custom.clone()))?;
        save_setting_tx(tx, "streamingEnabled", Value::Bool(next.streaming_enabled))?;
        save_setting_tx(tx, "imageInputEnabled", Value::Bool(next.image_input_enabled))?;
        save_setting_tx(tx, "maxImagesPerMessage", Value::from(next.max_images_per_message))?;
        save_setting_tx(tx, "actionStyleEnabled", Value::Bool(next.action_style_enabled))?;
        save_setting_tx(tx, "actionMarkers", serde_json::to_value(&next.action_markers).unwrap())?;
        save_setting_tx(tx, "actionHideMarkers", Value::Bool(next.action_hide_markers))?;
        save_setting_tx(tx, "memoryStructuredExtraction", Value::Bool(next.memory_structured_extraction))?;
        save_setting_tx(tx, "memoryRecallTopK", Value::from(next.memory_recall_top_k))?;
        save_setting_tx(tx, "memoryKeywordWeight", Value::from(next.memory_keyword_weight))?;
        save_setting_tx(tx, "memoryDecayRate", Value::from(next.memory_decay_rate))?;
        save_setting_tx(tx, "memoryArchiveThreshold", Value::from(next.memory_archive_threshold))?;

        // Sync global defaults onto users still using previous defaults
        if next.default_limit5h != prev.default_limit5h {
            tx.execute(
                "UPDATE users SET limit_5h=? WHERE limit_5h=?",
                rusqlite::params![next.default_limit5h, prev.default_limit5h],
            )?;
        }
        if next.default_limit7d != prev.default_limit7d {
            tx.execute(
                "UPDATE users SET limit_7d=? WHERE limit_7d=?",
                rusqlite::params![next.default_limit7d, prev.default_limit7d],
            )?;
        }
        if next.default_character_slots != prev.default_character_slots {
            tx.execute(
                "UPDATE users SET character_slots=? WHERE character_slots=?",
                rusqlite::params![next.default_character_slots, prev.default_character_slots],
            )?;
        }

        read_settings(tx)
    })
}

// ---------------- Bootstrap ----------------

pub fn list_announcements_conn(conn: &Connection, include_unpublished: bool) -> AppResult<Vec<Announcement>> {
    let sql = if include_unpublished {
        "SELECT id,title,content,pinned,published,created_at,updated_at
         FROM announcements ORDER BY pinned DESC, created_at DESC"
    } else {
        "SELECT id,title,content,pinned,published,created_at,updated_at
         FROM announcements WHERE published=1 ORDER BY pinned DESC, created_at DESC"
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt
        .query_map([], row_to_announcement)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn list_visible_characters(conn: &Connection, viewer: Option<&User>) -> AppResult<Vec<Character>> {
    match viewer {
        Some(u) => {
            let mut stmt = conn.prepare(
                "SELECT id,owner_id,name,slug,description,avatar,color,tags,personality,greeting,provider_id,active,created_at
                 FROM characters
                 WHERE deleted_at IS NULL AND active=1 AND (owner_id IS NULL OR owner_id=?)
                 ORDER BY CASE WHEN owner_id IS NULL THEN 0 ELSE 1 END, created_at ASC",
            )?;
            let items = stmt
                .query_map(rusqlite::params![u.id], |r| {
                    let owner_id: Option<String> = r.get("owner_id")?;
                    let show_secret = owner_id.as_deref() == Some(&u.id) || u.role == "admin";
                    row_to_character(r, show_secret)
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(items)
        }
        None => {
            let mut stmt = conn.prepare(
                "SELECT id,owner_id,name,slug,description,avatar,color,tags,personality,greeting,provider_id,active,created_at
                 FROM characters
                 WHERE deleted_at IS NULL AND active=1 AND owner_id IS NULL
                 ORDER BY created_at ASC",
            )?;
            let items = stmt
                .query_map([], |r| row_to_character(r, false))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(items)
        }
    }
}

pub fn list_user_conversations(conn: &Connection, user_id: &str) -> AppResult<Vec<Conversation>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.user_id, c.title, c.kind, c.character_ids, c.summary, c.max_rounds,
                c.created_at, c.updated_at,
                (SELECT content FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_message
         FROM conversations c
         WHERE c.user_id=?
         ORDER BY c.updated_at DESC",
    )?;
    let items = stmt
        .query_map(rusqlite::params![user_id], row_to_conversation)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(items)
}

pub fn get_bootstrap(db: &Db, viewer: Option<User>) -> AppResult<Bootstrap> {
    db.read(|conn| {
        let settings = read_settings(conn)?;
        let characters = list_visible_characters(conn, viewer.as_ref())?;
        let announcements = list_announcements_conn(conn, false)?;

        let (conversations, quota, stats) = if let Some(ref u) = viewer {
            let convs = list_user_conversations(conn, &u.id)?;
            let q = get_quota_conn(conn, &u.id)?;
            let msg_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.user_id=?",
                rusqlite::params![u.id],
                |r| r.get(0),
            )?;
            let mem_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM memories WHERE user_id=? AND status='active'",
                rusqlite::params![u.id],
                |r| r.get(0),
            )?;
            (
                convs,
                Some(q),
                PlatformStats {
                    conversations: 0, // overwritten cleanly below
                    messages: msg_count,
                    memories: mem_count,
                },
            )
        } else {
            (
                Vec::new(),
                None,
                PlatformStats {
                    conversations: 0,
                    messages: 0,
                    memories: 0,
                },
            )
        };
        let stats = PlatformStats {
            conversations: conversations.len() as i64,
            messages: stats.messages,
            memories: stats.memories,
        };

        Ok(Bootstrap {
            user: viewer,
            characters,
            conversations,
            announcements,
            quota,
            settings,
            stats,
        })
    })
}

// ---------------- Account ----------------

pub fn update_account_profile(
    db: &Db,
    user: &User,
    name_opt: Option<&str>,
    tz_opt: Option<&str>,
) -> AppResult<User> {
    let next_name = match name_opt {
        Some(n) => validate_name(n)?,
        None => user.name.clone(),
    };
    let next_tz = match tz_opt {
        Some(t) => normalize_timezone(Some(t)),
        None => user.timezone.clone(),
    };
    db.write(|tx| {
        tx.execute(
            "UPDATE users SET name=?, timezone=? WHERE id=?",
            rusqlite::params![next_name, next_tz, user.id],
        )?;
        tx.query_row(
            "SELECT id,email,name,role,disabled,timezone,created_at,email_verified_at,avatar,persona,limit_5h,limit_7d,character_slots
             FROM users WHERE id=?",
            rusqlite::params![user.id],
            row_to_user,
        )
        .map_err(Into::into)
    })
}

pub async fn change_user_password(
    db: &Db,
    headers: &axum::http::HeaderMap,
    user: &User,
    current_password: &str,
    new_password: &str,
) -> AppResult<()> {
    validate_password(new_password)?;
    let stored_hash: String = db.read(|conn| {
        conn.query_row(
            "SELECT password_hash FROM users WHERE id=?",
            rusqlite::params![user.id],
            |r| r.get(0),
        )
        .map_err(Into::into)
    })?;

    let cur_pw = current_password.to_string();
    let new_pw = new_password.to_string();
    let (matches, new_hash) = tokio::task::spawn_blocking(move || -> AppResult<(bool, String)> {
        let ok = verify_password(&cur_pw, &stored_hash);
        if !ok {
            return Ok((false, String::new()));
        }
        let hashed = hash_password(&new_pw)?;
        Ok((true, hashed))
    })
    .await
    .map_err(|_| AppError::internal())??;

    if !matches {
        return Err(AppError::unauthorized("当前密码不正确。"));
    }

    let keep_hash = extract_cookie(headers, SESSION_COOKIE_NAME).map(|t| hash_token(&t));
    db.write(|tx| {
        tx.execute(
            "UPDATE users SET password_hash=? WHERE id=?",
            rusqlite::params![new_hash, user.id],
        )?;
        revoke_user_sessions_tx(tx, &user.id, keep_hash.as_deref())?;
        Ok(())
    })
}

pub fn update_user_persona(db: &Db, user: &User, persona: UserPersona) -> AppResult<User> {
    let clean = UserPersona {
        enabled: persona.enabled,
        name: persona.name.trim().chars().take(60).collect(),
        species: persona.species.trim().chars().take(60).collect(),
        pronouns: persona.pronouns.trim().chars().take(40).collect(),
        appearance: persona.appearance.trim().chars().take(800).collect(),
        personality: persona.personality.trim().chars().take(1000).collect(),
        background: persona.background.trim().chars().take(1500).collect(),
    };
    let json = serde_json::to_string(&clean).map_err(|_| AppError::internal())?;
    db.write(|tx| {
        tx.execute(
            "UPDATE users SET persona=? WHERE id=?",
            rusqlite::params![json, user.id],
        )?;
        tx.query_row(
            "SELECT id,email,name,role,disabled,timezone,created_at,email_verified_at,avatar,persona,limit_5h,limit_7d,character_slots
             FROM users WHERE id=?",
            rusqlite::params![user.id],
            row_to_user,
        )
        .map_err(Into::into)
    })
}

pub fn set_user_avatar(db: &Db, config: &Config, user: &User, bytes: &[u8]) -> AppResult<User> {
    let prev = user.avatar.clone();
    let new_url = save_avatar_file(config, bytes)?;
    let res = db.write(|tx| {
        tx.execute(
            "UPDATE users SET avatar=? WHERE id=?",
            rusqlite::params![new_url, user.id],
        )?;
        tx.query_row(
            "SELECT id,email,name,role,disabled,timezone,created_at,email_verified_at,avatar,persona,limit_5h,limit_7d,character_slots
             FROM users WHERE id=?",
            rusqlite::params![user.id],
            row_to_user,
        )
        .map_err(Into::into)
    });
    match res {
        Ok(u) => {
            if !prev.is_empty() && prev != new_url {
                delete_avatar_by_url(config, &prev);
            }
            Ok(u)
        }
        Err(err) => {
            delete_avatar_by_url(config, &new_url);
            Err(err)
        }
    }
}

pub fn clear_user_avatar(db: &Db, config: &Config, user: &User) -> AppResult<User> {
    let (u, prev) = db.write(|tx| {
        let old: String = tx.query_row(
            "SELECT avatar FROM users WHERE id=?",
            rusqlite::params![user.id],
            |r| r.get(0),
        )?;
        tx.execute(
            "UPDATE users SET avatar='' WHERE id=?",
            rusqlite::params![user.id],
        )?;
        let u = tx.query_row(
            "SELECT id,email,name,role,disabled,timezone,created_at,email_verified_at,avatar,persona,limit_5h,limit_7d,character_slots
             FROM users WHERE id=?",
            rusqlite::params![user.id],
            row_to_user,
        )?;
        Ok((u, old))
    })?;
    if !prev.is_empty() {
        delete_avatar_by_url(config, &prev);
    }
    Ok(u)
}

// ---------------- Conversations & Messages ----------------

pub fn create_conversation(
    db: &Db,
    user: &User,
    character_ids: Vec<String>,
    title_opt: Option<String>,
    max_rounds_opt: Option<i64>,
) -> AppResult<Conversation> {
    if character_ids.is_empty() || character_ids.len() > 8 {
        return Err(AppError::validation("请选择 1 至 8 个角色发起对话。"));
    }
    let mut unique_ids = Vec::new();
    for id in character_ids {
        let trimmed = id.trim().to_string();
        if !trimmed.is_empty() && !unique_ids.contains(&trimmed) {
            unique_ids.push(trimmed);
        }
    }
    if unique_ids.is_empty() {
        return Err(AppError::validation("角色列表不能为空。"));
    }

    db.write(|tx| {
        let settings = read_settings(tx)?;
        let mut chars: Vec<Character> = Vec::with_capacity(unique_ids.len());
        for cid in &unique_ids {
            let ch: Option<Character> = tx
                .query_row(
                    "SELECT id,owner_id,name,slug,description,avatar,color,tags,personality,greeting,provider_id,active,created_at
                     FROM characters
                     WHERE id=? AND deleted_at IS NULL AND active=1 AND (owner_id IS NULL OR owner_id=?)",
                    rusqlite::params![cid, user.id],
                    |r| row_to_character(r, false),
                )
                .optional()?;
            let Some(c) = ch else {
                return Err(AppError::not_found(
                    "CHARACTER_NOT_FOUND",
                    "所选角色不存在或已停用。",
                ));
            };
            chars.push(c);
        }

        let kind = if chars.len() > 1 { "group" } else { "private" };
        let default_title = if chars.len() == 1 {
            chars[0].name.clone()
        } else {
            chars
                .iter()
                .take(3)
                .map(|c| c.name.as_str())
                .collect::<Vec<_>>()
                .join(" · ")
        };
        let title = title_opt
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(80).collect::<String>())
            .unwrap_or(default_title);

        let max_rounds = max_rounds_opt
            .unwrap_or(4)
            .clamp(1, settings.max_group_rounds.clamp(1, 12));
        let conv_id = new_id();
        let now = now_iso();
        let ids_json = serde_json::to_string(&unique_ids).unwrap_or_else(|_| "[]".into());

        tx.execute(
            "INSERT INTO conversations(id,user_id,title,kind,character_ids,summary,summary_boundary,max_rounds,created_at,updated_at)
             VALUES(?,?,?,?,?,'',0,?,?,?)",
            rusqlite::params![conv_id, user.id, title, kind, ids_json, max_rounds, now, now],
        )?;

        if kind == "private" {
            let greeting = chars[0].greeting.trim();
            if !greeting.is_empty() {
                let msg_id = new_id();
                tx.execute(
                    "INSERT INTO messages(id,conversation_id,role,character_id,content,created_at)
                     VALUES(?,?,'assistant',?,?,?)",
                    rusqlite::params![msg_id, conv_id, chars[0].id, greeting, now],
                )?;
            }
        }

        tx.query_row(
            "SELECT c.id,c.user_id,c.title,c.kind,c.character_ids,c.summary,c.max_rounds,c.created_at,c.updated_at,
                    (SELECT content FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_message
             FROM conversations c WHERE c.id=?",
            rusqlite::params![conv_id],
            row_to_conversation,
        )
        .map_err(Into::into)
    })
}

pub fn get_conversation_detail(
    db: &Db,
    crypto: &CryptoService,
    user: &User,
    conv_id: &str,
    limit_opt: Option<i64>,
    before_opt: Option<&str>,
) -> AppResult<ConversationDetail> {
    db.read(|conn| {
        let conv: Option<Conversation> = conn
            .query_row(
                "SELECT c.id,c.user_id,c.title,c.kind,c.character_ids,c.summary,c.max_rounds,c.created_at,c.updated_at,
                        (SELECT content FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_message
                 FROM conversations c WHERE c.id=? AND c.user_id=?",
                rusqlite::params![conv_id, user.id],
                row_to_conversation,
            )
            .optional()?;
        let Some(conversation) = conv else {
            return Err(AppError::not_found("CONVERSATION_NOT_FOUND", "会话不存在。"));
        };

        let settings = read_settings(conn)?;
        let mut characters: Vec<ConversationCharacter> = Vec::new();
        for cid in &conversation.character_ids {
            let ch_opt: Option<Character> = conn
                .query_row(
                    "SELECT id,owner_id,name,slug,description,avatar,color,tags,personality,greeting,provider_id,active,created_at
                     FROM characters
                     WHERE id=? AND (owner_id IS NULL OR owner_id=?)",
                    rusqlite::params![cid, user.id],
                    |r| {
                        let owner: Option<String> = r.get("owner_id")?;
                        let show = owner.as_deref() == Some(&user.id) || user.role == "admin";
                        row_to_character(r, show)
                    },
                )
                .optional()?;
            if let Some(ch) = ch_opt {
                let raw_pid: Option<String> = conn
                    .query_row(
                        "SELECT provider_id FROM characters WHERE id=?",
                        rusqlite::params![ch.id],
                        |r| r.get(0),
                    )
                    .optional()?
                    .flatten();
                let model_supports_img = resolve_language_model_conn(conn, crypto, raw_pid.as_deref())?
                    .map(|m| m.supports_images())
                    .unwrap_or(false);
                characters.push(ConversationCharacter {
                    character: ch,
                    image_input: Some(settings.image_input_enabled && model_supports_img),
                });
            }
        }

        let limit = limit_opt.unwrap_or(60).clamp(1, 200);
        let anchor: Option<(String, i64)> = if let Some(before_id) = before_opt.map(str::trim).filter(|s| !s.is_empty()) {
            conn.query_row(
                "SELECT created_at, rowid FROM messages WHERE id=? AND conversation_id=?",
                rusqlite::params![before_id, conv_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
        } else {
            None
        };

        let mut raw_msgs: Vec<crate::models::Message> = if let Some((ts, rid)) = anchor {
            let mut stmt = conn.prepare(
                "SELECT id,conversation_id,role,character_id,content,created_at
                 FROM messages
                 WHERE conversation_id=? AND (created_at < ? OR (created_at = ? AND rowid < ?))
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT ?",
            )?;
            let rows = stmt
                .query_map(rusqlite::params![conv_id, ts, ts, rid, limit + 1], row_to_message)?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        } else {
            let mut stmt = conn.prepare(
                "SELECT id,conversation_id,role,character_id,content,created_at
                 FROM messages
                 WHERE conversation_id=?
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT ?",
            )?;
            let rows = stmt
                .query_map(rusqlite::params![conv_id, limit + 1], row_to_message)?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        let has_more = raw_msgs.len() as i64 > limit;
        if has_more {
            raw_msgs.truncate(limit as usize);
        }
        raw_msgs.reverse();

        let msg_ids: Vec<String> = raw_msgs.iter().map(|m| m.id.clone()).collect();
        let mut att_map = load_message_attachments(conn, &msg_ids)?;
        for m in &mut raw_msgs {
            if let Some(atts) = att_map.remove(&m.id) {
                if !atts.is_empty() {
                    m.attachments = Some(atts);
                }
            }
        }

        Ok(ConversationDetail {
            conversation,
            characters,
            messages: raw_msgs,
            has_more: Some(has_more),
        })
    })
}

pub fn update_conversation(
    db: &Db,
    user: &User,
    conv_id: &str,
    title: Option<String>,
    max_rounds: Option<i64>,
    summary: Option<String>,
) -> AppResult<Conversation> {
    db.write(|tx| {
        let existing: Option<Conversation> = tx
            .query_row(
                "SELECT id,user_id,title,kind,character_ids,summary,max_rounds,created_at,updated_at
                 FROM conversations WHERE id=? AND user_id=?",
                rusqlite::params![conv_id, user.id],
                row_to_conversation,
            )
            .optional()?;
        let Some(cur) = existing else {
            return Err(AppError::not_found("CONVERSATION_NOT_FOUND", "会话不存在。"));
        };
        let settings = read_settings(tx)?;
        let next_title = title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(80).collect::<String>())
            .unwrap_or(cur.title);
        let next_rounds = max_rounds
            .unwrap_or(cur.max_rounds)
            .clamp(1, settings.max_group_rounds.clamp(1, 12));
        let next_summary = summary
            .map(|s| s.trim().chars().take(4000).collect::<String>())
            .unwrap_or(cur.summary);
        let now = now_iso();

        tx.execute(
            "UPDATE conversations SET title=?, max_rounds=?, summary=?, updated_at=? WHERE id=? AND user_id=?",
            rusqlite::params![next_title, next_rounds, next_summary, now, conv_id, user.id],
        )?;
        tx.query_row(
            "SELECT c.id,c.user_id,c.title,c.kind,c.character_ids,c.summary,c.max_rounds,c.created_at,c.updated_at,
                    (SELECT content FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_message
             FROM conversations c WHERE c.id=?",
            rusqlite::params![conv_id],
            row_to_conversation,
        )
        .map_err(Into::into)
    })
}

pub fn delete_conversation(db: &Db, user: &User, conv_id: &str) -> AppResult<()> {
    db.write(|tx| {
        let deleted = tx.execute(
            "DELETE FROM conversations WHERE id=? AND user_id=?",
            rusqlite::params![conv_id, user.id],
        )?;
        if deleted == 0 {
            return Err(AppError::not_found("CONVERSATION_NOT_FOUND", "会话不存在。"));
        }
        Ok(())
    })
}

pub fn clear_conversation_messages(db: &Db, user: &User, conv_id: &str) -> AppResult<()> {
    db.write(|tx| {
        let exists: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM conversations WHERE id=? AND user_id=?",
                rusqlite::params![conv_id, user.id],
                |r| r.get(0),
            )
            .optional()?;
        if exists.is_none() {
            return Err(AppError::not_found("CONVERSATION_NOT_FOUND", "会话不存在。"));
        }
        tx.execute(
            "DELETE FROM messages WHERE conversation_id=?",
            rusqlite::params![conv_id],
        )?;
        tx.execute(
            "DELETE FROM chat_requests WHERE conversation_id=?",
            rusqlite::params![conv_id],
        )?;
        tx.execute(
            "UPDATE conversations SET summary='', summary_boundary=0, updated_at=? WHERE id=?",
            rusqlite::params![now_iso(), conv_id],
        )?;
        Ok(())
    })
}

// ---------------- Memories ----------------

pub fn list_memories(
    db: &Db,
    user: &User,
    character_id: Option<&str>,
    status: Option<&str>,
    kind: Option<&str>,
    search: Option<&str>,
) -> AppResult<Vec<Memory>> {
    db.read(|conn| {
        let mut clauses = vec!["m.user_id = ?".to_string()];
        let mut params: Vec<SqlValue> = vec![SqlValue::Text(user.id.clone())];

        if let Some(cid) = character_id.map(str::trim).filter(|s| !s.is_empty() && *s != "all") {
            clauses.push("m.character_id = ?".to_string());
            params.push(SqlValue::Text(cid.to_string()));
        }
        if let Some(st) = status.map(str::trim).filter(|s| !s.is_empty() && *s != "all") {
            clauses.push("m.status = ?".to_string());
            params.push(SqlValue::Text(st.to_string()));
        }
        if let Some(k) = kind.map(str::trim).filter(|s| !s.is_empty() && *s != "all") {
            clauses.push("m.kind = ?".to_string());
            params.push(SqlValue::Text(k.to_string()));
        }
        if let Some(q) = search.map(str::trim).filter(|s| !s.is_empty()) {
            let escaped = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
            clauses.push("(m.content LIKE ? ESCAPE '\\' OR COALESCE(m.tags,'') LIKE ? ESCAPE '\\')".to_string());
            let pat = format!("%{escaped}%");
            params.push(SqlValue::Text(pat.clone()));
            params.push(SqlValue::Text(pat));
        }

        let sql = format!(
            "SELECT m.*, c.name AS character_name, c.avatar AS character_avatar, c.color AS character_color
             FROM memories m
             LEFT JOIN characters c ON c.id = m.character_id
             WHERE {}
             ORDER BY m.updated_at DESC
             LIMIT 300",
            clauses.join(" AND ")
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut items = stmt
            .query_map(params_from_iter(params.iter()), row_to_memory)?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        let ids: Vec<String> = items.iter().map(|m| m.id.clone()).collect();
        let mut vmap = crate::ai::embeddings::load_vector_statuses(conn, &ids)?;
        for item in &mut items {
            item.vector_status = vmap.remove(&item.id);
        }
        Ok(items)
    })
}

pub fn create_memory(
    db: &Db,
    user: &User,
    character_id: &str,
    content: &str,
    kind: Option<MemoryKind>,
    importance: Option<f64>,
    tags: Option<Vec<String>>,
) -> AppResult<Memory> {
    let trimmed = content.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 1000 {
        return Err(AppError::validation("记忆内容长度需在 1 至 1000 个字符之间。"));
    }
    let clean_tags = normalize_tags(&tags.unwrap_or_default())?;
    let tags_json = serde_json::to_string(&clean_tags).unwrap_or_else(|_| "[]".into());
    let mem_kind = kind.unwrap_or_else(|| crate::ai::context::memory_category(trimmed));
    let imp = importance.unwrap_or(0.75).clamp(0.1, 1.0);

    db.write(|tx| {
        let visible: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM characters WHERE id=? AND deleted_at IS NULL AND (owner_id IS NULL OR owner_id=?)",
                rusqlite::params![character_id, user.id],
                |r| r.get(0),
            )
            .optional()?;
        if visible.is_none() {
            return Err(AppError::not_found("CHARACTER_NOT_FOUND", "角色不存在。"));
        }

        let id = new_id();
        let now = now_iso();
        tx.execute(
            "INSERT INTO memories(id,user_id,character_id,content,source,kind,importance,status,access_count,tags,created_at,updated_at)
             VALUES(?,?,?,?,'manual',?,?,'active',0,?,?,?)",
            rusqlite::params![id, user.id, character_id, trimmed, mem_kind.as_str(), imp, tags_json, now, now],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO memory_vectors(memory_id,status,updated_at) VALUES(?,'pending',?)",
            rusqlite::params![id, now],
        )?;
        let mut mem = tx.query_row(
            "SELECT m.*, c.name AS character_name, c.avatar AS character_avatar, c.color AS character_color
             FROM memories m LEFT JOIN characters c ON c.id=m.character_id WHERE m.id=?",
            rusqlite::params![id],
            row_to_memory,
        )?;
        mem.vector_status = Some("pending".to_string());
        Ok(mem)
    })
}

pub fn update_memory(
    db: &Db,
    user: &User,
    id: &str,
    content_opt: Option<String>,
    kind_opt: Option<MemoryKind>,
    status_opt: Option<String>,
    importance_opt: Option<f64>,
    tags_opt: Option<Vec<String>>,
) -> AppResult<Memory> {
    db.write(|tx| {
        let cur: Option<Memory> = tx
            .query_row(
                "SELECT m.*, c.name AS character_name, c.avatar AS character_avatar, c.color AS character_color
                 FROM memories m LEFT JOIN characters c ON c.id=m.character_id
                 WHERE m.id=? AND m.user_id=?",
                rusqlite::params![id, user.id],
                row_to_memory,
            )
            .optional()?;
        let Some(existing) = cur else {
            return Err(AppError::not_found("MEMORY_NOT_FOUND", "记忆条目不存在。"));
        };

        let next_content = match content_opt {
            Some(c) => {
                let t = c.trim().to_string();
                if t.is_empty() || t.chars().count() > 1000 {
                    return Err(AppError::validation("记忆内容长度需在 1 至 1000 个字符之间。"));
                }
                t
            }
            None => existing.content.clone(),
        };
        let next_kind = kind_opt.unwrap_or(existing.kind);
        let next_status = match status_opt.as_deref() {
            Some("archived") => "archived",
            Some("active") => "active",
            None => existing.status.as_str(),
            _ => return Err(AppError::validation("记忆状态无效。")),
        };
        let next_imp = importance_opt.unwrap_or(existing.importance).clamp(0.1, 1.0);
        let next_tags = match tags_opt {
            Some(t) => normalize_tags(&t)?,
            None => existing.tags,
        };
        let tags_json = serde_json::to_string(&next_tags).unwrap_or_else(|_| "[]".into());
        let now = now_iso();
        let content_changed = next_content != existing.content;

        tx.execute(
            "UPDATE memories SET content=?, kind=?, status=?, importance=?, tags=?, updated_at=?
             WHERE id=? AND user_id=?",
            rusqlite::params![
                next_content,
                next_kind.as_str(),
                next_status,
                next_imp,
                tags_json,
                now,
                id,
                user.id
            ],
        )?;
        if content_changed {
            tx.execute(
                "UPDATE memory_vectors SET status='pending', updated_at=? WHERE memory_id=?",
                rusqlite::params![now, id],
            )?;
        }

        let mut mem = tx.query_row(
            "SELECT m.*, c.name AS character_name, c.avatar AS character_avatar, c.color AS character_color
             FROM memories m LEFT JOIN characters c ON c.id=m.character_id WHERE m.id=?",
            rusqlite::params![id],
            row_to_memory,
        )?;
        mem.vector_status = tx
            .query_row(
                "SELECT status FROM memory_vectors WHERE memory_id=?",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(mem)
    })
}

pub fn delete_memory(db: &Db, user: &User, id: &str) -> AppResult<()> {
    db.write(|tx| {
        let deleted = tx.execute(
            "DELETE FROM memories WHERE id=? AND user_id=?",
            rusqlite::params![id, user.id],
        )?;
        if deleted == 0 {
            return Err(AppError::not_found("MEMORY_NOT_FOUND", "记忆条目不存在。"));
        }
        Ok(())
    })
}

// ---------------- Admin Overview & Characters ----------------

pub fn get_admin_overview(conn: &Connection) -> AppResult<AdminOverview> {
    let users: i64 = conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
    let characters: i64 = conn.query_row(
        "SELECT COUNT(*) FROM characters WHERE owner_id IS NULL AND deleted_at IS NULL",
        [],
        |r| r.get(0),
    )?;
    let conversations: i64 =
        conn.query_row("SELECT COUNT(*) FROM conversations", [], |r| r.get(0))?;
    let calls: i64 = conn.query_row("SELECT COUNT(*) FROM api_calls", [], |r| r.get(0))?;
    Ok(AdminOverview {
        users,
        characters,
        conversations,
        calls,
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminCharacterInput {
    pub name: String,
    #[serde(default)]
    pub slug: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub personality: String,
    #[serde(default)]
    pub greeting: String,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default = "default_true_flag")]
    pub active: bool,
}

fn default_true_flag() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminCharacterPatch {
    pub name: Option<String>,
    pub slug: Option<String>,
    pub description: Option<String>,
    pub color: Option<String>,
    pub tags: Option<Vec<String>>,
    pub personality: Option<String>,
    pub greeting: Option<String>,
    pub provider_id: Option<Option<String>>,
    pub active: Option<bool>,
}

pub fn admin_list_characters(conn: &Connection) -> AppResult<Vec<Character>> {
    let mut stmt = conn.prepare(
        "SELECT id,owner_id,name,slug,description,avatar,color,tags,personality,greeting,provider_id,active,created_at
         FROM characters
         WHERE owner_id IS NULL AND deleted_at IS NULL
         ORDER BY created_at ASC",
    )?;
    let items = stmt
        .query_map([], |r| row_to_character(r, true))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(items)
}

pub fn admin_create_character(db: &Db, input: AdminCharacterInput) -> AppResult<Character> {
    let name = input.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 60 {
        return Err(AppError::validation("角色名称长度需在 1 至 60 个字符之间。"));
    }
    let personality = input.personality.trim().to_string();
    if personality.is_empty() || personality.chars().count() > 16000 {
        return Err(AppError::validation("角色设定长度需在 1 至 16000 个字符之间。"));
    }
    let description = input.description.trim().chars().take(600).collect::<String>();
    let greeting = input.greeting.trim().chars().take(2000).collect::<String>();
    let color = normalize_hex_color(input.color.as_deref())?;
    let tags = normalize_tags(&input.tags)?;
    let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into());

    db.write(|tx| {
        let slug = validate_slug_or_generate(tx, input.slug.as_deref(), &name)?;
        let provider_id = input
            .provider_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string);
        if let Some(ref pid) = provider_id {
            let exists: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM providers WHERE id=? AND deleted_at IS NULL AND kind='language'",
                    rusqlite::params![pid],
                    |r| r.get(0),
                )
                .optional()?;
            if exists.is_none() {
                return Err(AppError::validation("指定的绑定模型不存在。"));
            }
        }
        let id = new_id();
        let now = now_iso();
        tx.execute(
            "INSERT INTO characters(id,owner_id,name,slug,description,avatar,color,tags,personality,greeting,provider_id,active,created_at)
             VALUES(?,NULL,?,?,?,'',?,?,?,?,?,?,?)",
            rusqlite::params![
                id,
                name,
                slug,
                description,
                color,
                tags_json,
                personality,
                greeting,
                provider_id,
                if input.active { 1 } else { 0 },
                now
            ],
        )?;
        tx.query_row(
            "SELECT id,owner_id,name,slug,description,avatar,color,tags,personality,greeting,provider_id,active,created_at
             FROM characters WHERE id=?",
            rusqlite::params![id],
            |r| row_to_character(r, true),
        )
        .map_err(Into::into)
    })
}

pub fn admin_update_character(db: &Db, id: &str, patch: AdminCharacterPatch) -> AppResult<Character> {
    db.write(|tx| {
        let existing: Option<Character> = tx
            .query_row(
                "SELECT id,owner_id,name,slug,description,avatar,color,tags,personality,greeting,provider_id,active,created_at
                 FROM characters WHERE id=? AND deleted_at IS NULL",
                rusqlite::params![id],
                |r| row_to_character(r, true),
            )
            .optional()?;
        let Some(cur) = existing else {
            return Err(AppError::not_found("CHARACTER_NOT_FOUND", "角色不存在。"));
        };

        let name = match patch.name {
            Some(n) => {
                let t = n.trim().to_string();
                if t.is_empty() || t.chars().count() > 60 {
                    return Err(AppError::validation("角色名称长度需在 1 至 60 个字符之间。"));
                }
                t
            }
            None => cur.name,
        };
        let slug = match patch.slug {
            Some(ref s) if !s.trim().is_empty() && s.trim().to_ascii_lowercase() != cur.slug => {
                validate_slug_or_generate(tx, Some(s), &name)?
            }
            _ => cur.slug,
        };
        let description = patch
            .description
            .map(|d| d.trim().chars().take(600).collect())
            .unwrap_or(cur.description);
        let color = match patch.color {
            Some(c) => normalize_hex_color(Some(&c))?,
            None => cur.color,
        };
        let tags = match patch.tags {
            Some(t) => normalize_tags(&t)?,
            None => cur.tags,
        };
        let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into());
        let personality = match patch.personality {
            Some(p) => {
                let t = p.trim().to_string();
                if t.is_empty() || t.chars().count() > 16000 {
                    return Err(AppError::validation("角色设定长度需在 1 至 16000 个字符之间。"));
                }
                t
            }
            None => cur.personality.unwrap_or_default(),
        };
        let greeting = patch
            .greeting
            .map(|g| g.trim().chars().take(2000).collect())
            .unwrap_or(cur.greeting);
        let provider_id = match patch.provider_id {
            Some(Some(pid)) if !pid.trim().is_empty() => {
                let t = pid.trim().to_string();
                let exists: Option<i64> = tx
                    .query_row(
                        "SELECT 1 FROM providers WHERE id=? AND deleted_at IS NULL AND kind='language'",
                        rusqlite::params![t],
                        |r| r.get(0),
                    )
                    .optional()?;
                if exists.is_none() {
                    return Err(AppError::validation("指定的绑定模型不存在。"));
                }
                Some(t)
            }
            Some(_) => None,
            None => cur.provider_id,
        };
        let active = patch.active.unwrap_or(cur.active);

        tx.execute(
            "UPDATE characters SET name=?, slug=?, description=?, color=?, tags=?, personality=?, greeting=?, provider_id=?, active=? WHERE id=?",
            rusqlite::params![
                name,
                slug,
                description,
                color,
                tags_json,
                personality,
                greeting,
                provider_id,
                if active { 1 } else { 0 },
                id
            ],
        )?;
        tx.query_row(
            "SELECT id,owner_id,name,slug,description,avatar,color,tags,personality,greeting,provider_id,active,created_at
             FROM characters WHERE id=?",
            rusqlite::params![id],
            |r| row_to_character(r, true),
        )
        .map_err(Into::into)
    })
}

pub fn admin_delete_character(db: &Db, config: &Config, id: &str) -> AppResult<()> {
    let old_avatar = db.write(|tx| {
        let av: Option<String> = tx
            .query_row(
                "SELECT avatar FROM characters WHERE id=? AND deleted_at IS NULL",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(avatar) = av else {
            return Err(AppError::not_found("CHARACTER_NOT_FOUND", "角色不存在。"));
        };
        tx.execute(
            "UPDATE characters SET deleted_at=?, active=0, avatar='' WHERE id=?",
            rusqlite::params![now_iso(), id],
        )?;
        Ok(avatar)
    })?;
    if !old_avatar.is_empty() {
        delete_avatar_by_url(config, &old_avatar);
    }
    Ok(())
}

pub fn admin_set_character_avatar(
    db: &Db,
    config: &Config,
    id: &str,
    bytes: &[u8],
) -> AppResult<Character> {
    let prev: String = db.read(|conn| {
        conn.query_row(
            "SELECT avatar FROM characters WHERE id=? AND deleted_at IS NULL",
            rusqlite::params![id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("CHARACTER_NOT_FOUND", "角色不存在。"))
    })?;
    let new_url = save_avatar_file(config, bytes)?;
    let res = db.write(|tx| {
        tx.execute(
            "UPDATE characters SET avatar=? WHERE id=? AND deleted_at IS NULL",
            rusqlite::params![new_url, id],
        )?;
        tx.query_row(
            "SELECT id,owner_id,name,slug,description,avatar,color,tags,personality,greeting,provider_id,active,created_at
             FROM characters WHERE id=?",
            rusqlite::params![id],
            |r| row_to_character(r, true),
        )
        .map_err(Into::into)
    });
    match res {
        Ok(ch) => {
            if !prev.is_empty() && prev != new_url {
                delete_avatar_by_url(config, &prev);
            }
            Ok(ch)
        }
        Err(err) => {
            delete_avatar_by_url(config, &new_url);
            Err(err)
        }
    }
}

pub fn admin_clear_character_avatar(db: &Db, config: &Config, id: &str) -> AppResult<Character> {
    let (ch, old) = db.write(|tx| {
        let prev: Option<String> = tx
            .query_row(
                "SELECT avatar FROM characters WHERE id=? AND deleted_at IS NULL",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(old) = prev else {
            return Err(AppError::not_found("CHARACTER_NOT_FOUND", "角色不存在。"));
        };
        tx.execute(
            "UPDATE characters SET avatar='' WHERE id=?",
            rusqlite::params![id],
        )?;
        let ch = tx.query_row(
            "SELECT id,owner_id,name,slug,description,avatar,color,tags,personality,greeting,provider_id,active,created_at
             FROM characters WHERE id=?",
            rusqlite::params![id],
            |r| row_to_character(r, true),
        )?;
        Ok((ch, old))
    })?;
    if !old.is_empty() {
        delete_avatar_by_url(config, &old);
    }
    Ok(ch)
}

// ---------------- Suppliers & Models (Providers) ----------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierInput {
    pub name: String,
    pub protocol: Protocol,
    pub base_url: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default = "default_true_flag")]
    pub active: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierPatch {
    pub name: Option<String>,
    pub protocol: Option<Protocol>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub active: Option<bool>,
}

pub fn admin_list_suppliers(conn: &Connection) -> AppResult<Vec<SupplierConfig>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, protocol, base_url, api_key, active, created_at
         FROM suppliers WHERE deleted_at IS NULL ORDER BY created_at ASC",
    )?;
    let items = stmt
        .query_map([], row_to_supplier)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(items)
}

pub fn admin_create_supplier(
    db: &Db,
    crypto: &CryptoService,
    input: SupplierInput,
) -> AppResult<SupplierConfig> {
    let name = input.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(AppError::validation("供应商名称长度需在 1 至 80 个字符之间。"));
    }
    let base_url = validate_provider_url(&input.base_url)?;
    let enc_key = match input.api_key.as_deref().map(str::trim) {
        Some(k) if !k.is_empty() => crypto.encrypt(k)?,
        _ => String::new(),
    };
    db.write(|tx| {
        let id = new_id();
        let now = now_iso();
        tx.execute(
            "INSERT INTO suppliers(id,name,protocol,base_url,api_key,active,created_at)
             VALUES(?,?,?,?,?,?,?)",
            rusqlite::params![
                id,
                name,
                input.protocol.as_str(),
                base_url,
                enc_key,
                if input.active { 1 } else { 0 },
                now
            ],
        )?;
        tx.query_row(
            "SELECT id,name,protocol,base_url,api_key,active,created_at FROM suppliers WHERE id=?",
            rusqlite::params![id],
            row_to_supplier,
        )
        .map_err(Into::into)
    })
}

pub fn admin_update_supplier(
    db: &Db,
    crypto: &CryptoService,
    id: &str,
    patch: SupplierPatch,
) -> AppResult<SupplierConfig> {
    db.write(|tx| {
        let cur: Option<(String, String, String, String, i64)> = tx
            .query_row(
                "SELECT name,protocol,base_url,api_key,active FROM suppliers WHERE id=? AND deleted_at IS NULL",
                rusqlite::params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        let Some((c_name, c_proto, c_url, c_key, c_active)) = cur else {
            return Err(AppError::not_found("SUPPLIER_NOT_FOUND", "供应商不存在。"));
        };
        let name = match patch.name {
            Some(n) => {
                let t = n.trim().to_string();
                if t.is_empty() || t.chars().count() > 80 {
                    return Err(AppError::validation("供应商名称长度需在 1 至 80 个字符之间。"));
                }
                t
            }
            None => c_name,
        };
        let protocol = patch
            .protocol
            .map(|p| p.as_str().to_string())
            .unwrap_or(c_proto);
        let base_url = match patch.base_url {
            Some(u) => validate_provider_url(&u)?,
            None => c_url,
        };
        let api_key = match patch.api_key {
            Some(k) if k.is_empty() => String::new(),
            Some(k) => crypto.encrypt(k.trim())?,
            None => c_key,
        };
        let active = patch.active.unwrap_or(c_active != 0);

        tx.execute(
            "UPDATE suppliers SET name=?, protocol=?, base_url=?, api_key=?, active=? WHERE id=?",
            rusqlite::params![
                name,
                protocol,
                base_url,
                api_key,
                if active { 1 } else { 0 },
                id
            ],
        )?;
        // Keep provider.protocol column synced for compatibility
        tx.execute(
            "UPDATE providers SET protocol=? WHERE supplier_id=? AND deleted_at IS NULL",
            rusqlite::params![protocol, id],
        )?;
        tx.query_row(
            "SELECT id,name,protocol,base_url,api_key,active,created_at FROM suppliers WHERE id=?",
            rusqlite::params![id],
            row_to_supplier,
        )
        .map_err(Into::into)
    })
}

pub fn admin_delete_supplier(db: &Db, id: &str) -> AppResult<()> {
    db.write(|tx| {
        let now = now_iso();
        let updated = tx.execute(
            "UPDATE suppliers SET deleted_at=?, active=0 WHERE id=? AND deleted_at IS NULL",
            rusqlite::params![now, id],
        )?;
        if updated == 0 {
            return Err(AppError::not_found("SUPPLIER_NOT_FOUND", "供应商不存在。"));
        }
        tx.execute(
            "UPDATE providers SET deleted_at=?, active=0 WHERE supplier_id=? AND deleted_at IS NULL",
            rusqlite::params![now, id],
        )?;
        Ok(())
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInput {
    pub name: String,
    pub supplier_id: String,
    pub model: String,
    #[serde(default = "default_lang_kind")]
    pub kind: ModelKind,
    #[serde(default = "default_text_caps")]
    pub capabilities: Vec<ModelCapability>,
    #[serde(default = "default_reasoning_effort")]
    pub reasoning_effort: ReasoningEffort,
    #[serde(default)]
    pub thinking_budget: Option<i64>,
    #[serde(default = "default_true_flag")]
    pub active: bool,
    #[serde(default = "default_ctx")]
    pub context_window: i64,
    #[serde(default = "default_out")]
    pub max_output: i64,
    #[serde(default)]
    pub temperature: Option<f64>,
}

fn default_lang_kind() -> ModelKind {
    ModelKind::Language
}
fn default_text_caps() -> Vec<ModelCapability> {
    vec![ModelCapability::Text]
}
fn default_reasoning_effort() -> ReasoningEffort {
    ReasoningEffort::Default
}
fn default_ctx() -> i64 {
    32768
}
fn default_out() -> i64 {
    2048
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPatch {
    pub name: Option<String>,
    pub supplier_id: Option<String>,
    pub model: Option<String>,
    pub kind: Option<ModelKind>,
    pub capabilities: Option<Vec<ModelCapability>>,
    pub reasoning_effort: Option<ReasoningEffort>,
    pub thinking_budget: Option<Option<i64>>,
    pub active: Option<bool>,
    pub context_window: Option<i64>,
    pub max_output: Option<i64>,
    pub temperature: Option<Option<f64>>,
}

const PROVIDER_SELECT: &str = "
    SELECT p.id, p.name, p.supplier_id, s.name AS supplier_name,
           s.protocol AS supplier_protocol, s.base_url AS supplier_base_url,
           s.api_key AS supplier_api_key, s.active AS supplier_active,
           s.deleted_at AS supplier_deleted_at,
           p.model, p.kind, p.capabilities, p.reasoning_effort, p.thinking_budget,
           p.active, p.context_window, p.max_output, p.temperature, p.created_at
    FROM providers p
    JOIN suppliers s ON s.id = p.supplier_id
";

pub fn admin_list_models(conn: &Connection) -> AppResult<Vec<ProviderConfig>> {
    let sql = format!("{PROVIDER_SELECT} WHERE p.deleted_at IS NULL ORDER BY p.created_at ASC");
    let mut stmt = conn.prepare(&sql)?;
    let items = stmt
        .query_map([], row_to_provider)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(items)
}

fn validate_model_params(
    kind: ModelKind,
    supplier_proto: Protocol,
    caps: &[ModelCapability],
    context_window: i64,
    max_output: i64,
    temperature: Option<f64>,
) -> AppResult<Vec<String>> {
    if kind == ModelKind::Embedding && supplier_proto == Protocol::Anthropic {
        return Err(AppError::validation("Anthropic 协议供应商不支持创建向量模型。"));
    }
    if !(512..=2_000_000).contains(&context_window) {
        return Err(AppError::validation("上下文窗口大小需在 512 至 2000000 之间。"));
    }
    if !(64..=131_072).contains(&max_output) {
        return Err(AppError::validation("最大输出 Token 数需在 64 至 131072 之间。"));
    }
    if let Some(t) = temperature {
        if !(0.0..=2.0).contains(&t) {
            return Err(AppError::validation("温度参数需在 0.0 至 2.0 之间。"));
        }
    }
    let mut cap_strs: Vec<String> = Vec::new();
    for c in caps {
        let s = match c {
            ModelCapability::Text => "text",
            ModelCapability::Image => "image",
            ModelCapability::Audio => "audio",
            ModelCapability::File => "file",
        }
        .to_string();
        if !cap_strs.contains(&s) {
            cap_strs.push(s);
        }
    }
    if kind == ModelKind::Language && cap_strs.is_empty() {
        cap_strs.push("text".to_string());
    }
    Ok(cap_strs)
}

pub fn admin_create_model(db: &Db, input: ModelInput) -> AppResult<ProviderConfig> {
    let name = input.name.trim().to_string();
    let model = input.model.trim().to_string();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(AppError::validation("模型显示名称长度需在 1 至 80 个字符之间。"));
    }
    if model.is_empty() || model.chars().count() > 160 {
        return Err(AppError::validation("模型标识不能为空且不超过 160 个字符。"));
    }

    db.write(|tx| {
        let supplier_proto_str: Option<String> = tx
            .query_row(
                "SELECT protocol FROM suppliers WHERE id=? AND deleted_at IS NULL",
                rusqlite::params![input.supplier_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(proto_str) = supplier_proto_str else {
            return Err(AppError::not_found("SUPPLIER_NOT_FOUND", "所属供应商不存在。"));
        };
        let proto = Protocol::from_db(&proto_str);
        let cap_strs = validate_model_params(
            input.kind,
            proto,
            &input.capabilities,
            input.context_window,
            input.max_output,
            input.temperature,
        )?;
        let caps_json = serde_json::to_string(&cap_strs).unwrap_or_else(|_| "[\"text\"]".into());
        let id = new_id();
        let now = now_iso();
        tx.execute(
            "INSERT INTO providers(id,name,protocol,supplier_id,kind,capabilities,reasoning_effort,thinking_budget,base_url,model,api_key,active,context_window,max_output,temperature,created_at)
             VALUES(?,?,?,?,?,?,?,?,'',?,'',?,?,?,?,?)",
            rusqlite::params![
                id,
                name,
                proto.as_str(),
                input.supplier_id,
                input.kind.as_str(),
                caps_json,
                input.reasoning_effort.as_str(),
                input.thinking_budget,
                model,
                if input.active { 1 } else { 0 },
                input.context_window,
                input.max_output,
                input.temperature,
                now
            ],
        )?;
        tx.query_row(
            &format!("{PROVIDER_SELECT} WHERE p.id=?"),
            rusqlite::params![id],
            row_to_provider,
        )
        .map_err(Into::into)
    })
}

pub fn admin_update_model(db: &Db, id: &str, patch: ModelPatch) -> AppResult<ProviderConfig> {
    db.write(|tx| {
        let cur: Option<ProviderConfig> = tx
            .query_row(
                &format!("{PROVIDER_SELECT} WHERE p.id=? AND p.deleted_at IS NULL"),
                rusqlite::params![id],
                row_to_provider,
            )
            .optional()?;
        let Some(existing) = cur else {
            return Err(AppError::not_found("MODEL_NOT_FOUND", "模型不存在。"));
        };

        let supplier_id = patch.supplier_id.unwrap_or(existing.supplier_id);
        let proto_str: Option<String> = tx
            .query_row(
                "SELECT protocol FROM suppliers WHERE id=? AND deleted_at IS NULL",
                rusqlite::params![supplier_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(proto_str) = proto_str else {
            return Err(AppError::not_found("SUPPLIER_NOT_FOUND", "所属供应商不存在。"));
        };
        let proto = Protocol::from_db(&proto_str);

        let name = match patch.name {
            Some(n) => {
                let t = n.trim().to_string();
                if t.is_empty() || t.chars().count() > 80 {
                    return Err(AppError::validation("模型显示名称长度需在 1 至 80 个字符之间。"));
                }
                t
            }
            None => existing.name,
        };
        let model = match patch.model {
            Some(m) => {
                let t = m.trim().to_string();
                if t.is_empty() || t.chars().count() > 160 {
                    return Err(AppError::validation("模型标识不能为空且不超过 160 个字符。"));
                }
                t
            }
            None => existing.model,
        };
        let kind = patch.kind.unwrap_or(existing.kind);
        let capabilities = patch.capabilities.unwrap_or(existing.capabilities);
        let context_window = patch.context_window.unwrap_or(existing.context_window);
        let max_output = patch.max_output.unwrap_or(existing.max_output);
        let temperature = patch.temperature.unwrap_or(existing.temperature);
        let reasoning_effort = patch.reasoning_effort.unwrap_or(existing.reasoning_effort);
        let thinking_budget = patch.thinking_budget.unwrap_or(existing.thinking_budget);
        let active = patch.active.unwrap_or(existing.active);

        let cap_strs = validate_model_params(
            kind,
            proto,
            &capabilities,
            context_window,
            max_output,
            temperature,
        )?;
        let caps_json = serde_json::to_string(&cap_strs).unwrap_or_else(|_| "[\"text\"]".into());

        tx.execute(
            "UPDATE providers
             SET name=?, supplier_id=?, protocol=?, model=?, kind=?, capabilities=?,
                 reasoning_effort=?, thinking_budget=?, active=?, context_window=?,
                 max_output=?, temperature=?
             WHERE id=?",
            rusqlite::params![
                name,
                supplier_id,
                proto.as_str(),
                model,
                kind.as_str(),
                caps_json,
                reasoning_effort.as_str(),
                thinking_budget,
                if active { 1 } else { 0 },
                context_window,
                max_output,
                temperature,
                id
            ],
        )?;
        tx.query_row(
            &format!("{PROVIDER_SELECT} WHERE p.id=?"),
            rusqlite::params![id],
            row_to_provider,
        )
        .map_err(Into::into)
    })
}

pub fn admin_delete_model(db: &Db, id: &str) -> AppResult<()> {
    db.write(|tx| {
        let updated = tx.execute(
            "UPDATE providers SET deleted_at=?, active=0 WHERE id=? AND deleted_at IS NULL",
            rusqlite::params![now_iso(), id],
        )?;
        if updated == 0 {
            return Err(AppError::not_found("MODEL_NOT_FOUND", "模型不存在。"));
        }
        tx.execute(
            "UPDATE characters SET provider_id=NULL WHERE provider_id=?",
            rusqlite::params![id],
        )?;
        Ok(())
    })
}

pub fn resolve_model_for_test(
    conn: &Connection,
    crypto: &CryptoService,
    id: &str,
) -> AppResult<ResolvedModel> {
    let row = conn
        .query_row(
            "SELECT p.id, p.name, p.supplier_id, s.name AS supplier_name,
                    s.protocol AS supplier_protocol, s.base_url AS supplier_base_url,
                    s.api_key AS supplier_api_key, p.model, p.kind, p.capabilities,
                    p.reasoning_effort, p.thinking_budget, p.context_window,
                    p.max_output, p.temperature
             FROM providers p
             JOIN suppliers s ON s.id = p.supplier_id
             WHERE p.id=? AND p.deleted_at IS NULL AND s.deleted_at IS NULL",
            rusqlite::params![id],
            |r| {
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
            },
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("MODEL_NOT_FOUND", "模型或供应商不存在。"))?;

    let (mut m, enc_key) = row;
    m.api_key = if enc_key.is_empty() {
        String::new()
    } else {
        crypto.decrypt(&enc_key)?
    };
    Ok(m)
}

// ---------------- Admin Users & Announcements ----------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminCreateUserInput {
    pub email: String,
    pub password: String,
    pub name: String,
    #[serde(default = "default_user_role")]
    pub role: String,
    #[serde(default)]
    pub limit5h: Option<i64>,
    #[serde(default)]
    pub limit7d: Option<i64>,
    #[serde(default)]
    pub character_slots: Option<i64>,
}

fn default_user_role() -> String {
    "user".to_string()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminUserPatch {
    pub role: Option<String>,
    pub disabled: Option<bool>,
    pub limit5h: Option<i64>,
    pub limit7d: Option<i64>,
    pub character_slots: Option<i64>,
    pub password: Option<String>,
}

pub fn admin_list_users(conn: &Connection) -> AppResult<Vec<User>> {
    let mut stmt = conn.prepare(
        "SELECT id,email,name,role,disabled,timezone,created_at,email_verified_at,avatar,persona,limit_5h,limit_7d,character_slots
         FROM users ORDER BY created_at DESC",
    )?;
    let items = stmt
        .query_map([], row_to_user)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(items)
}

pub async fn admin_create_user(db: &Db, input: AdminCreateUserInput) -> AppResult<User> {
    let email = normalize_email(&input.email)?;
    let name = validate_name(&input.name)?;
    validate_password(&input.password)?;
    let role = if input.role == "admin" { "admin" } else { "user" };
    let pw = input.password;
    let pw_hash = tokio::task::spawn_blocking(move || hash_password(&pw))
        .await
        .map_err(|_| AppError::internal())??;

    db.write(|tx| {
        let exists: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM users WHERE email=? COLLATE NOCASE",
                rusqlite::params![email],
                |r| r.get(0),
            )
            .optional()?;
        if exists.is_some() {
            return Err(AppError::conflict("EMAIL_EXISTS", "该邮箱已被注册。"));
        }
        let settings = read_settings(tx)?;
        let limit5h = input.limit5h.unwrap_or(settings.default_limit5h).max(0);
        let limit7d = input.limit7d.unwrap_or(settings.default_limit7d).max(0);
        let slots = input
            .character_slots
            .unwrap_or(settings.default_character_slots)
            .clamp(0, 100);
        let id = new_id();
        let now = now_iso();
        tx.execute(
            "INSERT INTO users(id,email,name,password_hash,role,disabled,timezone,limit_5h,limit_7d,quota_reset_at,created_at,email_verified_at,character_slots)
             VALUES(?,?,?,?,?,0,'Asia/Shanghai',?,?, '1970-01-01T00:00:00.000Z', ?, ?, ?)",
            rusqlite::params![id, email, name, pw_hash, role, limit5h, limit7d, now, now, slots],
        )?;
        tx.query_row(
            "SELECT id,email,name,role,disabled,timezone,created_at,email_verified_at,avatar,persona,limit_5h,limit_7d,character_slots
             FROM users WHERE id=?",
            rusqlite::params![id],
            row_to_user,
        )
        .map_err(Into::into)
    })
}

pub async fn admin_update_user(
    db: &Db,
    actor: &User,
    target_id: &str,
    patch: AdminUserPatch,
) -> AppResult<User> {
    let hashed_pw = match patch.password.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(pw) => {
            validate_password(pw)?;
            let owned = pw.to_string();
            Some(
                tokio::task::spawn_blocking(move || hash_password(&owned))
                    .await
                    .map_err(|_| AppError::internal())??,
            )
        }
        None => None,
    };

    db.write(|tx| {
        let cur: Option<User> = tx
            .query_row(
                "SELECT id,email,name,role,disabled,timezone,created_at,email_verified_at,avatar,persona,limit_5h,limit_7d,character_slots
                 FROM users WHERE id=?",
                rusqlite::params![target_id],
                row_to_user,
            )
            .optional()?;
        let Some(existing) = cur else {
            return Err(AppError::not_found("USER_NOT_FOUND", "用户不存在。"));
        };

        let next_role = match patch.role.as_deref() {
            Some("admin") => "admin",
            Some("user") => "user",
            None => existing.role.as_str(),
            _ => return Err(AppError::validation("用户角色无效。")),
        };
        let next_disabled = patch.disabled.unwrap_or(existing.disabled);
        if target_id == actor.id && (next_role != "admin" || next_disabled) {
            return Err(AppError::bad_request(
                "SELF_DEMOTION_BLOCKED",
                "无法停用自己或撤销自身的管理员权限。",
            ));
        }

        let next_5h = patch.limit5h.unwrap_or(existing.limit5h).max(0);
        let next_7d = patch.limit7d.unwrap_or(existing.limit7d).max(0);
        let next_slots = patch
            .character_slots
            .unwrap_or(existing.character_slots)
            .clamp(0, 100);

        tx.execute(
            "UPDATE users SET role=?, disabled=?, limit_5h=?, limit_7d=?, character_slots=? WHERE id=?",
            rusqlite::params![
                next_role,
                if next_disabled { 1 } else { 0 },
                next_5h,
                next_7d,
                next_slots,
                target_id
            ],
        )?;
        if let Some(ref pw) = hashed_pw {
            tx.execute(
                "UPDATE users SET password_hash=? WHERE id=?",
                rusqlite::params![pw, target_id],
            )?;
            revoke_user_sessions_tx(tx, target_id, None)?;
        } else if next_disabled {
            revoke_user_sessions_tx(tx, target_id, None)?;
        }

        tx.query_row(
            "SELECT id,email,name,role,disabled,timezone,created_at,email_verified_at,avatar,persona,limit_5h,limit_7d,character_slots
             FROM users WHERE id=?",
            rusqlite::params![target_id],
            row_to_user,
        )
        .map_err(Into::into)
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnouncementInput {
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default = "default_true_flag")]
    pub published: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnouncementPatch {
    pub title: Option<String>,
    pub content: Option<String>,
    pub pinned: Option<bool>,
    pub published: Option<bool>,
}

pub fn admin_create_announcement(db: &Db, input: AnnouncementInput) -> AppResult<Announcement> {
    let title = input.title.trim().to_string();
    let content = input.content.trim().to_string();
    if title.is_empty() || title.chars().count() > 120 {
        return Err(AppError::validation("公告标题长度需在 1 至 120 个字符之间。"));
    }
    if content.is_empty() || content.chars().count() > 8000 {
        return Err(AppError::validation("公告正文长度需在 1 至 8000 个字符之间。"));
    }
    db.write(|tx| {
        let id = new_id();
        let now = now_iso();
        tx.execute(
            "INSERT INTO announcements(id,title,content,pinned,published,created_at,updated_at)
             VALUES(?,?,?,?,?,?,?)",
            rusqlite::params![
                id,
                title,
                content,
                if input.pinned { 1 } else { 0 },
                if input.published { 1 } else { 0 },
                now,
                now
            ],
        )?;
        tx.query_row(
            "SELECT id,title,content,pinned,published,created_at,updated_at FROM announcements WHERE id=?",
            rusqlite::params![id],
            row_to_announcement,
        )
        .map_err(Into::into)
    })
}

pub fn admin_update_announcement(
    db: &Db,
    id: &str,
    patch: AnnouncementPatch,
) -> AppResult<Announcement> {
    db.write(|tx| {
        let cur: Option<Announcement> = tx
            .query_row(
                "SELECT id,title,content,pinned,published,created_at,updated_at FROM announcements WHERE id=?",
                rusqlite::params![id],
                row_to_announcement,
            )
            .optional()?;
        let Some(existing) = cur else {
            return Err(AppError::not_found("ANNOUNCEMENT_NOT_FOUND", "公告不存在。"));
        };
        let title = match patch.title {
            Some(t) => {
                let s = t.trim().to_string();
                if s.is_empty() || s.chars().count() > 120 {
                    return Err(AppError::validation("公告标题长度需在 1 至 120 个字符之间。"));
                }
                s
            }
            None => existing.title,
        };
        let content = match patch.content {
            Some(c) => {
                let s = c.trim().to_string();
                if s.is_empty() || s.chars().count() > 8000 {
                    return Err(AppError::validation("公告正文长度需在 1 至 8000 个字符之间。"));
                }
                s
            }
            None => existing.content,
        };
        let pinned = patch.pinned.unwrap_or(existing.pinned);
        let published = patch.published.unwrap_or(existing.published);
        let now = now_iso();
        tx.execute(
            "UPDATE announcements SET title=?, content=?, pinned=?, published=?, updated_at=? WHERE id=?",
            rusqlite::params![
                title,
                content,
                if pinned { 1 } else { 0 },
                if published { 1 } else { 0 },
                now,
                id
            ],
        )?;
        tx.query_row(
            "SELECT id,title,content,pinned,published,created_at,updated_at FROM announcements WHERE id=?",
            rusqlite::params![id],
            row_to_announcement,
        )
        .map_err(Into::into)
    })
}

pub fn admin_delete_announcement(db: &Db, id: &str) -> AppResult<()> {
    db.write(|tx| {
        let deleted = tx.execute("DELETE FROM announcements WHERE id=?", rusqlite::params![id])?;
        if deleted == 0 {
            return Err(AppError::not_found("ANNOUNCEMENT_NOT_FOUND", "公告不存在。"));
        }
        Ok(())
    })
}
