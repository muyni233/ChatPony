use std::collections::HashSet;

pub fn strip_display_symbols(content: &str, hidden_symbols: &[String]) -> String {
    let mut symbols: Vec<&str> = hidden_symbols
        .iter()
        .map(String::as_str)
        .filter(|s| !s.is_empty())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if symbols.is_empty() {
        return content.to_string();
    }
    symbols.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));

    let mut result = String::with_capacity(content.len());
    let mut idx = 0;
    while idx < content.len() {
        let rest = &content[idx..];
        if let Some(found) = symbols.iter().find(|sym| rest.starts_with(*sym)) {
            idx += found.len();
        } else if let Some(ch) = rest.chars().next() {
            result.push(ch);
            idx += ch.len_utf8();
        } else {
            break;
        }
    }
    result
}

pub fn message_bubbles(
    content: &str,
    bubble_delimiter: &str,
    hidden_symbols: &[String],
    split: bool,
) -> Vec<String> {
    let parts: Vec<&str> = if split && !bubble_delimiter.is_empty() {
        content.split(bubble_delimiter).collect()
    } else {
        vec![content]
    };
    parts
        .into_iter()
        .map(|part| strip_display_symbols(part, hidden_symbols).trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

pub fn visible_message(
    content: &str,
    bubble_delimiter: &str,
    hidden_symbols: &[String],
    split: bool,
) -> String {
    message_bubbles(content, bubble_delimiter, hidden_symbols, split).join("\n\n")
}
