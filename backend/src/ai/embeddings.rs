use std::collections::HashMap;
use std::time::{Duration, Instant};

use chrono::{Duration as ChronoDuration, Utc};
use futures_util::stream::{self, StreamExt};
use reqwest::Client;
use rusqlite::{Connection, OptionalExtension, params_from_iter, types::Value as SqlValue};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::ai::protocols::{apply_auth_headers, validate_provider_url};
use crate::audit::{AuditBeginInput, AuditFinishInput, begin_audit, finish_audit};
use crate::crypto::CryptoService;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::models::{EmbeddingConfig, Protocol, iso_from_utc, now_iso};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredEmbeddingConfig {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    model_id: String,
    #[serde(default = "default_top_k")]
    top_k: i64,
    #[serde(default = "default_min_sim")]
    min_similarity: f64,
}

fn default_top_k() -> i64 {
    6
}

fn default_min_sim() -> f64 {
    0.3
}

impl Default for StoredEmbeddingConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            model_id: String::new(),
            top_k: 6,
            min_similarity: 0.3,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedEmbeddingConfig {
    pub public: EmbeddingConfig,
    pub api_key: String,
    pub fingerprint: String,
}

pub fn sha256_hex(text: &str) -> String {
    let mut h = Sha256::new();
    h.update(text.as_bytes());
    hex::encode(h.finalize())
}

pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0_f64;
    let mut na = 0.0_f64;
    let mut nb = 0.0_f64;
    for (&x, &y) in a.iter().zip(b.iter()) {
        let xf = f64::from(x);
        let yf = f64::from(y);
        dot += xf * yf;
        na += xf * xf;
        nb += yf * yf;
    }
    let denom = na.sqrt() * nb.sqrt();
    if denom <= 1e-12 {
        0.0
    } else {
        (dot / denom).clamp(-1.0, 1.0)
    }
}

fn read_stored_embedding(conn: &Connection) -> StoredEmbeddingConfig {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key='embeddingConfig'",
            [],
            |r| r.get(0),
        )
        .optional()
        .unwrap_or(None);
    raw.and_then(|s| serde_json::from_str::<StoredEmbeddingConfig>(&s).ok())
        .unwrap_or_default()
}

#[derive(Debug, Clone)]
struct EmbeddingModelRow {
    model_id: String,
    supplier_id: String,
    supplier_name: Option<String>,
    supplier_active: bool,
    model_active: bool,
    protocol: String,
    base_url: String,
    api_key_enc: String,
    model: String,
}

fn load_embedding_model_row(conn: &Connection, model_id: &str) -> AppResult<Option<EmbeddingModelRow>> {
    if model_id.trim().is_empty() {
        return Ok(None);
    }
    conn.query_row(
        "SELECT p.id, p.supplier_id, s.name, s.active, s.deleted_at, p.active,
                s.protocol, s.base_url, s.api_key, p.model
         FROM providers p
         JOIN suppliers s ON s.id = p.supplier_id
         WHERE p.id=? AND p.deleted_at IS NULL AND p.kind='embedding'",
        rusqlite::params![model_id],
        |r| {
            let s_active: i64 = r.get(3)?;
            let s_deleted: Option<String> = r.get(4)?;
            let m_active: i64 = r.get(5)?;
            Ok(EmbeddingModelRow {
                model_id: r.get(0)?,
                supplier_id: r.get(1)?,
                supplier_name: r.get(2)?,
                supplier_active: s_active != 0 && s_deleted.is_none(),
                model_active: m_active != 0,
                protocol: r.get(6)?,
                base_url: r.get(7)?,
                api_key_enc: r.get(8)?,
                model: r.get(9)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

pub fn get_embedding_config(conn: &Connection) -> AppResult<EmbeddingConfig> {
    let stored = read_stored_embedding(conn);
    let model_row = load_embedding_model_row(conn, &stored.model_id)?;
    Ok(match model_row {
        Some(m) => EmbeddingConfig {
            model_id: m.model_id,
            supplier_id: m.supplier_id,
            supplier_name: m.supplier_name,
            supplier_active: m.supplier_active,
            protocol: m.protocol,
            enabled: stored.enabled && m.supplier_active && m.model_active,
            base_url: m.base_url,
            model: m.model,
            has_key: !m.api_key_enc.is_empty(),
            top_k: stored.top_k.clamp(1, 20),
            min_similarity: stored.min_similarity.clamp(0.0, 0.99),
        },
        None => EmbeddingConfig {
            model_id: String::new(),
            supplier_id: String::new(),
            supplier_name: None,
            supplier_active: false,
            protocol: "openai-completions".to_string(),
            enabled: false,
            base_url: String::new(),
            model: String::new(),
            has_key: false,
            top_k: stored.top_k.clamp(1, 20),
            min_similarity: stored.min_similarity.clamp(0.0, 0.99),
        },
    })
}

pub fn resolve_embedding_config(
    conn: &Connection,
    crypto: &CryptoService,
) -> AppResult<Option<ResolvedEmbeddingConfig>> {
    let stored = read_stored_embedding(conn);
    let Some(m) = load_embedding_model_row(conn, &stored.model_id)? else {
        return Ok(None);
    };
    let api_key = if m.api_key_enc.is_empty() {
        String::new()
    } else {
        crypto.decrypt(&m.api_key_enc)?
    };
    let fingerprint = sha256_hex(&format!(
        "{}|{}|{}",
        m.protocol,
        m.base_url.trim().trim_end_matches('/'),
        m.model.trim()
    ));
    let public = EmbeddingConfig {
        model_id: m.model_id,
        supplier_id: m.supplier_id,
        supplier_name: m.supplier_name,
        supplier_active: m.supplier_active,
        protocol: m.protocol,
        enabled: stored.enabled && m.supplier_active && m.model_active && !m.base_url.trim().is_empty(),
        base_url: m.base_url,
        model: m.model,
        has_key: !api_key.is_empty(),
        top_k: stored.top_k.clamp(1, 20),
        min_similarity: stored.min_similarity.clamp(0.0, 0.99),
    };
    Ok(Some(ResolvedEmbeddingConfig {
        public,
        api_key,
        fingerprint,
    }))
}

pub fn update_embedding_config(
    db: &Db,
    enabled: bool,
    model_id: &str,
    top_k: i64,
    min_similarity: f64,
) -> AppResult<EmbeddingConfig> {
    let trimmed_model = model_id.trim().to_string();
    let clamped_top_k = top_k.clamp(1, 20);
    let clamped_min = min_similarity.clamp(0.0, 0.99);

    db.write(|tx| {
        if !trimmed_model.is_empty() {
            let row = load_embedding_model_row(tx, &trimmed_model)?.ok_or_else(|| {
                AppError::validation("所选向量模型不存在或不属于向量类型。")
            })?;
            if row.protocol == "anthropic" {
                return Err(AppError::validation("Anthropic 协议不支持向量 Embedding。"));
            }
        } else if enabled {
            return Err(AppError::validation("启用向量记忆前请先选择一个向量模型。"));
        }

        let next = StoredEmbeddingConfig {
            enabled,
            model_id: trimmed_model,
            top_k: clamped_top_k,
            min_similarity: clamped_min,
        };
        let raw = serde_json::to_string(&next).map_err(|_| AppError::internal())?;
        tx.execute(
            "INSERT INTO settings(key,value) VALUES('embeddingConfig',?)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            rusqlite::params![raw],
        )?;
        get_embedding_config(tx)
    })
}

fn embedding_endpoint(protocol: Protocol, base_url: &str, model: &str) -> AppResult<String> {
    let base = validate_provider_url(base_url)?;
    match protocol {
        Protocol::Gemini => {
            if base.contains(":embedContent") {
                return Ok(base);
            }
            let versioned = if base.ends_with("/v1beta") || base.ends_with("/v1") {
                base
            } else {
                format!("{base}/v1beta")
            };
            Ok(format!("{versioned}/models/{model}:embedContent"))
        }
        Protocol::OpenAiCompletions | Protocol::OpenAiResponses => {
            if base.ends_with("/embeddings") {
                Ok(base)
            } else {
                Ok(format!("{base}/embeddings"))
            }
        }
        Protocol::Anthropic => Err(AppError::validation("Anthropic 协议不支持向量生成。")),
    }
}

pub async fn embed_texts(
    db: &Db,
    http: &Client,
    cfg: &EmbeddingConfig,
    api_key: &str,
    texts: &[String],
    user_id: Option<&str>,
) -> AppResult<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let proto = Protocol::from_db(&cfg.protocol);
    let endpoint = embedding_endpoint(proto, &cfg.base_url, &cfg.model)?;

    if proto == Protocol::Gemini {
        let sem_results: Vec<AppResult<Vec<f32>>> = stream::iter(texts.iter().cloned().enumerate())
            .map(|(idx, text)| {
                let endpoint = endpoint.clone();
                let model = cfg.model.clone();
                let supplier_id = cfg.supplier_id.clone();
                let supplier_name = cfg.supplier_name.clone();
                let model_id = cfg.model_id.clone();
                let api_key = api_key.to_string();
                let user_id = user_id.map(ToString::to_string);
                async move {
                    let started = Instant::now();
                    let payload = json!({
                        "model": if model.starts_with("models/") { model.clone() } else { format!("models/{model}") },
                        "content": { "parts": [{ "text": text }] }
                    });
                    let audit = begin_audit(
                        db,
                        AuditBeginInput {
                            kind: "embedding".to_string(),
                            user_id,
                            user_name: None,
                            conversation_id: None,
                            character_id: None,
                            character_name: None,
                            supplier_id: Some(supplier_id),
                            supplier_name,
                            model_id: Some(model_id),
                            protocol: "gemini".to_string(),
                            model: cfg.model.clone(),
                            endpoint: endpoint.clone(),
                            request_id: Some(format!("emb-{idx}")),
                            attempt: 1,
                            request_body: Some(payload.clone()),
                        },
                    );
                    let audit_id = audit.as_ref().map(|(i, _)| i.clone());
                    let capture = audit.as_ref().map(|(_, c)| *c).unwrap_or(false);

                    let req = apply_auth_headers(
                        http.post(&endpoint)
                            .timeout(Duration::from_secs(30))
                            .header("content-type", "application/json"),
                        Protocol::Gemini,
                        &api_key,
                    )
                    .json(&payload);

                    let resp = req.send().await.map_err(|err| {
                        finish_audit(
                            db,
                            audit_id.as_deref(),
                            capture,
                            AuditFinishInput {
                                status: "failed".to_string(),
                                duration_ms: Some(started.elapsed().as_millis() as i64),
                                error_code: Some("EMBED_NETWORK_ERROR".to_string()),
                                error_message: Some(err.to_string()),
                                ..Default::default()
                            },
                        );
                        AppError::service_unavailable("EMBEDDING_FAILED", format!("向量请求失败：{err}"))
                    })?;
                    let code = i64::from(resp.status().as_u16());
                    let ok = resp.status().is_success();
                    let text_body = resp.text().await.unwrap_or_default();
                    let dur = started.elapsed().as_millis() as i64;
                    if !ok {
                        finish_audit(
                            db,
                            audit_id.as_deref(),
                            capture,
                            AuditFinishInput {
                                status: "failed".to_string(),
                                http_status: Some(code),
                                duration_ms: Some(dur),
                                error_code: Some(format!("HTTP_{code}")),
                                error_message: Some(text_body.chars().take(300).collect()),
                                response_body: Some(text_body),
                                ..Default::default()
                            },
                        );
                        return Err(AppError::service_unavailable(
                            "EMBEDDING_FAILED",
                            format!("向量服务返回错误（HTTP {code}）。"),
                        ));
                    }
                    let val: Value = serde_json::from_str(&text_body).map_err(|_| {
                        AppError::service_unavailable("EMBEDDING_FAILED", "向量响应 JSON 无效。")
                    })?;
                    let values = val
                        .pointer("/embedding/values")
                        .and_then(|v| v.as_array())
                        .ok_or_else(|| {
                            AppError::service_unavailable("EMBEDDING_FAILED", "向量响应缺少 embedding.values。")
                        })?;
                    let vec: Vec<f32> = values
                        .iter()
                        .filter_map(|v| v.as_f64().map(|f| f as f32))
                        .collect();
                    finish_audit(
                        db,
                        audit_id.as_deref(),
                        capture,
                        AuditFinishInput {
                            status: "success".to_string(),
                            http_status: Some(code),
                            duration_ms: Some(dur),
                            response_body: Some(text_body),
                            ..Default::default()
                        },
                    );
                    Ok(vec)
                }
            })
            .buffered(4)
            .collect()
            .await;

        let mut out = Vec::with_capacity(sem_results.len());
        for r in sem_results {
            out.push(r?);
        }
        return Ok(out);
    }

    // OpenAI compatible batch call
    let started = Instant::now();
    let payload = json!({
        "model": cfg.model,
        "input": texts
    });
    let audit = begin_audit(
        db,
        AuditBeginInput {
            kind: "embedding".to_string(),
            user_id: user_id.map(ToString::to_string),
            user_name: None,
            conversation_id: None,
            character_id: None,
            character_name: None,
            supplier_id: Some(cfg.supplier_id.clone()),
            supplier_name: cfg.supplier_name.clone(),
            model_id: Some(cfg.model_id.clone()),
            protocol: cfg.protocol.clone(),
            model: cfg.model.clone(),
            endpoint: endpoint.clone(),
            request_id: None,
            attempt: 1,
            request_body: Some(payload.clone()),
        },
    );
    let audit_id = audit.as_ref().map(|(i, _)| i.clone());
    let capture = audit.as_ref().map(|(_, c)| *c).unwrap_or(false);

    let req = apply_auth_headers(
        http.post(&endpoint)
            .timeout(Duration::from_secs(30))
            .header("content-type", "application/json"),
        proto,
        api_key,
    )
    .json(&payload);

    let resp = req.send().await.map_err(|err| {
        finish_audit(
            db,
            audit_id.as_deref(),
            capture,
            AuditFinishInput {
                status: "failed".to_string(),
                duration_ms: Some(started.elapsed().as_millis() as i64),
                error_code: Some("EMBED_NETWORK_ERROR".to_string()),
                error_message: Some(err.to_string()),
                ..Default::default()
            },
        );
        AppError::service_unavailable("EMBEDDING_FAILED", format!("向量请求失败：{err}"))
    })?;
    let code = i64::from(resp.status().as_u16());
    let ok = resp.status().is_success();
    let body_text = resp.text().await.unwrap_or_default();
    let dur = started.elapsed().as_millis() as i64;
    if !ok {
        finish_audit(
            db,
            audit_id.as_deref(),
            capture,
            AuditFinishInput {
                status: "failed".to_string(),
                http_status: Some(code),
                duration_ms: Some(dur),
                error_code: Some(format!("HTTP_{code}")),
                error_message: Some(body_text.chars().take(300).collect()),
                response_body: Some(body_text),
                ..Default::default()
            },
        );
        return Err(AppError::service_unavailable(
            "EMBEDDING_FAILED",
            format!("向量服务返回错误（HTTP {code}）。"),
        ));
    }
    let val: Value = serde_json::from_str(&body_text).map_err(|_| {
        AppError::service_unavailable("EMBEDDING_FAILED", "向量响应 JSON 无效。")
    })?;
    let in_tok = val.pointer("/usage/prompt_tokens").and_then(|v| v.as_i64());
    let mut items = val
        .get("data")
        .and_then(|v| v.as_array())
        .ok_or_else(|| AppError::service_unavailable("EMBEDDING_FAILED", "向量响应缺少 data 数组。"))?
        .clone();
    items.sort_by_key(|item| item.get("index").and_then(|v| v.as_i64()).unwrap_or(0));

    let mut vectors = Vec::with_capacity(items.len());
    for item in items {
        let arr = item
            .get("embedding")
            .and_then(|v| v.as_array())
            .ok_or_else(|| {
                AppError::service_unavailable("EMBEDDING_FAILED", "向量条目缺少 embedding 字段。")
            })?;
        vectors.push(
            arr.iter()
                .filter_map(|v| v.as_f64().map(|f| f as f32))
                .collect(),
        );
    }

    finish_audit(
        db,
        audit_id.as_deref(),
        capture,
        AuditFinishInput {
            status: "success".to_string(),
            http_status: Some(code),
            duration_ms: Some(dur),
            input_tokens: in_tok,
            response_body: Some(body_text),
            ..Default::default()
        },
    );
    Ok(vectors)
}

pub async fn sync_pair_vectors(
    db: &Db,
    crypto: &CryptoService,
    http: &Client,
    user_id: &str,
    character_id: &str,
    max_batch: usize,
) -> Option<ResolvedEmbeddingConfig> {
    let resolved = db
        .read(|conn| resolve_embedding_config(conn, crypto))
        .ok()
        .flatten()?;
    if !resolved.public.enabled {
        return None;
    }

    let retry_cutoff = iso_from_utc(Utc::now() - ChronoDuration::minutes(5));
    let pending: Vec<(String, String, String)> = db
        .read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT m.id, m.content
                 FROM memories m
                 LEFT JOIN memory_vectors v ON v.memory_id = m.id
                 WHERE m.user_id=? AND m.character_id=? AND m.status='active'
                   AND (
                     v.memory_id IS NULL
                     OR v.status='pending'
                     OR COALESCE(v.fingerprint,'') != ?
                     OR COALESCE(v.content_hash,'') = ''
                     OR (v.status='failed' AND v.updated_at < ?)
                   )
                 LIMIT ?",
            )?;
            let rows = stmt
                .query_map(
                    rusqlite::params![
                        user_id,
                        character_id,
                        resolved.fingerprint,
                        retry_cutoff,
                        max_batch as i64
                    ],
                    |r| {
                        let id: String = r.get(0)?;
                        let content: String = r.get(1)?;
                        let chash = sha256_hex(&content);
                        Ok((id, content, chash))
                    },
                )?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .unwrap_or_default();

    // Also inspect any rows where content_hash differs from sha256(content)
    let mut to_embed = pending;
    if to_embed.len() < max_batch {
        let extra: Vec<(String, String, String)> = db
            .read(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT m.id, m.content, COALESCE(v.content_hash,'')
                     FROM memories m
                     JOIN memory_vectors v ON v.memory_id = m.id
                     WHERE m.user_id=? AND m.character_id=? AND m.status='active' AND v.status='ready'",
                )?;
                let mut out = Vec::new();
                let mut rows = stmt.query(rusqlite::params![user_id, character_id])?;
                while let Some(row) = rows.next()? {
                    let id: String = row.get(0)?;
                    let content: String = row.get(1)?;
                    let stored_hash: String = row.get(2)?;
                    let chash = sha256_hex(&content);
                    if stored_hash != chash && !to_embed.iter().any(|(eid, _, _)| eid == &id) {
                        out.push((id, content, chash));
                        if to_embed.len() + out.len() >= max_batch {
                            break;
                        }
                    }
                }
                Ok(out)
            })
            .unwrap_or_default();
        to_embed.extend(extra);
    }

    if !to_embed.is_empty() {
        let texts: Vec<String> = to_embed.iter().map(|(_, c, _)| c.clone()).collect();
        match embed_texts(
            db,
            http,
            &resolved.public,
            &resolved.api_key,
            &texts,
            Some(user_id),
        )
        .await
        {
            Ok(vecs) if vecs.len() == to_embed.len() => {
                let now = now_iso();
                let fp = resolved.fingerprint.clone();
                let _ = db.write(|tx| {
                    for ((mem_id, _, chash), vec) in to_embed.iter().zip(vecs.iter()) {
                        let dims = vec.len() as i64;
                        let vec_json = serde_json::to_string(vec).unwrap_or_else(|_| "[]".into());
                        tx.execute(
                            "INSERT INTO memory_vectors(memory_id,vector,dimensions,fingerprint,content_hash,status,error_code,updated_at)
                             VALUES(?,?,?,?,?,'ready',NULL,?)
                             ON CONFLICT(memory_id) DO UPDATE SET
                               vector=excluded.vector, dimensions=excluded.dimensions,
                               fingerprint=excluded.fingerprint, content_hash=excluded.content_hash,
                               status='ready', error_code=NULL, updated_at=excluded.updated_at",
                            rusqlite::params![mem_id, vec_json, dims, fp, chash, now],
                        )?;
                    }
                    Ok(())
                });
            }
            Err(err) => {
                let now = now_iso();
                let fp = resolved.fingerprint.clone();
                let code = err.code;
                let _ = db.write(|tx| {
                    for (mem_id, _, chash) in &to_embed {
                        tx.execute(
                            "INSERT INTO memory_vectors(memory_id,vector,dimensions,fingerprint,content_hash,status,error_code,updated_at)
                             VALUES(?,NULL,NULL,?,?,'failed',?,?)
                             ON CONFLICT(memory_id) DO UPDATE SET
                               fingerprint=excluded.fingerprint, content_hash=excluded.content_hash,
                               status='failed', error_code=excluded.error_code, updated_at=excluded.updated_at",
                            rusqlite::params![mem_id, fp, chash, code, now],
                        )?;
                    }
                    Ok(())
                });
            }
            _ => {}
        }
    }

    Some(resolved)
}

pub async fn recall_vector_scores(
    db: &Db,
    crypto: &CryptoService,
    http: &Client,
    user_id: &str,
    character_id: &str,
    query_text: &str,
) -> HashMap<String, f64> {
    let mut scores = HashMap::new();
    let trimmed = query_text.trim();
    if trimmed.is_empty() {
        return scores;
    }

    let Some(resolved) = sync_pair_vectors(db, crypto, http, user_id, character_id, 8).await else {
        return scores;
    };

    let Ok(q_vecs) = embed_texts(
        db,
        http,
        &resolved.public,
        &resolved.api_key,
        &[trimmed.to_string()],
        Some(user_id),
    )
    .await
    else {
        return scores;
    };
    let Some(q_vec) = q_vecs.into_iter().next() else {
        return scores;
    };

    let stored: Vec<(String, String)> = db
        .read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT m.id, v.vector
                 FROM memories m
                 JOIN memory_vectors v ON v.memory_id = m.id
                 WHERE m.user_id=? AND m.character_id=? AND m.status='active'
                   AND v.status='ready' AND v.fingerprint=? AND v.vector IS NOT NULL",
            )?;
            let rows = stmt
                .query_map(
                    rusqlite::params![user_id, character_id, resolved.fingerprint],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .unwrap_or_default();

    for (mem_id, vec_json) in stored {
        if let Ok(vec) = serde_json::from_str::<Vec<f32>>(&vec_json) {
            let sim = cosine_similarity(&q_vec, &vec);
            if sim >= resolved.public.min_similarity {
                scores.insert(mem_id, sim);
            }
        }
    }
    scores
}

pub fn load_vector_statuses(
    conn: &Connection,
    memory_ids: &[String],
) -> AppResult<HashMap<String, String>> {
    let mut map = HashMap::new();
    if memory_ids.is_empty() {
        return Ok(map);
    }
    let placeholders = vec!["?"; memory_ids.len()].join(",");
    let sql = format!("SELECT memory_id, status FROM memory_vectors WHERE memory_id IN ({placeholders})");
    let mut stmt = conn.prepare(&sql)?;
    let params: Vec<SqlValue> = memory_ids.iter().map(|s| SqlValue::Text(s.clone())).collect();
    let mut rows = stmt.query(params_from_iter(params.iter()))?;
    while let Some(row) = rows.next()? {
        map.insert(row.get(0)?, row.get(1)?);
    }
    Ok(map)
}

pub async fn test_embedding_model(
    db: &Db,
    crypto: &CryptoService,
    http: &Client,
    model_id: &str,
) -> AppResult<serde_json::Value> {
    let (cfg, api_key) = db.read(|conn| {
        let row = load_embedding_model_row(conn, model_id)?
            .ok_or_else(|| AppError::not_found("MODEL_NOT_FOUND", "向量模型不存在。"))?;
        let key = if row.api_key_enc.is_empty() {
            String::new()
        } else {
            crypto.decrypt(&row.api_key_enc)?
        };
        Ok((
            EmbeddingConfig {
                model_id: row.model_id,
                supplier_id: row.supplier_id,
                supplier_name: row.supplier_name,
                supplier_active: row.supplier_active,
                protocol: row.protocol,
                enabled: true,
                base_url: row.base_url,
                model: row.model,
                has_key: !key.is_empty(),
                top_k: 6,
                min_similarity: 0.3,
            },
            key,
        ))
    })?;

    let started = Instant::now();
    let vecs = embed_texts(
        db,
        http,
        &cfg,
        &api_key,
        &["ChatPony embedding connection check".to_string()],
        None,
    )
    .await?;
    let dims = vecs.first().map(|v| v.len()).unwrap_or(0);
    Ok(json!({
        "ok": dims > 0,
        "dimensions": dims,
        "durationMs": started.elapsed().as_millis() as i64,
        "model": cfg.model,
    }))
}
