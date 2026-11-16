use crate::models::MemoryKind;

#[derive(Debug, Clone)]
pub struct ContextMessage {
    pub id: String,
    pub role: String,
    pub character_id: Option<String>,
    pub speaker_name: Option<String>,
    pub content: String,
    pub attachment_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct PreparedContext {
    pub summary: String,
    pub messages: Vec<ContextMessage>,
    pub trimmed_count: usize,
}

pub fn estimate_tokens(text: &str) -> usize {
    text.len() + 8
}

pub fn truncate_utf8(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let prefix = &text[..end];
    format!("{prefix}…")
}

pub fn create_extractive_summary(messages: &[ContextMessage], max_bytes: usize) -> String {
    if messages.is_empty() {
        return String::new();
    }
    let mut lines = Vec::new();
    let mut used = 0usize;
    for msg in messages.iter().rev() {
        let who = msg
            .speaker_name
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(if msg.role == "user" { "用户" } else { "角色" });
        let compact: String = msg
            .content
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let snippet = truncate_utf8(&compact, 220);
        if snippet.is_empty() {
            continue;
        }
        let line = format!("- {who}: {snippet}");
        if used + line.len() + 1 > max_bytes && !lines.is_empty() {
            break;
        }
        used += line.len() + 1;
        lines.push(line);
    }
    lines.reverse();
    lines.join("\n")
}

pub fn prepare_context(
    messages: &[ContextMessage],
    stored_summary: &str,
    context_window: i64,
    max_output: i64,
    system_tokens: usize,
) -> PreparedContext {
    let window = (context_window.max(2048)) as usize;
    let output_budget = (max_output.max(256)).min(context_window.max(2048) / 2) as usize;
    let available = window
        .saturating_sub(output_budget)
        .saturating_sub(system_tokens)
        .saturating_sub(512)
        .max(1024);

    let mut kept_rev: Vec<ContextMessage> = Vec::new();
    let mut used = 0usize;
    let mut split_idx = messages.len();

    for (rev_offset, msg) in messages.iter().rev().enumerate() {
        let img_cost = msg.attachment_ids.len() * 512;
        let cost = estimate_tokens(&msg.content) + img_cost;
        if rev_offset >= 2 && used + cost > available {
            break;
        }
        used += cost;
        kept_rev.push(msg.clone());
        split_idx = messages.len() - 1 - rev_offset;
    }

    kept_rev.reverse();
    let trimmed = &messages[..split_idx];
    let mut summary_parts = Vec::new();
    let stored_trimmed = stored_summary.trim();
    if !stored_trimmed.is_empty() {
        summary_parts.push(stored_trimmed.to_string());
    }
    if !trimmed.is_empty() {
        let extra = create_extractive_summary(trimmed, 1800);
        if !extra.is_empty() {
            summary_parts.push(extra);
        }
    }
    let summary = truncate_utf8(&summary_parts.join("\n\n"), 3600);

    PreparedContext {
        summary,
        messages: kept_rev,
        trimmed_count: trimmed.len(),
    }
}

pub fn memory_category(text: &str) -> MemoryKind {
    let lower = text.to_ascii_lowercase();
    let has_any = |words: &[&str]| words.iter().any(|w| text.contains(w) || lower.contains(w));
    if has_any(&["喜欢", "讨厌", "偏好", "爱吃", "喝", "口味", "习惯", "prefer", "favorite"]) {
        MemoryKind::Preference
    } else if has_any(&["约定", "计划", "打算", "明天", "周末", "下周", "提醒", "约好", "plan"]) {
        MemoryKind::Plan
    } else if has_any(&["朋友", "关系", "搭档", "恋人", "家人", "老师", "同事", "妹妹", "哥哥"]) {
        MemoryKind::Relationship
    } else if has_any(&["今天", "昨天", "曾经", "去过", "参加", "发生", "那次", "event"]) {
        MemoryKind::Event
    } else if has_any(&["名字", "住", "生日", "年龄", "工作", "职业", "学校", "擅长", "养了"]) {
        MemoryKind::Fact
    } else {
        MemoryKind::Note
    }
}

pub fn extract_explicit_memories(text: &str) -> Vec<(String, MemoryKind)> {
    let prefixes = [
        "请记住",
        "记住：",
        "记住:",
        "帮我记一下",
        "记一下",
        "记住",
        "别忘了",
        "remember:",
        "remember that ",
    ];
    let mut out = Vec::new();
    for sentence in text.split(['\n', '。', ';', '；']) {
        let s = sentence.trim();
        if s.is_empty() {
            continue;
        }
        let s_lower = s.to_ascii_lowercase();
        for prefix in prefixes {
            let found_pos = if prefix.is_ascii() {
                s_lower.find(prefix)
            } else {
                s.find(prefix)
            };
            if let Some(pos) = found_pos {
                let valid_boundary = pos == 0
                    || s[..pos]
                        .chars()
                        .next_back()
                        .map(|c| c.is_whitespace() || matches!(c, '，' | ',' | '：' | ':' | '、'))
                        .unwrap_or(true);
                if !valid_boundary {
                    continue;
                }
                let body = s[pos + prefix.len()..]
                    .trim_start_matches([':', '：', ',', '，', ' '])
                    .trim();
                if body.chars().count() >= 3 && body.chars().count() <= 240 {
                    out.push((body.to_string(), memory_category(body)));
                }
                break;
            }
        }
    }
    out
}
