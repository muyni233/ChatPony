use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use serde::Deserialize;

use crate::ai::embeddings::sync_pair_vectors;
use crate::ai::maintenance::summarize_memories_detailed;
use crate::ai::memory::hybrid_recall;
use crate::auth::{assert_json_mutation, assert_mutation_request, require_user};
use crate::error::{AppError, AppResult};
use crate::models::MemoryKind;
use crate::repository::{
    create_memory, delete_memory, list_memories, read_settings, update_memory,
};
use crate::routes::helpers::{created, ok, parse_json_bytes};
use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoriesQuery {
    #[serde(default)]
    character_id: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    q: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateMemoryBody {
    character_id: String,
    content: String,
    #[serde(default)]
    kind: Option<MemoryKind>,
    #[serde(default)]
    importance: Option<f64>,
    #[serde(default)]
    tags: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchMemoryBody {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    kind: Option<MemoryKind>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    importance: Option<f64>,
    #[serde(default)]
    tags: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CharacterOpBody {
    character_id: String,
    #[serde(default)]
    query: Option<String>,
}

pub async fn get_memories(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<MemoriesQuery>,
) -> AppResult<Response> {
    let user = require_user(&state.db, &headers)?;
    let items = list_memories(
        &state.db,
        &user,
        q.character_id.as_deref(),
        q.status.as_deref(),
        q.kind.as_deref(),
        q.q.as_deref(),
    )?;
    Ok(ok(items))
}

pub async fn post_memory(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let user = require_user(&state.db, &headers)?;
    let payload: CreateMemoryBody = parse_json_bytes(&body)?;
    let item = create_memory(
        &state.db,
        &user,
        &payload.character_id,
        &payload.content,
        payload.kind,
        payload.importance,
        payload.tags,
    )?;
    Ok(created(item))
}

pub async fn patch_memory(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let user = require_user(&state.db, &headers)?;
    let payload: PatchMemoryBody = parse_json_bytes(&body)?;
    let item = update_memory(
        &state.db,
        &user,
        &id,
        payload.content,
        payload.kind,
        payload.status,
        payload.importance,
        payload.tags,
    )?;
    Ok(ok(item))
}

pub async fn remove_memory(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Response> {
    assert_mutation_request(&headers)?;
    let user = require_user(&state.db, &headers)?;
    delete_memory(&state.db, &user, &id)?;
    Ok(ok(serde_json::json!({ "ok": true })))
}

pub async fn summarize_memories(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let user = require_user(&state.db, &headers)?;
    let payload: CharacterOpBody = parse_json_bytes(&body)?;
    let settings = state.db.read(read_settings)?;
    let saved = summarize_memories_detailed(
        &state.db,
        &state.crypto,
        &state.http,
        &user.id,
        &payload.character_id,
        &settings,
        true,
    )
    .await?;
    Ok(ok(serde_json::json!({ "saved": saved })))
}

pub async fn recall_preview(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let user = require_user(&state.db, &headers)?;
    let payload: CharacterOpBody = parse_json_bytes(&body)?;
    let query = payload.query.unwrap_or_default();
    if query.trim().is_empty() {
        return Err(AppError::validation("请输入召回测试关键词。"));
    }
    let settings = state.db.read(read_settings)?;
    let results = hybrid_recall(
        &state.db,
        &state.crypto,
        &state.http,
        &user.id,
        &payload.character_id,
        &query,
        &settings,
        false,
    )
    .await?;
    Ok(ok(results))
}

pub async fn reindex_memories(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let user = require_user(&state.db, &headers)?;
    let payload: CharacterOpBody = parse_json_bytes(&body)?;
    let ok_flag = sync_pair_vectors(
        &state.db,
        &state.crypto,
        &state.http,
        &user.id,
        &payload.character_id,
        16,
    )
    .await
    .is_some();
    Ok(ok(serde_json::json!({ "ok": ok_flag })))
}
