use rusqlite::Row;

use crate::models::{
    Announcement, Character, Conversation, Memory, MemoryKind, Message, ModelCapability, ModelKind,
    Protocol, ProviderConfig, ReasoningEffort, SupplierConfig, User, UserPersona,
};

pub fn parse_persona(raw: &str) -> UserPersona {
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(raw) else {
        return UserPersona::default();
    };
    let text = |k: &str| {
        map.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    UserPersona {
        enabled: map.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false),
        name: text("name"),
        species: text("species"),
        pronouns: text("pronouns"),
        appearance: text("appearance"),
        personality: text("personality"),
        background: text("background"),
    }
}

pub fn parse_string_list(raw: &str) -> Vec<String> {
    let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    items
        .into_iter()
        .filter_map(|v| v.as_str().map(ToString::to_string))
        .collect()
}

pub fn row_to_user(row: &Row<'_>) -> rusqlite::Result<User> {
    let role_raw: String = row.get("role")?;
    let disabled: i64 = row.get("disabled")?;
    let persona_raw: String = row.get("persona")?;
    let avatar: String = row.get("avatar")?;
    let email_verified_at: Option<String> = row.get("email_verified_at")?;
    let slots: Option<i64> = row.get("character_slots")?;
    Ok(User {
        id: row.get("id")?,
        email: row.get("email")?,
        name: row.get("name")?,
        role: if role_raw == "admin" {
            "admin".to_string()
        } else {
            "user".to_string()
        },
        disabled: disabled != 0,
        timezone: row.get("timezone")?,
        created_at: row.get("created_at")?,
        email_verified_at,
        avatar,
        persona: Some(parse_persona(&persona_raw)),
        limit5h: row.get("limit_5h")?,
        limit7d: row.get("limit_7d")?,
        character_slots: slots.unwrap_or(3),
    })
}

pub fn row_to_character(row: &Row<'_>, admin: bool) -> rusqlite::Result<Character> {
    let tags_raw: String = row.get("tags")?;
    let active: i64 = row.get("active")?;
    let personality: String = row.get("personality")?;
    let provider_id: Option<String> = row.get("provider_id")?;
    Ok(Character {
        id: row.get("id")?,
        owner_id: row.get("owner_id")?,
        name: row.get("name")?,
        slug: row.get("slug")?,
        description: row.get("description")?,
        avatar: row.get("avatar")?,
        color: row.get("color")?,
        tags: parse_string_list(&tags_raw),
        personality: if admin { Some(personality) } else { None },
        greeting: row.get("greeting")?,
        provider_id: if admin { provider_id } else { None },
        active: active != 0,
        created_at: row.get("created_at")?,
    })
}

pub fn row_to_conversation(row: &Row<'_>) -> rusqlite::Result<Conversation> {
    let char_ids_raw: String = row.get("character_ids")?;
    let summary: Option<String> = row.get("summary")?;
    let last_msg: Option<String> = row.get("last_message").unwrap_or(None);
    let kind_raw: String = row.get("kind")?;
    Ok(Conversation {
        id: row.get("id")?,
        user_id: row.get("user_id")?,
        title: row.get("title")?,
        kind: if kind_raw == "group" {
            "group".to_string()
        } else {
            "private".to_string()
        },
        character_ids: parse_string_list(&char_ids_raw),
        summary: summary.unwrap_or_default(),
        max_rounds: row.get("max_rounds")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        last_message: last_msg.unwrap_or_default(),
    })
}

pub fn row_to_message(row: &Row<'_>) -> rusqlite::Result<Message> {
    Ok(Message {
        id: row.get("id")?,
        conversation_id: row.get("conversation_id")?,
        role: row.get("role")?,
        character_id: row.get("character_id")?,
        content: row.get("content")?,
        created_at: row.get("created_at")?,
        attachments: None,
    })
}

pub fn row_to_memory(row: &Row<'_>) -> rusqlite::Result<Memory> {
    let character_name: Option<String> = row.get("character_name").unwrap_or(None);
    let character_avatar: Option<String> = row.get("character_avatar").unwrap_or(None);
    let character_color: Option<String> = row.get("character_color").unwrap_or(None);
    let source_raw: String = row.get("source")?;
    let kind_raw: String = row.get("kind")?;
    let importance: Option<f64> = row.get("importance")?;
    let status_raw: String = row.get("status")?;
    let access_count: Option<i64> = row.get("access_count")?;
    let tags_raw: String = row.get("tags")?;
    Ok(Memory {
        id: row.get("id")?,
        user_id: row.get("user_id")?,
        character_id: row.get("character_id")?,
        character_avatar: character_name.as_ref().map(|_| character_avatar.unwrap_or_default()),
        character_color: character_name
            .as_ref()
            .map(|_| character_color.unwrap_or_else(|| "#A58BBE".to_string())),
        character_name,
        content: row.get("content")?,
        source: if source_raw == "auto" {
            "auto".to_string()
        } else {
            "manual".to_string()
        },
        kind: MemoryKind::from_db(&kind_raw),
        importance: importance.unwrap_or(0.5),
        status: if status_raw == "archived" {
            "archived".to_string()
        } else {
            "active".to_string()
        },
        access_count: access_count.unwrap_or(0),
        last_accessed_at: row.get("last_accessed_at")?,
        expires_at: row.get("expires_at")?,
        tags: parse_string_list(&tags_raw),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        vector_status: None,
    })
}

pub fn row_to_provider(row: &Row<'_>) -> rusqlite::Result<ProviderConfig> {
    let supplier_proto: String = row.get("supplier_protocol")?;
    let kind_raw: String = row.get("kind")?;
    let caps_raw: String = row.get("capabilities")?;
    let effort_raw: Option<String> = row.get("reasoning_effort")?;
    let supplier_active: i64 = row.get("supplier_active")?;
    let supplier_deleted: Option<String> = row.get("supplier_deleted_at")?;
    let supplier_key: Option<String> = row.get("supplier_api_key")?;
    let active: i64 = row.get("active")?;
    let capabilities = parse_string_list(&caps_raw)
        .into_iter()
        .filter_map(|s| ModelCapability::from_str_opt(&s))
        .collect();
    Ok(ProviderConfig {
        id: row.get("id")?,
        supplier_id: row.get("supplier_id")?,
        supplier_name: row.get("supplier_name")?,
        supplier_active: supplier_active != 0 && supplier_deleted.is_none(),
        name: row.get("name")?,
        protocol: Protocol::from_db(&supplier_proto),
        base_url: row
            .get::<_, Option<String>>("supplier_base_url")?
            .unwrap_or_default(),
        model: row.get("model")?,
        kind: ModelKind::from_db(&kind_raw),
        capabilities,
        reasoning_effort: ReasoningEffort::from_db(effort_raw.as_deref().unwrap_or("default")),
        thinking_budget: row.get("thinking_budget")?,
        has_key: !supplier_key.unwrap_or_default().is_empty(),
        active: active != 0,
        context_window: row.get("context_window")?,
        max_output: row.get("max_output")?,
        temperature: row.get("temperature")?,
        created_at: row.get("created_at")?,
    })
}

pub fn row_to_supplier(row: &Row<'_>) -> rusqlite::Result<SupplierConfig> {
    let proto: String = row.get("protocol")?;
    let api_key: String = row.get("api_key")?;
    let active: i64 = row.get("active")?;
    Ok(SupplierConfig {
        id: row.get("id")?,
        name: row.get("name")?,
        protocol: Protocol::from_db(&proto),
        base_url: row.get("base_url")?,
        has_key: !api_key.is_empty(),
        active: active != 0,
        created_at: row.get("created_at")?,
    })
}

pub fn row_to_announcement(row: &Row<'_>) -> rusqlite::Result<Announcement> {
    let pinned: i64 = row.get("pinned")?;
    let published: i64 = row.get("published")?;
    Ok(Announcement {
        id: row.get("id")?,
        title: row.get("title")?,
        content: row.get("content")?,
        pinned: pinned != 0,
        published: published != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}
