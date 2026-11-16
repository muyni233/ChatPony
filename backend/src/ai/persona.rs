use crate::ai::context::truncate_utf8;
use crate::models::UserPersona;

const MAX_PERSONA_FIELD_BYTES: usize = 480;
const MAX_PERSONA_TOTAL_BYTES: usize = 1600;

pub fn build_persona_block(persona: Option<&UserPersona>) -> String {
    let Some(p) = persona else {
        return String::new();
    };
    if !p.enabled {
        return String::new();
    }

    let mut obj = serde_json::Map::new();
    let mut push = |key: &str, val: &str| {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            obj.insert(
                key.to_string(),
                serde_json::Value::String(truncate_utf8(trimmed, MAX_PERSONA_FIELD_BYTES)),
            );
        }
    };

    push("name", &p.name);
    push("species", &p.species);
    push("pronouns", &p.pronouns);
    push("appearance", &p.appearance);
    push("personality", &p.personality);
    push("background", &p.background);

    if obj.is_empty() {
        return String::new();
    }

    let json = serde_json::Value::Object(obj).to_string();
    let bounded = truncate_utf8(&json, MAX_PERSONA_TOTAL_BYTES);
    format!(
        "对话用户的设定参考（请在互动中自然称呼与适配，不要生硬背诵字段）：\n{bounded}"
    )
}
