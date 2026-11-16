use axum::body::Bytes;
use axum::extract::{Path, Query, Request, State};
use axum::http::HeaderMap;
use axum::response::Response;
use serde::Deserialize;

use crate::ai::embeddings::{
    get_embedding_config, test_embedding_model, update_embedding_config,
};
use crate::audit::{AuditQuery, clear_audits, get_audit, get_audit_stats, list_audits};
use crate::auth::{assert_json_mutation, assert_mutation_request, require_admin};
use crate::avatars::MAX_AVATAR_UPLOAD_BYTES;
use crate::chat::test_provider_model;
use crate::error::{AppError, AppResult};
use crate::mail::{MailConfigInput, get_mail_config, test_mail, update_mail_config};
use crate::mail_diagnostics::list_mail_deliveries;
use crate::quota::reset_quota;
use crate::repository::{
    AdminCharacterInput, AdminCharacterPatch, AdminCreateUserInput, AdminUserPatch,
    AnnouncementInput, AnnouncementPatch, ModelInput, ModelPatch, SettingsPatch, SupplierInput,
    SupplierPatch, admin_clear_character_avatar, admin_create_announcement, admin_create_character,
    admin_create_model, admin_create_supplier, admin_create_user, admin_delete_announcement,
    admin_delete_character, admin_delete_model, admin_delete_supplier, admin_list_characters,
    admin_list_models, admin_list_suppliers, admin_list_users, admin_set_character_avatar,
    admin_update_announcement, admin_update_character, admin_update_model, admin_update_supplier,
    admin_update_user, get_admin_overview, list_announcements_conn, read_settings, update_settings,
};
use crate::routes::helpers::{
    created, extract_uploaded_file_bytes, ok, parse_json_bytes, parse_json_or_empty,
};
use crate::state::AppState;

// -------- Overview & Settings --------

pub async fn overview(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Response> {
    let _admin = require_admin(&state.db, &headers)?;
    let data = state.db.read(get_admin_overview)?;
    Ok(ok(data))
}

pub async fn get_settings(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Response> {
    let _admin = require_admin(&state.db, &headers)?;
    let data = state.db.read(read_settings)?;
    Ok(ok(data))
}

pub async fn patch_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let _admin = require_admin(&state.db, &headers)?;
    let patch: SettingsPatch = parse_json_bytes(&body)?;
    let next = update_settings(&state.db, patch)?;
    Ok(ok(next))
}

// -------- Users --------

pub async fn list_users(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Response> {
    let _admin = require_admin(&state.db, &headers)?;
    let items = state.db.read(admin_list_users)?;
    Ok(ok(items))
}

pub async fn create_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let _admin = require_admin(&state.db, &headers)?;
    let payload: AdminCreateUserInput = parse_json_bytes(&body)?;
    let user = admin_create_user(&state.db, payload).await?;
    Ok(created(user))
}

pub async fn patch_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let admin = require_admin(&state.db, &headers)?;
    let patch: AdminUserPatch = parse_json_bytes(&body)?;
    let user = admin_update_user(&state.db, &admin, &id, patch).await?;
    Ok(ok(user))
}

pub async fn post_reset_quota(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Response> {
    assert_mutation_request(&headers)?;
    let _admin = require_admin(&state.db, &headers)?;
    let snapshot = reset_quota(&state.db, &id)?;
    Ok(ok(snapshot))
}

// -------- Characters --------

pub async fn list_characters(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let _admin = require_admin(&state.db, &headers)?;
    let items = state.db.read(admin_list_characters)?;
    Ok(ok(items))
}

pub async fn create_character(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let _admin = require_admin(&state.db, &headers)?;
    let payload: AdminCharacterInput = parse_json_bytes(&body)?;
    let ch = admin_create_character(&state.db, payload)?;
    Ok(created(ch))
}

pub async fn patch_character(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let _admin = require_admin(&state.db, &headers)?;
    let patch: AdminCharacterPatch = parse_json_bytes(&body)?;
    let ch = admin_update_character(&state.db, &id, patch)?;
    Ok(ok(ch))
}

pub async fn delete_character(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Response> {
    assert_mutation_request(&headers)?;
    let _admin = require_admin(&state.db, &headers)?;
    admin_delete_character(&state.db, &state.config, &id)?;
    Ok(ok(serde_json::json!({ "ok": true })))
}

pub async fn upload_character_avatar(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    req: Request,
) -> AppResult<Response> {
    assert_mutation_request(&headers)?;
    let _admin = require_admin(&state.db, &headers)?;
    let bytes = extract_uploaded_file_bytes(&headers, req, MAX_AVATAR_UPLOAD_BYTES).await?;
    let ch = admin_set_character_avatar(&state.db, &state.config, &id, &bytes)?;
    Ok(ok(ch))
}

pub async fn clear_character_avatar(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Response> {
    assert_mutation_request(&headers)?;
    let _admin = require_admin(&state.db, &headers)?;
    let ch = admin_clear_character_avatar(&state.db, &state.config, &id)?;
    Ok(ok(ch))
}

// -------- Suppliers & Models --------

pub async fn list_suppliers(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let _admin = require_admin(&state.db, &headers)?;
    let items = state.db.read(admin_list_suppliers)?;
    Ok(ok(items))
}

pub async fn create_supplier(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let _admin = require_admin(&state.db, &headers)?;
    let input: SupplierInput = parse_json_bytes(&body)?;
    let item = admin_create_supplier(&state.db, &state.crypto, input)?;
    Ok(created(item))
}

pub async fn patch_supplier(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let _admin = require_admin(&state.db, &headers)?;
    let patch: SupplierPatch = parse_json_bytes(&body)?;
    let item = admin_update_supplier(&state.db, &state.crypto, &id, patch)?;
    Ok(ok(item))
}

pub async fn delete_supplier(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Response> {
    assert_mutation_request(&headers)?;
    let _admin = require_admin(&state.db, &headers)?;
    admin_delete_supplier(&state.db, &id)?;
    Ok(ok(serde_json::json!({ "ok": true })))
}

pub async fn list_models(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Response> {
    let _admin = require_admin(&state.db, &headers)?;
    let items = state.db.read(admin_list_models)?;
    Ok(ok(items))
}

pub async fn create_model(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let _admin = require_admin(&state.db, &headers)?;
    let input: ModelInput = parse_json_bytes(&body)?;
    let item = admin_create_model(&state.db, input)?;
    Ok(created(item))
}

pub async fn patch_model(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let _admin = require_admin(&state.db, &headers)?;
    let patch: ModelPatch = parse_json_bytes(&body)?;
    let item = admin_update_model(&state.db, &id, patch)?;
    Ok(ok(item))
}

pub async fn delete_model(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Response> {
    assert_mutation_request(&headers)?;
    let _admin = require_admin(&state.db, &headers)?;
    admin_delete_model(&state.db, &id)?;
    Ok(ok(serde_json::json!({ "ok": true })))
}

pub async fn test_model(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Response> {
    assert_mutation_request(&headers)?;
    let _admin = require_admin(&state.db, &headers)?;
    let data = test_provider_model(&state.db, &state.crypto, &state.http, &id).await?;
    Ok(ok(data))
}

// -------- Embedding --------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddingUpdateBody {
    enabled: bool,
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

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct EmbeddingTestBody {
    #[serde(default)]
    model_id: Option<String>,
}

pub async fn get_embedding(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Response> {
    let _admin = require_admin(&state.db, &headers)?;
    let cfg = state.db.read(get_embedding_config)?;
    Ok(ok(cfg))
}

pub async fn put_embedding(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let _admin = require_admin(&state.db, &headers)?;
    let payload: EmbeddingUpdateBody = parse_json_bytes(&body)?;
    let cfg = update_embedding_config(
        &state.db,
        payload.enabled,
        &payload.model_id,
        payload.top_k,
        payload.min_similarity,
    )?;
    Ok(ok(cfg))
}

pub async fn post_test_embedding(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Response> {
    assert_mutation_request(&headers)?;
    let _admin = require_admin(&state.db, &headers)?;
    let payload: EmbeddingTestBody = parse_json_or_empty(&body)?;
    let model_id = match payload.model_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(id) => id.to_string(),
        None => {
            let cfg = state.db.read(get_embedding_config)?;
            if cfg.model_id.is_empty() {
                return Err(AppError::validation("请先选择或配置向量模型。"));
            }
            cfg.model_id
        }
    };
    let result = test_embedding_model(&state.db, &state.crypto, &state.http, &model_id).await?;
    Ok(ok(result))
}

// -------- Announcements --------

pub async fn list_announcements(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let _admin = require_admin(&state.db, &headers)?;
    let items = state.db.read(|conn| list_announcements_conn(conn, true))?;
    Ok(ok(items))
}

pub async fn create_announcement(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let _admin = require_admin(&state.db, &headers)?;
    let input: AnnouncementInput = parse_json_bytes(&body)?;
    let item = admin_create_announcement(&state.db, input)?;
    Ok(created(item))
}

pub async fn patch_announcement(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let _admin = require_admin(&state.db, &headers)?;
    let patch: AnnouncementPatch = parse_json_bytes(&body)?;
    let item = admin_update_announcement(&state.db, &id, patch)?;
    Ok(ok(item))
}

pub async fn delete_announcement(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Response> {
    assert_mutation_request(&headers)?;
    let _admin = require_admin(&state.db, &headers)?;
    admin_delete_announcement(&state.db, &id)?;
    Ok(ok(serde_json::json!({ "ok": true })))
}

// -------- Mail --------

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct MailTestBody {
    #[serde(default)]
    recipient: Option<String>,
    #[serde(default)]
    to: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailDeliveriesQuery {
    #[serde(default = "default_page")]
    page: i64,
    #[serde(default = "default_mail_ps")]
    page_size: i64,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    kind: Option<String>,
}
fn default_page() -> i64 {
    1
}
fn default_mail_ps() -> i64 {
    20
}

pub async fn get_mail(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Response> {
    let _admin = require_admin(&state.db, &headers)?;
    let cfg = state.db.read(|conn| Ok(get_mail_config(conn)))?;
    Ok(ok(cfg))
}

pub async fn put_mail(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let _admin = require_admin(&state.db, &headers)?;
    let input: MailConfigInput = parse_json_bytes(&body)?;
    let cfg = update_mail_config(&state.db, &state.crypto, input)?;
    Ok(ok(cfg))
}

pub async fn post_test_mail(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Response> {
    assert_mutation_request(&headers)?;
    let _admin = require_admin(&state.db, &headers)?;
    let payload: MailTestBody = parse_json_or_empty(&body)?;
    let target = payload.recipient.or(payload.to);
    let res = test_mail(&state.db, &state.crypto, target.as_deref()).await?;
    Ok(ok(res))
}

pub async fn get_mail_deliveries(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<MailDeliveriesQuery>,
) -> AppResult<Response> {
    let _admin = require_admin(&state.db, &headers)?;
    let data = list_mail_deliveries(
        &state.db,
        q.page,
        q.page_size,
        q.status.as_deref(),
        q.kind.as_deref(),
    )?;
    Ok(ok(data))
}

// -------- Audit --------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditListQuery {
    #[serde(default = "default_page")]
    page: i64,
    #[serde(default = "default_audit_ps")]
    page_size: i64,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    supplier_id: Option<String>,
    #[serde(default)]
    user_id: Option<String>,
    #[serde(default)]
    q: Option<String>,
}
fn default_audit_ps() -> i64 {
    30
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditStatsQuery {
    #[serde(default)]
    hours: Option<i64>,
}

pub async fn get_audits(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AuditListQuery>,
) -> AppResult<Response> {
    let _admin = require_admin(&state.db, &headers)?;
    let data = list_audits(
        &state.db,
        AuditQuery {
            page: q.page,
            page_size: q.page_size,
            status: q.status,
            kind: q.kind,
            supplier_id: q.supplier_id,
            user_id: q.user_id,
            search: q.q,
        },
    )?;
    Ok(ok(data))
}

pub async fn audit_stats(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AuditStatsQuery>,
) -> AppResult<Response> {
    let _admin = require_admin(&state.db, &headers)?;
    let stats = get_audit_stats(&state.db, q.hours)?;
    Ok(ok(stats))
}

pub async fn get_audit_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let _admin = require_admin(&state.db, &headers)?;
    let detail = get_audit(&state.db, &id)?
        .ok_or_else(|| AppError::not_found("AUDIT_NOT_FOUND", "审计日志不存在。"))?;
    Ok(ok(detail))
}

pub async fn delete_all_audits(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Response> {
    assert_mutation_request(&headers)?;
    let _admin = require_admin(&state.db, &headers)?;
    let cleared = clear_audits(&state.db)?;
    Ok(ok(serde_json::json!({ "cleared": cleared })))
}
