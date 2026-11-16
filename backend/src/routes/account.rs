use axum::body::Bytes;
use axum::extract::{Path, Request, State};
use axum::http::HeaderMap;
use axum::response::Response;
use serde::Deserialize;

use crate::auth::{assert_json_mutation, assert_mutation_request, require_user};
use crate::avatars::MAX_AVATAR_UPLOAD_BYTES;
use crate::error::AppResult;
use crate::models::UserPersona;
use crate::quota::get_quota;
use crate::repository::{
    change_user_password, clear_user_avatar, set_user_avatar, update_account_profile,
    update_user_persona,
};
use crate::routes::helpers::{
    created, extract_uploaded_file_bytes, ok, parse_json_bytes,
};
use crate::state::AppState;
use crate::user_characters::{
    UserCharacterInput, UserCharacterPatch, clear_user_character_avatar, create_user_character,
    delete_user_character, list_user_characters, set_user_character_avatar, update_user_character,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountPatchBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    timezone: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangePasswordBody {
    current_password: String,
    new_password: String,
}

pub async fn get_account(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Response> {
    let user = require_user(&state.db, &headers)?;
    let quota = get_quota(&state.db, &user.id)?;
    Ok(ok(serde_json::json!({
        "user": user,
        "quota": quota
    })))
}

pub async fn patch_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let user = require_user(&state.db, &headers)?;
    let payload: AccountPatchBody = parse_json_bytes(&body)?;
    let updated = update_account_profile(
        &state.db,
        &user,
        payload.name.as_deref(),
        payload.timezone.as_deref(),
    )?;
    Ok(ok(serde_json::json!({ "user": updated })))
}

pub async fn post_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let user = require_user(&state.db, &headers)?;
    let payload: ChangePasswordBody = parse_json_bytes(&body)?;
    change_user_password(
        &state.db,
        &headers,
        &user,
        &payload.current_password,
        &payload.new_password,
    )
    .await?;
    Ok(ok(serde_json::json!({ "ok": true })))
}

pub async fn put_persona(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let user = require_user(&state.db, &headers)?;
    let payload: UserPersona = parse_json_bytes(&body)?;
    let updated = update_user_persona(&state.db, &user, payload)?;
    Ok(ok(serde_json::json!({ "user": updated })))
}

pub async fn upload_user_avatar(
    State(state): State<AppState>,
    headers: HeaderMap,
    req: Request,
) -> AppResult<Response> {
    assert_mutation_request(&headers)?;
    let user = require_user(&state.db, &headers)?;
    let bytes = extract_uploaded_file_bytes(&headers, req, MAX_AVATAR_UPLOAD_BYTES).await?;
    let updated = set_user_avatar(&state.db, &state.config, &user, &bytes)?;
    Ok(ok(serde_json::json!({ "user": updated })))
}

pub async fn remove_user_avatar(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Response> {
    assert_mutation_request(&headers)?;
    let user = require_user(&state.db, &headers)?;
    let updated = clear_user_avatar(&state.db, &state.config, &user)?;
    Ok(ok(serde_json::json!({ "user": updated })))
}

// -------- Private User Characters --------

pub async fn get_user_characters(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let user = require_user(&state.db, &headers)?;
    let data = list_user_characters(&state.db, &user)?;
    Ok(ok(data))
}

pub async fn post_user_character(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let user = require_user(&state.db, &headers)?;
    let payload: UserCharacterInput = parse_json_bytes(&body)?;
    let ch = create_user_character(&state.db, &user, payload)?;
    Ok(created(ch))
}

pub async fn patch_user_character(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let user = require_user(&state.db, &headers)?;
    let payload: UserCharacterPatch = parse_json_bytes(&body)?;
    let ch = update_user_character(&state.db, &user, &id, payload)?;
    Ok(ok(ch))
}

pub async fn remove_user_character(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Response> {
    assert_mutation_request(&headers)?;
    let user = require_user(&state.db, &headers)?;
    delete_user_character(&state.db, &state.config, &user, &id)?;
    Ok(ok(serde_json::json!({ "ok": true })))
}

pub async fn upload_user_char_avatar(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    req: Request,
) -> AppResult<Response> {
    assert_mutation_request(&headers)?;
    let user = require_user(&state.db, &headers)?;
    let bytes = extract_uploaded_file_bytes(&headers, req, MAX_AVATAR_UPLOAD_BYTES).await?;
    let ch = set_user_character_avatar(&state.db, &state.config, &user, &id, &bytes)?;
    Ok(ok(ch))
}

pub async fn remove_user_char_avatar(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Response> {
    assert_mutation_request(&headers)?;
    let user = require_user(&state.db, &headers)?;
    let ch = clear_user_character_avatar(&state.db, &state.config, &user, &id)?;
    Ok(ok(ch))
}
