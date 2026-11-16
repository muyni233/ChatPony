use axum::body::Bytes;
use axum::extract::{Path, Query, Request, State};
use axum::http::header::HeaderName;
use axum::http::{HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use crate::attachments::{MAX_ATTACHMENT_UPLOAD_BYTES, get_attachment_data, upload_attachment};
use crate::auth::{assert_json_mutation, assert_mutation_request, require_user};
use crate::chat::{SendChatInput, start_chat_sse};
use crate::error::AppResult;
use crate::repository::{
    clear_conversation_messages, create_conversation, delete_conversation, get_conversation_detail,
    list_user_conversations, update_conversation,
};
use crate::routes::helpers::{
    binary_image_response, created, extract_uploaded_file_bytes, ok, parse_json_bytes,
};
use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateConvBody {
    character_ids: Vec<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    max_rounds: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvDetailQuery {
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    before: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchConvBody {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    max_rounds: Option<i64>,
    #[serde(default)]
    summary: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendMsgBody {
    #[serde(default)]
    content: String,
    #[serde(default)]
    request_id: String,
    #[serde(default)]
    attachment_ids: Vec<String>,
    #[serde(default)]
    retry_of: Option<String>,
}

pub async fn list_conversations(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let user = require_user(&state.db, &headers)?;
    let items = state.db.read(|conn| list_user_conversations(conn, &user.id))?;
    Ok(ok(items))
}

pub async fn post_conversation(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let user = require_user(&state.db, &headers)?;
    let payload: CreateConvBody = parse_json_bytes(&body)?;
    let conv = create_conversation(
        &state.db,
        &user,
        payload.character_ids,
        payload.title,
        payload.max_rounds,
    )?;
    Ok(created(conv))
}

pub async fn get_conversation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<ConvDetailQuery>,
) -> AppResult<Response> {
    let user = require_user(&state.db, &headers)?;
    let detail = get_conversation_detail(
        &state.db,
        &state.crypto,
        &user,
        &id,
        q.limit,
        q.before.as_deref(),
    )?;
    Ok(ok(detail))
}

pub async fn patch_conversation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let user = require_user(&state.db, &headers)?;
    let payload: PatchConvBody = parse_json_bytes(&body)?;
    let conv = update_conversation(
        &state.db,
        &user,
        &id,
        payload.title,
        payload.max_rounds,
        payload.summary,
    )?;
    Ok(ok(conv))
}

pub async fn remove_conversation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Response> {
    assert_mutation_request(&headers)?;
    let user = require_user(&state.db, &headers)?;
    delete_conversation(&state.db, &user, &id)?;
    Ok(ok(serde_json::json!({ "ok": true })))
}

pub async fn clear_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Response> {
    assert_mutation_request(&headers)?;
    let user = require_user(&state.db, &headers)?;
    clear_conversation_messages(&state.db, &user, &id)?;
    Ok(ok(serde_json::json!({ "ok": true })))
}

pub async fn post_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let user = require_user(&state.db, &headers)?;
    let payload: SendMsgBody = parse_json_bytes(&body)?;
    let sse = start_chat_sse(
        state.db.clone(),
        state.crypto.clone(),
        state.http.clone(),
        user,
        id,
        SendChatInput {
            content: payload.content,
            request_id: payload.request_id,
            attachment_ids: payload.attachment_ids,
            retry_of: payload.retry_of,
        },
    )
    .await?;

    let mut resp = sse.into_response();
    resp.headers_mut().insert(
        HeaderName::from_static("x-accel-buffering"),
        HeaderValue::from_static("no"),
    );
    Ok(resp)
}

pub async fn post_attachment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    req: Request,
) -> AppResult<Response> {
    assert_mutation_request(&headers)?;
    let user = require_user(&state.db, &headers)?;
    let bytes = extract_uploaded_file_bytes(&headers, req, MAX_ATTACHMENT_UPLOAD_BYTES).await?;
    let att = upload_attachment(&state.db, &user, &id, &bytes).await?;
    Ok(created(att))
}

pub async fn get_attachment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let user = require_user(&state.db, &headers)?;
    let (att, data) = get_attachment_data(&state.db, &user, &id)?;
    Ok(binary_image_response(
        data,
        &att.mime,
        "private, max-age=31536000, immutable",
    ))
}
