use axum::body::Bytes;
use axum::extract::State;
use axum::http::header::SET_COOKIE;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde::Deserialize;

use crate::auth::{
    RegisterInput, assert_json_mutation, assert_mutation_request, check_rate_limit, client_ip,
    destroy_session, login_user, register_user, session_clear_cookie, session_set_cookie,
};
use crate::error::AppResult;
use crate::mail::send_registration_code;
use crate::routes::helpers::{OptionalPeerAddr, json_ok, ok, parse_json_bytes};
use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendCodeBody {
    email: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterBody {
    email: String,
    password: String,
    name: String,
    #[serde(default)]
    timezone: Option<String>,
    #[serde(default)]
    verification_code: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginBody {
    email: String,
    password: String,
}

pub async fn send_code(
    State(state): State<AppState>,
    headers: HeaderMap,
    OptionalPeerAddr(peer): OptionalPeerAddr,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let ip = client_ip(&headers, peer, state.config.trust_proxy);
    check_rate_limit(&state.db, &format!("send_code:{ip}"), 10, 15 * 60)?;

    let payload: SendCodeBody = parse_json_bytes(&body)?;
    send_registration_code(&state.db, &state.crypto, &payload.email).await?;
    Ok(ok(serde_json::json!({ "ok": true })))
}

pub async fn register(
    State(state): State<AppState>,
    headers: HeaderMap,
    OptionalPeerAddr(peer): OptionalPeerAddr,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let ip = client_ip(&headers, peer, state.config.trust_proxy);
    check_rate_limit(&state.db, &format!("register:{ip}"), 10, 15 * 60)?;

    let payload: RegisterBody = parse_json_bytes(&body)?;
    let (user, token) = register_user(
        &state.db,
        RegisterInput {
            email: payload.email,
            password: payload.password,
            name: payload.name,
            timezone: payload.timezone,
            verification_code: payload.verification_code,
        },
    )
    .await?;

    let mut resp = json_ok(StatusCode::CREATED, serde_json::json!({ "user": user }));
    resp.headers_mut()
        .append(SET_COOKIE, session_set_cookie(&token, &headers, &state.config));
    Ok(resp)
}

pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    OptionalPeerAddr(peer): OptionalPeerAddr,
    body: Bytes,
) -> AppResult<Response> {
    assert_json_mutation(&headers)?;
    let ip = client_ip(&headers, peer, state.config.trust_proxy);
    check_rate_limit(&state.db, &format!("login:{ip}"), 20, 15 * 60)?;

    let payload: LoginBody = parse_json_bytes(&body)?;
    let (user, token) = login_user(
        &state.db,
        &state.dummy_hash,
        &payload.email,
        &payload.password,
    )
    .await?;

    let mut resp = ok(serde_json::json!({ "user": user }));
    resp.headers_mut()
        .append(SET_COOKIE, session_set_cookie(&token, &headers, &state.config));
    Ok(resp)
}

pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Response> {
    assert_mutation_request(&headers)?;
    destroy_session(&state.db, &headers)?;
    let mut resp = ok(serde_json::json!({ "ok": true }));
    resp.headers_mut()
        .append(SET_COOKIE, session_clear_cookie(&headers, &state.config));
    Ok(resp)
}
