use std::collections::{HashSet, VecDeque};

use crate::models::Character;

#[derive(Debug, Clone)]
struct AliasEntry {
    char_idx: usize,
    alias_lower: String,
    alias_bytes: usize,
}

fn is_valid_before_at(text: &str, at_idx: usize) -> bool {
    let Some(prev) = text[..at_idx].chars().next_back() else {
        return true;
    };
    !(prev.is_ascii_alphanumeric() || matches!(prev, '_' | '.' | '-'))
}

fn is_valid_after_alias(text: &str, end_idx: usize, alias: &str) -> bool {
    let Some(next) = text[end_idx..].chars().next() else {
        return true;
    };
    if next.is_ascii_alphanumeric() || matches!(next, '_' | '-') {
        return false;
    }
    // Reject domain suffix like "@name.com" while allowing sentence period "@name." or "@name. Next"
    if next == '.'
        && let Some(after_dot) = text[end_idx + 1..].chars().next()
        && after_dot.is_ascii_alphanumeric()
    {
        return false;
    }
    let _ = alias;
    true
}

pub fn find_mentions(text: &str, members: &[Character]) -> Vec<String> {
    if text.is_empty() || members.is_empty() {
        return Vec::new();
    }

    let mut entries: Vec<AliasEntry> = Vec::new();
    for (idx, c) in members.iter().enumerate() {
        for raw in [c.name.trim(), c.slug.trim()] {
            if !raw.is_empty() {
                let lower = raw.to_lowercase();
                entries.push(AliasEntry {
                    char_idx: idx,
                    alias_bytes: lower.len(),
                    alias_lower: lower,
                });
            }
        }
    }
    // Prefer longer alias on equal position
    entries.sort_by_key(|e| std::cmp::Reverse(e.alias_bytes));

    let lower_text = text.to_lowercase();
    let mut matched_ids: Vec<String> = Vec::new();
    let mut seen: HashSet<usize> = HashSet::new();
    let mut cursor = 0usize;

    while let Some(rel_at) = lower_text[cursor..].find('@') {
        let at_pos = cursor + rel_at;
        let after_at = at_pos + 1;
        if after_at >= lower_text.len() {
            break;
        }
        if !is_valid_before_at(&lower_text, at_pos) {
            cursor = after_at;
            continue;
        }

        let rest = &lower_text[after_at..];
        let mut best: Option<&AliasEntry> = None;
        for entry in &entries {
            if rest.starts_with(&entry.alias_lower) {
                let end_idx = after_at + entry.alias_lower.len();
                if is_valid_after_alias(&lower_text, end_idx, &entry.alias_lower) {
                    best = Some(entry);
                    break;
                }
            }
        }

        if let Some(hit) = best {
            if seen.insert(hit.char_idx) {
                matched_ids.push(members[hit.char_idx].id.clone());
            }
            cursor = after_at + hit.alias_lower.len();
        } else {
            cursor = after_at;
        }
    }

    matched_ids
}

#[derive(Debug)]
pub struct GroupQueue {
    queue: VecDeque<String>,
    enqueued_total: usize,
    max_rounds: usize,
}

impl GroupQueue {
    pub fn new(user_text: &str, members: &[Character], max_rounds: i64) -> Self {
        let cap = max_rounds.clamp(1, 12) as usize;
        let mentioned = find_mentions(user_text, members);
        let initial: Vec<String> = if !mentioned.is_empty() {
            mentioned
        } else if !members.is_empty() {
            vec![members[0].id.clone()]
        } else {
            Vec::new()
        };

        let mut queue = VecDeque::new();
        for id in initial.into_iter().take(cap) {
            queue.push_back(id);
        }
        let enqueued_total = queue.len();
        Self {
            queue,
            enqueued_total,
            max_rounds: cap,
        }
    }

    pub fn pop_next(&mut self) -> Option<String> {
        self.queue.pop_front()
    }

    pub fn enqueue_mentions_from_reply(
        &mut self,
        reply_text: &str,
        speaker_id: &str,
        members: &[Character],
    ) {
        if self.enqueued_total >= self.max_rounds {
            return;
        }
        let hits = find_mentions(reply_text, members);
        for target_id in hits {
            if target_id == speaker_id {
                continue;
            }
            if self.enqueued_total >= self.max_rounds {
                break;
            }
            if !self.queue.iter().any(|q| q == &target_id) {
                self.queue.push_back(target_id);
                self.enqueued_total += 1;
            }
        }
    }

    pub fn is_limited(&self) -> bool {
        self.enqueued_total >= self.max_rounds && !self.queue.is_empty()
    }
}
