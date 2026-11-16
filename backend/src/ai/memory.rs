use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, Utc};
use reqwest::Client;
use rusqlite::{Connection, OptionalExtension};

use crate::ai::context::memory_category;
use crate::ai::embeddings::recall_vector_scores;
use crate::crypto::CryptoService;
use crate::db::Db;
use crate::error::AppResult;
use crate::mappers::parse_string_list;
use crate::models::{
    MemoryKind, MemoryRecallResult, PlatformSettings, iso_from_utc, new_id, now_iso,
};

const MAX_AUTO_MEMORIES_PER_PAIR: usize = 400;

pub const STRUCTURED_MEMORY_PROMPT: &str = r#"请分析以上对话中值得长期记住的关于用户、关系、约定、偏好或重要经历的信息，输出 JSON 数组。
每条记忆格式为：
{"kind":"fact|preference|relationship|event|plan|note","content":"用简洁第三人称写明具体事实","importance":0.1到1.0,"tags":["标签1"]}
要求：
1. 只提取确实出现的新信息或重要变化，没有新内容时返回 []。
2. 不要记录寒暄或临时废话，不要编造对话里没有的信息。
3. 直接输出合法 JSON 数组，不要输出多余说明。"#;

#[derive(Debug, Clone)]
pub struct StructuredMemoryItem {
    pub kind: MemoryKind,
    pub content: String,
    pub importance: f64,
    pub tags: Vec<String>,
    pub ttl_days: Option<i64>,
}

fn is_cjk(c: char) -> bool {
    matches!(
        c as u32,
        0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0x3040..=0x30FF | 0xAC00..=0xD7AF
    )
}

pub fn query_terms(text: &str) -> (Vec<String>, Vec<String>) {
    // Returns (all_terms, fts_trigram_terms)
    let mut terms: Vec<String> = Vec::new();
    let mut trigrams: Vec<String> = Vec::new();
    let mut seen = HashSet::new();

    // ASCII words
    let mut ascii_buf = String::new();
    let mut cjk_run: Vec<char> = Vec::new();

    let flush_ascii = |buf: &mut String, out: &mut Vec<String>, tri: &mut Vec<String>, seen: &mut HashSet<String>| {
        if buf.len() >= 2 {
            let low = buf.to_ascii_lowercase();
            if seen.insert(low.clone()) {
                if low.len() >= 3 {
                    tri.push(low.clone());
                }
                out.push(low);
            }
        }
        buf.clear();
    };

    let flush_cjk = |run: &mut Vec<char>, out: &mut Vec<String>, tri: &mut Vec<String>, seen: &mut HashSet<String>| {
        if run.len() >= 2 {
            for win in run.windows(2) {
                let s: String = win.iter().collect();
                if seen.insert(s.clone()) {
                    out.push(s);
                }
            }
        }
        if run.len() >= 3 {
            for win in run.windows(3) {
                let s: String = win.iter().collect();
                if seen.insert(format!("tri:{s}")) {
                    tri.push(s);
                }
            }
        }
        if run.len() == 1 {
            let s: String = run.iter().collect();
            if seen.insert(s.clone()) {
                out.push(s);
            }
        }
        run.clear();
    };

    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            flush_cjk(&mut cjk_run, &mut terms, &mut trigrams, &mut seen);
            ascii_buf.push(ch);
        } else if is_cjk(ch) {
            flush_ascii(&mut ascii_buf, &mut terms, &mut trigrams, &mut seen);
            cjk_run.push(ch);
        } else {
            flush_ascii(&mut ascii_buf, &mut terms, &mut trigrams, &mut seen);
            flush_cjk(&mut cjk_run, &mut terms, &mut trigrams, &mut seen);
        }
    }
    flush_ascii(&mut ascii_buf, &mut terms, &mut trigrams, &mut seen);
    flush_cjk(&mut cjk_run, &mut terms, &mut trigrams, &mut seen);

    terms.truncate(32);
    trigrams.truncate(16);
    (terms, trigrams)
}

fn normalized_bigrams(text: &str) -> HashSet<String> {
    let chars: Vec<char> = text
        .chars()
        .filter(|c| !c.is_whitespace() && !c.is_ascii_punctuation())
        .flat_map(|c| c.to_lowercase())
        .collect();
    if chars.len() < 2 {
        return chars.into_iter().map(|c| c.to_string()).collect();
    }
    chars.windows(2).map(|w| w.iter().collect()).collect()
}

pub fn similarity(a: &str, b: &str) -> f64 {
    let trim_a = a.trim();
    let trim_b = b.trim();
    if trim_a.is_empty() || trim_b.is_empty() {
        return 0.0;
    }
    if trim_a == trim_b {
        return 1.0;
    }
    let set_a = normalized_bigrams(trim_a);
    let set_b = normalized_bigrams(trim_b);
    if set_a.is_empty() || set_b.is_empty() {
        return 0.0;
    }
    let inter = set_a.intersection(&set_b).count();
    let union = set_a.union(&set_b).count();
    if union == 0 {
        0.0
    } else {
        inter as f64 / union as f64
    }
}

pub fn parse_structured_memories(raw: &str) -> Vec<StructuredMemoryItem> {
    let mut candidate = raw.trim();
    if let Some(stripped) = candidate.strip_prefix("```") {
        let after_lang = stripped
            .split_once('\n')
            .map(|(_, rest)| rest)
            .unwrap_or(stripped);
        candidate = after_lang.trim_end_matches("```").trim();
    }

    let json_slice = if let (Some(start), Some(end)) = (candidate.find('['), candidate.rfind(']')) {
        if start < end {
            &candidate[start..=end]
        } else {
            candidate
        }
    } else {
        candidate
    };

    let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(json_slice)
    else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for item in items {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let content = obj
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if content.chars().count() < 3 {
            continue;
        }
        let kind_str = obj
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let kind = if kind_str.is_empty() {
            memory_category(&content)
        } else {
            MemoryKind::from_db(&kind_str.to_ascii_lowercase())
        };
        let importance = obj
            .get("importance")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.6)
            .clamp(0.1, 1.0);
        let tags: Vec<String> = obj
            .get("tags")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| t.as_str().map(|s| s.trim().to_string()))
                    .filter(|s| !s.is_empty())
                    .take(5)
                    .collect()
            })
            .unwrap_or_default();
        let ttl_days = obj
            .get("ttlDays")
            .and_then(|v| v.as_i64())
            .filter(|&d| d > 0 && d <= 3650);

        out.push(StructuredMemoryItem {
            kind,
            content: content.chars().take(500).collect(),
            importance,
            tags,
            ttl_days,
        });
    }
    out
}

pub fn upsert_auto_memory(
    db: &Db,
    user_id: &str,
    character_id: &str,
    item: &StructuredMemoryItem,
    source_message_id: Option<&str>,
) -> AppResult<String> {
    let content = item.content.trim();
    if content.is_empty() {
        return Ok(String::new());
    }
    let now = Utc::now();
    let now_str = iso_from_utc(now);
    let expires_at = item
        .ttl_days
        .map(|d| iso_from_utc(now + Duration::days(d)));

    db.write(|tx| {
        let mut stmt = tx.prepare(
            "SELECT id, content, importance, tags FROM memories
             WHERE user_id=? AND character_id=? AND status='active' AND source='auto'",
        )?;
        let existing: Vec<(String, String, f64, String)> = stmt
            .query_map(rusqlite::params![user_id, character_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        let mut best_match: Option<(String, String, f64, String, f64)> = None;
        for (id, old_content, old_imp, old_tags) in existing {
            let sim = similarity(&old_content, content);
            if sim >= 0.82 {
                if best_match
                    .as_ref()
                    .map(|(_, _, _, _, s)| sim > *s)
                    .unwrap_or(true)
                {
                    best_match = Some((id, old_content, old_imp, old_tags, sim));
                }
            }
        }

        if let Some((old_id, old_content, old_imp, old_tags_raw, _)) = best_match {
            let mut merged_tags = parse_string_list(&old_tags_raw);
            for t in &item.tags {
                if !merged_tags.contains(t) && merged_tags.len() < 8 {
                    merged_tags.push(t.clone());
                }
            }
            let merged_tags_json = serde_json::to_string(&merged_tags).unwrap_or_else(|_| "[]".into());
            let next_imp = old_imp.max(item.importance);
            let next_content = if content.chars().count() >= old_content.chars().count() {
                content
            } else {
                &old_content
            };
            tx.execute(
                "UPDATE memories
                 SET content=?, kind=?, importance=?, tags=?, expires_at=COALESCE(?,expires_at), updated_at=?
                 WHERE id=?",
                rusqlite::params![
                    next_content,
                    item.kind.as_str(),
                    next_imp,
                    merged_tags_json,
                    expires_at,
                    now_str,
                    old_id
                ],
            )?;
            if next_content != old_content {
                tx.execute(
                    "UPDATE memory_vectors SET status='pending', updated_at=? WHERE memory_id=?",
                    rusqlite::params![now_str, old_id],
                )?;
            }
            return Ok(old_id);
        }

        let id = new_id();
        let tags_json = serde_json::to_string(&item.tags).unwrap_or_else(|_| "[]".into());
        tx.execute(
            "INSERT OR IGNORE INTO memories(
                id, user_id, character_id, content, source, source_message_id,
                kind, importance, status, access_count, tags, expires_at, created_at, updated_at
             ) VALUES(?,?,?,?, 'auto', ?, ?, ?, 'active', 0, ?, ?, ?, ?)",
            rusqlite::params![
                id,
                user_id,
                character_id,
                content,
                source_message_id,
                item.kind.as_str(),
                item.importance,
                tags_json,
                expires_at,
                now_str,
                now_str
            ],
        )?;

        let changed = tx.changes();
        if changed > 0 {
            tx.execute(
                "INSERT OR IGNORE INTO memory_vectors(memory_id, status, updated_at) VALUES(?, 'pending', ?)",
                rusqlite::params![id, now_str],
            )?;
        }

        // Enforce 400 active auto memories per (user_id, character_id)
        let active_auto: i64 = tx.query_row(
            "SELECT COUNT(*) FROM memories WHERE user_id=? AND character_id=? AND source='auto' AND status='active'",
            rusqlite::params![user_id, character_id],
            |r| r.get(0),
        )?;
        if active_auto as usize > MAX_AUTO_MEMORIES_PER_PAIR {
            let excess = active_auto - MAX_AUTO_MEMORIES_PER_PAIR as i64;
            tx.execute(
                "UPDATE memories SET status='archived', updated_at=?
                 WHERE id IN (
                   SELECT id FROM memories
                   WHERE user_id=? AND character_id=? AND source='auto' AND status='active'
                   ORDER BY importance ASC, updated_at ASC
                   LIMIT ?
                 )",
                rusqlite::params![now_str, user_id, character_id, excess],
            )?;
        }

        Ok(id)
    })
}

pub fn remember_explicit(
    db: &Db,
    user_id: &str,
    character_id: &str,
    content: &str,
    kind: MemoryKind,
    source_message_id: Option<&str>,
) -> AppResult<Option<String>> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let now = now_iso();
    db.write(|tx| {
        if let Some(msg_id) = source_message_id {
            let existing: Option<String> = tx
                .query_row(
                    "SELECT id FROM memories WHERE user_id=? AND character_id=? AND source_message_id=?",
                    rusqlite::params![user_id, character_id, msg_id],
                    |r| r.get(0),
                )
                .optional()?;
            if existing.is_some() {
                return Ok(existing);
            }
        }
        let id = new_id();
        tx.execute(
            "INSERT INTO memories(
                id, user_id, character_id, content, source, source_message_id,
                kind, importance, status, access_count, tags, created_at, updated_at
             ) VALUES(?,?,?,?, 'manual', ?, ?, 0.78, 'active', 0, '[]', ?, ?)",
            rusqlite::params![
                id,
                user_id,
                character_id,
                trimmed,
                source_message_id,
                kind.as_str(),
                now,
                now
            ],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO memory_vectors(memory_id, status, updated_at) VALUES(?, 'pending', ?)",
            rusqlite::params![id, now],
        )?;
        Ok(Some(id))
    })
}

#[derive(Debug, Clone)]
struct MemoryRow {
    id: String,
    content: String,
    source: String,
    kind: MemoryKind,
    importance: f64,
    access_count: i64,
    updated_at: String,
}

fn load_active_memories(conn: &Connection, user_id: &str, character_id: &str) -> AppResult<Vec<MemoryRow>> {
    let now = now_iso();
    let mut stmt = conn.prepare(
        "SELECT id, content, source, kind, importance, access_count, updated_at
         FROM memories
         WHERE user_id=? AND character_id=? AND status='active'
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY updated_at DESC",
    )?;
    let rows = stmt
        .query_map(rusqlite::params![user_id, character_id, now], |r| {
            Ok(MemoryRow {
                id: r.get(0)?,
                content: r.get(1)?,
                source: r.get(2)?,
                kind: MemoryKind::from_db(&r.get::<_, String>(3)?),
                importance: r.get::<_, Option<f64>>(4)?.unwrap_or(0.5),
                access_count: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                updated_at: r.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn fts5_recall_ids(
    conn: &Connection,
    user_id: &str,
    character_id: &str,
    trigrams: &[String],
) -> HashSet<String> {
    let mut matched = HashSet::new();
    if trigrams.is_empty() {
        return matched;
    }
    let query_expr = trigrams
        .iter()
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ");
    let Ok(mut stmt) = conn.prepare(
        "SELECT m.id
         FROM memories_fts f
         JOIN memories m ON m.id = f.memory_id
         WHERE f.content MATCH ? AND m.user_id=? AND m.character_id=? AND m.status='active'
         LIMIT 40",
    ) else {
        return matched;
    };
    if let Ok(rows) = stmt.query_map(rusqlite::params![query_expr, user_id, character_id], |r| {
        r.get::<_, String>(0)
    }) {
        for r in rows.flatten() {
            matched.insert(r);
        }
    }
    matched
}

pub async fn hybrid_recall(
    db: &Db,
    crypto: &CryptoService,
    http: &Client,
    user_id: &str,
    character_id: &str,
    query: &str,
    settings: &PlatformSettings,
    mark_accessed: bool,
) -> AppResult<Vec<MemoryRecallResult>> {
    let top_k = settings.memory_recall_top_k.clamp(1, 20) as usize;
    let kw_weight = settings.memory_keyword_weight.clamp(0.0, 1.0);
    let vec_weight = 1.0 - kw_weight;

    let (terms, trigrams) = query_terms(query);
    let (active_rows, fts_ids) = db.read(|conn| {
        let rows = load_active_memories(conn, user_id, character_id)?;
        let fts = fts5_recall_ids(conn, user_id, character_id, &trigrams);
        Ok((rows, fts))
    })?;

    if active_rows.is_empty() {
        return Ok(Vec::new());
    }

    let vector_scores =
        recall_vector_scores(db, crypto, http, user_id, character_id, query).await;

    let now = Utc::now();
    struct ScoredCandidate {
        row: MemoryRow,
        relevance: f64,
        routes: Vec<String>,
    }

    let mut candidates: Vec<ScoredCandidate> = Vec::new();
    for row in active_rows {
        let lower_content = row.content.to_lowercase();
        let mut hit_terms = 0usize;
        for t in &terms {
            if lower_content.contains(t.as_str()) {
                hit_terms += 1;
            }
        }
        let kw_ratio = if terms.is_empty() {
            0.0
        } else {
            (hit_terms as f64 / (terms.len().min(6) as f64)).min(1.0)
        };
        let fts_hit = fts_ids.contains(&row.id);
        let kw_score = (kw_ratio * 0.8 + if fts_hit { 0.25 } else { 0.0 }).min(1.0);

        let vec_score = vector_scores.get(&row.id).copied().unwrap_or(0.0);

        let age_days = DateTime::parse_from_rfc3339(&row.updated_at)
            .map(|d| (now - d.with_timezone(&Utc)).num_hours() as f64 / 24.0)
            .unwrap_or(0.0)
            .max(0.0);
        let recency = (-age_days / 30.0).exp();
        let access_boost = ((row.access_count as f64).ln_1p() / 4.0).min(0.25);

        let mut routes = Vec::new();
        if fts_hit {
            routes.push("fts".to_string());
        } else if hit_terms > 0 {
            routes.push("keyword".to_string());
        }
        if vec_score > 0.0 {
            routes.push("vector".to_string());
        }
        if row.source == "manual" && row.importance >= 0.7 {
            routes.push("pinned".to_string());
        }

        if routes.is_empty() && row.importance < 0.65 && row.source != "manual" {
            continue;
        }

        let match_signal = if vector_scores.is_empty() {
            kw_score
        } else {
            kw_score * kw_weight + vec_score * vec_weight
        };
        let manual_boost = if row.source == "manual" { 0.14 } else { 0.0 };
        let relevance =
            match_signal * 0.68 + row.importance * 0.20 + recency * 0.12 + access_boost * 0.10 + manual_boost;

        if routes.is_empty() {
            routes.push("salient".to_string());
        }

        candidates.push(ScoredCandidate {
            row,
            relevance,
            routes,
        });
    }

    // Top 40 by relevance before MMR
    candidates.sort_by(|a, b| {
        b.relevance
            .partial_cmp(&a.relevance)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    candidates.truncate(40);

    // MMR diversity selection
    let lambda = 0.72_f64;
    let mut selected: Vec<MemoryRecallResult> = Vec::with_capacity(top_k);
    let mut pool = candidates;

    while selected.len() < top_k && !pool.is_empty() {
        let mut best_idx = 0usize;
        let mut best_mmr = f64::NEG_INFINITY;
        for (idx, cand) in pool.iter().enumerate() {
            let max_sim = selected
                .iter()
                .map(|s| similarity(&cand.row.content, &s.content))
                .fold(0.0_f64, f64::max);
            let mmr = lambda * cand.relevance - (1.0 - lambda) * max_sim;
            if mmr > best_mmr {
                best_mmr = mmr;
                best_idx = idx;
            }
        }
        let chosen = pool.swap_remove(best_idx);
        selected.push(MemoryRecallResult {
            id: chosen.row.id,
            content: chosen.row.content,
            kind: chosen.row.kind,
            importance: chosen.row.importance,
            score: best_mmr,
            relevance: chosen.relevance,
            routes: chosen.routes,
        });
    }

    if mark_accessed && !selected.is_empty() {
        let ids: Vec<String> = selected.iter().map(|m| m.id.clone()).collect();
        let now_str = now_iso();
        let _ = db.write(|tx| {
            for id in &ids {
                tx.execute(
                    "UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id=?",
                    rusqlite::params![now_str, id],
                )?;
            }
            Ok(())
        });
    }

    Ok(selected)
}

pub fn maintain_memories(
    db: &Db,
    user_id: &str,
    character_id: &str,
    settings: &PlatformSettings,
) -> AppResult<usize> {
    let now = Utc::now();
    let now_str = iso_from_utc(now);
    let decay_cutoff = iso_from_utc(now - Duration::days(14));
    let decay_rate = settings.memory_decay_rate.clamp(0.0, 0.5);
    let archive_threshold = settings.memory_archive_threshold.clamp(0.0, 1.0);

    db.write(|tx| {
        let mut archived = tx.execute(
            "UPDATE memories SET status='archived', updated_at=?
             WHERE user_id=? AND character_id=? AND status='active'
               AND expires_at IS NOT NULL AND expires_at <= ?",
            rusqlite::params![now_str, user_id, character_id, now_str],
        )?;

        if decay_rate > 0.0 {
            let mut stmt = tx.prepare(
                "SELECT id, importance, access_count, last_accessed_at, updated_at
                 FROM memories
                 WHERE user_id=? AND character_id=? AND source='auto' AND status='active'
                   AND COALESCE(last_accessed_at, updated_at) < ?",
            )?;
            let stale: Vec<(String, f64, i64, String)> = stmt
                .query_map(rusqlite::params![user_id, character_id, decay_cutoff], |r| {
                    Ok((
                        r.get(0)?,
                        r.get::<_, Option<f64>>(1)?.unwrap_or(0.5),
                        r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                        r.get::<_, Option<String>>(3)?
                            .unwrap_or_else(|| r.get::<_, String>(4).unwrap_or_default()),
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(stmt);

            for (id, importance, access_count, ref_ts) in stale {
                let age_days = DateTime::parse_from_rfc3339(&ref_ts)
                    .map(|d| (now - d.with_timezone(&Utc)).num_days().max(14) as f64)
                    .unwrap_or(14.0);
                let overdue_weeks = ((age_days - 14.0) / 7.0).max(0.5);
                let resistance = 1.0 + (access_count as f64).ln_1p() * 0.4;
                let decayed = importance * (1.0 - decay_rate).powf(overdue_weeks / resistance);
                if decayed < archive_threshold {
                    archived += tx.execute(
                        "UPDATE memories SET status='archived', importance=?, updated_at=? WHERE id=?",
                        rusqlite::params![decayed.max(0.01), now_str, id],
                    )?;
                } else {
                    tx.execute(
                        "UPDATE memories SET importance=? WHERE id=?",
                        rusqlite::params![decayed, id],
                    )?;
                }
            }
        }

        tx.execute(
            "INSERT INTO memory_summary_state(user_id,character_id,last_event_seq,pending_through_seq,maintained_at,updated_at)
             VALUES(?,?,0,0,?,?)
             ON CONFLICT(user_id,character_id) DO UPDATE SET maintained_at=excluded.maintained_at, updated_at=excluded.updated_at",
            rusqlite::params![user_id, character_id, now_str, now_str],
        )?;

        Ok(archived)
    })
}

pub fn count_active_memories_map(
    conn: &Connection,
    user_id: &str,
) -> AppResult<HashMap<String, i64>> {
    let mut map = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT character_id, COUNT(*) FROM memories WHERE user_id=? AND status='active' GROUP BY character_id",
    )?;
    let mut rows = stmt.query(rusqlite::params![user_id])?;
    while let Some(r) = rows.next()? {
        map.insert(r.get(0)?, r.get(1)?);
    }
    Ok(map)
}
