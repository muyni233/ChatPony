use std::net::SocketAddr;

use axum::body::Bytes;
use axum::extract::{ConnectInfo, FromRequestParts, Multipart};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, HeaderName};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::error::{AppError, AppResult};

pub struct OptionalPeerAddr(pub Option<SocketAddr>);

impl<S: Send + Sync> FromRequestParts<S> for OptionalPeerAddr {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let addr = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| c.0);
        Ok(Self(addr))
    }
}

pub fn json_ok<T: Serialize>(status: StatusCode, data: T) -> Response {
    let payload = serde_json::json!({ "data": data });
    let bytes = serde_json::to_vec(&payload).unwrap_or_else(|_| b"{}".to_vec());
    let mut resp = Response::new(axum::body::Body::from(bytes));
    *resp.status_mut() = status;
    resp.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    resp.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp.headers_mut().insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    resp
}

pub fn ok<T: Serialize>(data: T) -> Response {
    json_ok(StatusCode::OK, data)
}

pub fn created<T: Serialize>(data: T) -> Response {
    json_ok(StatusCode::CREATED, data)
}

pub fn parse_json_bytes<T: DeserializeOwned>(bytes: &[u8]) -> AppResult<T> {
    if bytes.is_empty() {
        return Err(AppError::validation("请求体不能为空。"));
    }
    serde_json::from_slice::<T>(bytes)
        .map_err(|err| AppError::validation(format!("请求 JSON 参数无效：{err}")))
}

pub fn parse_json_or_empty<T: DeserializeOwned + Default>(bytes: &[u8]) -> AppResult<T> {
    if bytes.is_empty() {
        return Ok(T::default());
    }
    serde_json::from_slice::<T>(bytes)
        .map_err(|err| AppError::validation(format!("请求 JSON 参数无效：{err}")))
}

pub async fn extract_uploaded_file_bytes(
    headers: &HeaderMap,
    req: axum::extract::Request,
    max_bytes: usize,
) -> AppResult<Vec<u8>> {
    let ct = headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    if ct.starts_with("multipart/form-data") {
        use axum::extract::FromRequest;
        let mut mp = Multipart::from_request(req, &())
            .await
            .map_err(|_| AppError::validation("无法解析 multipart 上传表单。"))?;
        while let Some(field) = mp
            .next_field()
            .await
            .map_err(|_| AppError::validation("读取上传文件字段失败。"))?
        {
            let fname = field.name().unwrap_or("");
            if matches!(fname, "file" | "avatar" | "image" | "") || field.file_name().is_some() {
                let data = field
                    .bytes()
                    .await
                    .map_err(|_| AppError::validation("图片读取失败或超出大小限制。"))?;
                if data.len() > max_bytes {
                    return Err(AppError::validation("上传文件大小超出限制。"));
                }
                return Ok(data.to_vec());
            }
        }
        return Err(AppError::validation("上传表单中未找到图片文件。"));
    }

    // Raw binary body upload
    let body_bytes = axum::body::to_bytes(req.into_body(), max_bytes + 1024)
        .await
        .map_err(|_| AppError::validation("上传图片数据超出允许大小或读取失败。"))?;
    if body_bytes.len() > max_bytes {
        return Err(AppError::validation("上传文件大小超出限制。"));
    }
    Ok(body_bytes.to_vec())
}

pub fn binary_image_response(
    bytes: Vec<u8>,
    mime: &str,
    cache_control: &'static str,
) -> Response {
    let mut resp = bytes.into_response();
    resp.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_str(mime).unwrap_or_else(|_| HeaderValue::from_static("image/webp")),
    );
    resp.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static(cache_control));
    resp.headers_mut().insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    resp.headers_mut().insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static("default-src 'none'"),
    );
    resp
}

pub fn require_bytes_within(bytes: &Bytes, max_bytes: usize) -> AppResult<()> {
    if bytes.len() > max_bytes {
        return Err(AppError::validation("请求体大小超出限制。"));
    }
    Ok(())
}
