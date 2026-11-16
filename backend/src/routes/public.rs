use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;

use crate::auth::current_user;
use crate::avatars::{MAX_AVATAR_UPLOAD_BYTES, avatar_file_path, can_read_avatar};
use crate::email_policy::get_registration_policy;
use crate::error::{AppError, AppResult};
use crate::repository::{get_bootstrap, list_announcements_conn, list_visible_characters};
use crate::routes::helpers::{binary_image_response, ok};
use crate::state::AppState;

pub async fn health(State(state): State<AppState>) -> AppResult<Response> {
    let db_ok: i64 = state
        .db
        .read(|conn| conn.query_row("SELECT 1", [], |r| r.get(0)).map_err(Into::into))?;
    Ok(ok(serde_json::json!({ "ok": db_ok == 1 })))
}

pub async fn bootstrap(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Response> {
    let viewer = current_user(&state.db, &headers)?;
    let data = get_bootstrap(&state.db, viewer)?;
    Ok(ok(data))
}

pub async fn characters_public(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let viewer = current_user(&state.db, &headers)?;
    let items = state
        .db
        .read(|conn| list_visible_characters(conn, viewer.as_ref()))?;
    Ok(ok(items))
}

pub async fn registration_policy(State(state): State<AppState>) -> AppResult<Response> {
    let policy = state.db.read(get_registration_policy)?;
    Ok(ok(serde_json::json!({
        "registrationOpen": policy.registration_open,
        "requireEmailVerification": policy.require_email_verification,
        "emailDomainMode": policy.email_domain_mode,
        "emailDomains": policy.email_domains,
    })))
}

pub async fn announcements_public(State(state): State<AppState>) -> AppResult<Response> {
    let items = state.db.read(|conn| list_announcements_conn(conn, false))?;
    Ok(ok(items))
}

pub async fn get_avatar(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(filename): Path<String>,
) -> AppResult<Response> {
    let viewer = current_user(&state.db, &headers)?;
    let url = format!("/api/avatars/{filename}");
    let (allowed, is_private) = state
        .db
        .read(|conn| can_read_avatar(conn, &url, viewer.as_ref()))?;
    if !allowed {
        return Err(AppError::not_found("AVATAR_NOT_FOUND", "头像不存在。"));
    }

    let path = avatar_file_path(&state.config, &filename)?;
    let bytes = tokio::fs::read(&path).await.map_err(|_| {
        AppError::not_found("AVATAR_NOT_FOUND", "头像文件不存在。")
    })?;
    if bytes.len() > MAX_AVATAR_UPLOAD_BYTES {
        return Err(AppError::not_found("AVATAR_NOT_FOUND", "头像文件异常。"));
    }
    let cache = if is_private {
        "private, max-age=31536000, immutable"
    } else {
        "public, max-age=31536000, immutable"
    };
    Ok(binary_image_response(bytes, "image/webp", cache))
}
