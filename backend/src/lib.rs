pub mod ai;
pub mod attachments;
pub mod audit;
pub mod auth;
pub mod avatars;
pub mod chat;
pub mod config;
pub mod crypto;
pub mod db;
pub mod display;
pub mod email_policy;
pub mod error;
pub mod mail;
pub mod mail_diagnostics;
pub mod mappers;
pub mod models;
pub mod quota;
pub mod repository;
pub mod routes;
pub mod state;
pub mod user_characters;

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::Request;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::Response;
use axum::routing::any;
use tower::ServiceExt;
use tower_http::services::ServeDir;

use crate::error::AppError;
use crate::state::AppState;

async fn api_not_found() -> AppError {
    AppError::new(StatusCode::NOT_FOUND, "NOT_FOUND", "请求的 API 路径不存在。")
}

pub fn build_app(state: AppState) -> Router {
    let api = routes::api_router()
        .route("/api", any(api_not_found))
        .route("/api/{*rest}", any(api_not_found));

    let static_dir = state.config.static_dir.clone();
    let index_html = static_dir.join("index.html");

    if static_dir.is_dir() && index_html.is_file() {
        let index_bytes = Arc::new(std::fs::read(&index_html).unwrap_or_default());
        let serve_dir = ServeDir::new(&static_dir);
        let spa_fallback = any(move |req: Request| {
            let dir = serve_dir.clone();
            let index = index_bytes.clone();
            async move {
                let path = req.uri().path().to_string();
                let resp = match dir.oneshot(req).await {
                    Ok(r) => r.map(Body::new),
                    Err(infallible) => match infallible {},
                };
                if resp.status() == StatusCode::NOT_FOUND && !path.starts_with("/assets/") {
                    let mut html = Response::new(Body::from((*index).clone()));
                    *html.status_mut() = StatusCode::OK;
                    html.headers_mut().insert(
                        CONTENT_TYPE,
                        HeaderValue::from_static("text/html; charset=utf-8"),
                    );
                    html.headers_mut()
                        .insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
                    return html;
                }
                resp
            }
        });
        api.fallback_service(spa_fallback).with_state(state)
    } else {
        api.with_state(state)
    }
}
