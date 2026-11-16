use std::time::{Duration, Instant};

use base64::Engine;
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use url::Url;

use crate::audit::{AuditBeginInput, AuditFinishInput, begin_audit, finish_audit};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::models::{
    ModelCapability, ModelKind, Protocol, ReasoningEffort, new_id,
};

#[derive(Debug, Clone)]
pub struct ResolvedModel {
    pub id: String,
    pub name: String,
    pub supplier_id: String,
    pub supplier_name: String,
    pub protocol: Protocol,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
    pub kind: ModelKind,
    pub capabilities: Vec<ModelCapability>,
    pub reasoning_effort: ReasoningEffort,
    pub thinking_budget: Option<i64>,
    pub context_window: i64,
    pub max_output: i64,
    pub temperature: Option<f64>,
}

impl ResolvedModel {
    pub fn supports_images(&self) -> bool {
        self.capabilities.contains(&ModelCapability::Image)
    }
}

#[derive(Debug, Clone)]
pub struct PromptImage {
    pub mime: String,
    pub base64_data: String,
}

impl PromptImage {
    pub fn from_bytes(mime: &str, bytes: &[u8]) -> Self {
        Self {
            mime: mime.to_string(),
            base64_data: base64::engine::general_purpose::STANDARD.encode(bytes),
        }
    }
}

#[derive(Debug, Clone)]
pub struct PromptMessage {
    pub role: String, // "user" | "assistant" | "system"
    pub text: String,
    pub images: Vec<PromptImage>,
}

#[derive(Debug, Clone)]
pub struct AuditContext {
    pub kind: String,
    pub user_id: Option<String>,
    pub user_name: Option<String>,
    pub conversation_id: Option<String>,
    pub character_id: Option<String>,
    pub character_name: Option<String>,
    pub request_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CompletionOutput {
    pub text: String,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub duration_ms: i64,
}

pub fn validate_provider_url(raw: &str) -> AppResult<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    let parsed = Url::parse(trimmed).map_err(|_| {
        AppError::validation("服务地址（Base URL）格式无效，请以 http:// 或 https:// 开头。")
    })?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::validation("服务地址仅支持 http:// 或 https:// 协议。"));
    }
    if parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(AppError::validation("服务地址包含无效主机或内嵌凭据。"));
    }
    Ok(trimmed.to_string())
}

pub fn endpoint_for_chat(protocol: Protocol, base_url: &str, model: &str, stream: bool) -> AppResult<String> {
    let base = validate_provider_url(base_url)?;
    match protocol {
        Protocol::OpenAiCompletions => {
            if base.ends_with("/chat/completions") || base.ends_with("/completions") {
                Ok(base)
            } else {
                Ok(format!("{base}/chat/completions"))
            }
        }
        Protocol::OpenAiResponses => {
            if base.ends_with("/responses") {
                Ok(base)
            } else {
                Ok(format!("{base}/responses"))
            }
        }
        Protocol::Anthropic => {
            if base.ends_with("/messages") {
                Ok(base)
            } else if base.ends_with("/v1") {
                Ok(format!("{base}/messages"))
            } else {
                Ok(format!("{base}/v1/messages"))
            }
        }
        Protocol::Gemini => {
            if base.contains(":generateContent") || base.contains(":streamGenerateContent") {
                return Ok(base);
            }
            let versioned = if base.ends_with("/v1beta") || base.ends_with("/v1") {
                base
            } else {
                format!("{base}/v1beta")
            };
            let action = if stream {
                "streamGenerateContent?alt=sse"
            } else {
                "generateContent"
            };
            Ok(format!("{versioned}/models/{model}:{action}"))
        }
    }
}

fn is_legacy_completions_url(url: &str) -> bool {
    url.ends_with("/completions") && !url.ends_with("/chat/completions")
}

fn map_openai_reasoning_effort(effort: ReasoningEffort) -> &'static str {
    match effort {
        ReasoningEffort::None => "none",
        ReasoningEffort::Minimal => "minimal",
        ReasoningEffort::Low => "low",
        ReasoningEffort::Medium => "medium",
        ReasoningEffort::High => "high",
        ReasoningEffort::Xhigh => "xhigh",
        ReasoningEffort::Max | ReasoningEffort::Default => "high",
    }
}

fn anthropic_thinking_budget(effort: ReasoningEffort, custom: Option<i64>, max_tokens: i64) -> Option<i64> {
    let raw = match custom {
        Some(v) if v >= 1024 => Some(v),
        _ => match effort {
            ReasoningEffort::Default | ReasoningEffort::None => None,
            ReasoningEffort::Minimal => Some(1024),
            ReasoningEffort::Low => Some(2048),
            ReasoningEffort::Medium => Some(8192),
            ReasoningEffort::High => Some(16384),
            ReasoningEffort::Xhigh | ReasoningEffort::Max => Some(32768),
        },
    }?;
    // Anthropic requires budget_tokens < max_tokens and >= 1024
    let safe = raw.max(1024);
    if max_tokens <= 1024 {
        None
    } else {
        Some(safe.min(max_tokens - 1))
    }
}

fn gemini_thinking_budget(effort: ReasoningEffort, custom: Option<i64>) -> Option<i64> {
    if let Some(v) = custom {
        return Some(v.clamp(0, 32768));
    }
    match effort {
        ReasoningEffort::Default => None,
        ReasoningEffort::None => Some(0),
        ReasoningEffort::Minimal => Some(512),
        ReasoningEffort::Low => Some(2048),
        ReasoningEffort::Medium => Some(8192),
        ReasoningEffort::High => Some(16384),
        ReasoningEffort::Xhigh | ReasoningEffort::Max => Some(24576),
    }
}

fn build_chat_payload(
    model: &ResolvedModel,
    system_prompt: &str,
    messages: &[PromptMessage],
    stream: bool,
    endpoint: &str,
) -> Value {
    let max_output = model.max_output.clamp(64, 131_072);

    match model.protocol {
        Protocol::OpenAiCompletions => {
            if is_legacy_completions_url(endpoint) {
                let mut prompt = String::new();
                if !system_prompt.trim().is_empty() {
                    prompt.push_str(system_prompt.trim());
                    prompt.push_str("\n\n");
                }
                for m in messages {
                    let prefix = if m.role == "user" { "用户" } else { "角色" };
                    prompt.push_str(&format!("{prefix}: {}\n", m.text));
                }
                prompt.push_str("角色:");
                let mut body = json!({
                    "model": model.model,
                    "prompt": prompt,
                    "max_tokens": max_output,
                    "stream": stream,
                    "stop": ["\n用户:", "\nUser:"]
                });
                if let Some(t) = model.temperature {
                    body["temperature"] = json!(t);
                }
                return body;
            }

            let mut api_msgs: Vec<Value> = Vec::new();
            if !system_prompt.trim().is_empty() {
                api_msgs.push(json!({ "role": "system", "content": system_prompt }));
            }
            for m in messages {
                if m.images.is_empty() || m.role != "user" {
                    api_msgs.push(json!({ "role": m.role, "content": m.text }));
                } else {
                    let mut parts = Vec::new();
                    if !m.text.is_empty() {
                        parts.push(json!({ "type": "text", "text": m.text }));
                    }
                    for img in &m.images {
                        parts.push(json!({
                            "type": "image_url",
                            "image_url": { "url": format!("data:{};base64,{}", img.mime, img.base64_data) }
                        }));
                    }
                    api_msgs.push(json!({ "role": "user", "content": parts }));
                }
            }
            let mut body = json!({
                "model": model.model,
                "messages": api_msgs,
                "max_tokens": max_output,
                "stream": stream,
            });
            if stream {
                body["stream_options"] = json!({ "include_usage": true });
            }
            if let Some(t) = model.temperature {
                body["temperature"] = json!(t);
            }
            if model.reasoning_effort != ReasoningEffort::Default {
                body["reasoning_effort"] = json!(map_openai_reasoning_effort(model.reasoning_effort));
            }
            body
        }

        Protocol::OpenAiResponses => {
            let mut input_items: Vec<Value> = Vec::new();
            for m in messages {
                let role = if m.role == "assistant" {
                    "assistant"
                } else {
                    "user"
                };
                if m.images.is_empty() || role != "user" {
                    input_items.push(json!({ "role": role, "content": m.text }));
                } else {
                    let mut parts = Vec::new();
                    if !m.text.is_empty() {
                        parts.push(json!({ "type": "input_text", "text": m.text }));
                    }
                    for img in &m.images {
                        parts.push(json!({
                            "type": "input_image",
                            "image_url": format!("data:{};base64,{}", img.mime, img.base64_data)
                        }));
                    }
                    input_items.push(json!({ "role": "user", "content": parts }));
                }
            }
            let mut body = json!({
                "model": model.model,
                "input": input_items,
                "max_output_tokens": max_output,
                "stream": stream,
            });
            if !system_prompt.trim().is_empty() {
                body["instructions"] = json!(system_prompt);
            }
            if let Some(t) = model.temperature {
                body["temperature"] = json!(t);
            }
            if model.reasoning_effort != ReasoningEffort::Default {
                body["reasoning"] = json!({
                    "effort": map_openai_reasoning_effort(model.reasoning_effort)
                });
            }
            body
        }

        Protocol::Anthropic => {
            let mut api_msgs: Vec<Value> = Vec::new();
            for m in messages {
                let role = if m.role == "assistant" {
                    "assistant"
                } else {
                    "user"
                };
                if m.images.is_empty() || role != "user" {
                    api_msgs.push(json!({ "role": role, "content": m.text }));
                } else {
                    let mut parts = Vec::new();
                    for img in &m.images {
                        parts.push(json!({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": img.mime,
                                "data": img.base64_data
                            }
                        }));
                    }
                    if !m.text.is_empty() {
                        parts.push(json!({ "type": "text", "text": m.text }));
                    }
                    api_msgs.push(json!({ "role": "user", "content": parts }));
                }
            }

            let thinking = anthropic_thinking_budget(
                model.reasoning_effort,
                model.thinking_budget,
                max_output,
            );
            let mut body = json!({
                "model": model.model,
                "messages": api_msgs,
                "max_tokens": max_output,
                "stream": stream,
            });
            if !system_prompt.trim().is_empty() {
                body["system"] = json!(system_prompt);
            }
            if let Some(budget) = thinking {
                body["thinking"] = json!({
                    "type": "enabled",
                    "budget_tokens": budget
                });
            } else if let Some(t) = model.temperature {
                body["temperature"] = json!(t);
            }
            body
        }

        Protocol::Gemini => {
            let mut contents: Vec<Value> = Vec::new();
            for m in messages {
                let role = if m.role == "assistant" {
                    "model"
                } else {
                    "user"
                };
                let mut parts = Vec::new();
                if role == "user" {
                    for img in &m.images {
                        parts.push(json!({
                            "inlineData": {
                                "mimeType": img.mime,
                                "data": img.base64_data
                            }
                        }));
                    }
                }
                if !m.text.is_empty() || parts.is_empty() {
                    parts.push(json!({ "text": m.text }));
                }
                contents.push(json!({ "role": role, "parts": parts }));
            }

            let mut gen_cfg = json!({
                "maxOutputTokens": max_output,
            });
            if let Some(t) = model.temperature {
                gen_cfg["temperature"] = json!(t);
            }
            if let Some(budget) = gemini_thinking_budget(model.reasoning_effort, model.thinking_budget) {
                gen_cfg["thinkingConfig"] = json!({ "thinkingBudget": budget });
            }

            let mut body = json!({
                "contents": contents,
                "generationConfig": gen_cfg,
            });
            if !system_prompt.trim().is_empty() {
                body["systemInstruction"] = json!({
                    "parts": [{ "text": system_prompt }]
                });
            }
            body
        }
    }
}

pub fn apply_auth_headers(
    mut req: reqwest::RequestBuilder,
    protocol: Protocol,
    api_key: &str,
) -> reqwest::RequestBuilder {
    let key = api_key.trim();
    if key.is_empty() {
        return req;
    }
    req = match protocol {
        Protocol::Anthropic => req
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01"),
        Protocol::Gemini => req.header("x-goog-api-key", key),
        Protocol::OpenAiCompletions | Protocol::OpenAiResponses => {
            req.header("authorization", format!("Bearer {key}"))
        }
    };
    req
}

#[derive(Default)]
struct StreamParseState {
    buf: Vec<u8>,
    event_name: Option<String>,
    data_lines: Vec<String>,
    text: String,
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
}

impl StreamParseState {
    fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut deltas = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let mut line_bytes: Vec<u8> = self.buf.drain(..=pos).collect();
            if line_bytes.ends_with(b"\n") {
                line_bytes.pop();
            }
            if line_bytes.ends_with(b"\r") {
                line_bytes.pop();
            }
            let line = String::from_utf8_lossy(&line_bytes).to_string();
            if line.is_empty() {
                if !self.data_lines.is_empty() {
                    let payload = self.data_lines.join("\n");
                    self.data_lines.clear();
                    let ev = self.event_name.take();
                    if let Some(delta) = self.process_sse_payload(ev.as_deref(), &payload) {
                        if !delta.is_empty() {
                            self.text.push_str(&delta);
                            deltas.push(delta);
                        }
                    }
                } else {
                    self.event_name = None;
                }
            } else if let Some(rest) = line.strip_prefix("event:") {
                self.event_name = Some(rest.trim().to_string());
            } else if let Some(rest) = line.strip_prefix("data:") {
                self.data_lines.push(rest.trim_start().to_string());
            }
        }
        deltas
    }

    fn flush(&mut self) -> Vec<String> {
        let mut deltas = Vec::new();
        if !self.buf.is_empty() {
            let remaining = std::mem::take(&mut self.buf);
            let line = String::from_utf8_lossy(&remaining).trim().to_string();
            if let Some(rest) = line.strip_prefix("data:") {
                self.data_lines.push(rest.trim_start().to_string());
            }
        }
        if !self.data_lines.is_empty() {
            let payload = self.data_lines.join("\n");
            self.data_lines.clear();
            let ev = self.event_name.take();
            if let Some(delta) = self.process_sse_payload(ev.as_deref(), &payload) {
                if !delta.is_empty() {
                    self.text.push_str(&delta);
                    deltas.push(delta);
                }
            }
        }
        deltas
    }

    fn process_sse_payload(&mut self, event: Option<&str>, payload: &str) -> Option<String> {
        let trimmed = payload.trim();
        if trimmed.is_empty() || trimmed == "[DONE]" {
            return None;
        }
        let val: Value = serde_json::from_str(trimmed).ok()?;

        // Usage updates across protocols
        if let Some(u) = val.get("usage") {
            if let Some(it) = u
                .get("prompt_tokens")
                .or_else(|| u.get("input_tokens"))
                .and_then(|v| v.as_i64())
            {
                self.input_tokens = Some(it);
            }
            if let Some(ot) = u
                .get("completion_tokens")
                .or_else(|| u.get("output_tokens"))
                .and_then(|v| v.as_i64())
            {
                self.output_tokens = Some(ot);
            }
        }
        if let Some(u) = val.pointer("/message/usage") {
            if let Some(it) = u.get("input_tokens").and_then(|v| v.as_i64()) {
                self.input_tokens = Some(it);
            }
        }
        if let Some(u) = val.pointer("/response/usage") {
            if let Some(it) = u.get("input_tokens").and_then(|v| v.as_i64()) {
                self.input_tokens = Some(it);
            }
            if let Some(ot) = u.get("output_tokens").and_then(|v| v.as_i64()) {
                self.output_tokens = Some(ot);
            }
        }
        if let Some(um) = val.get("usageMetadata") {
            if let Some(it) = um.get("promptTokenCount").and_then(|v| v.as_i64()) {
                self.input_tokens = Some(it);
            }
            if let Some(ot) = um.get("candidatesTokenCount").and_then(|v| v.as_i64()) {
                self.output_tokens = Some(ot);
            }
        }

        // OpenAI Completions / Chat Completions
        if let Some(choices) = val.get("choices").and_then(|v| v.as_array()) {
            if let Some(first) = choices.first() {
                if let Some(content) = first.pointer("/delta/content").and_then(|v| v.as_str()) {
                    return Some(content.to_string());
                }
                if let Some(text) = first.get("text").and_then(|v| v.as_str()) {
                    return Some(text.to_string());
                }
            }
        }

        // Anthropic
        if event == Some("content_block_delta")
            || val.get("type").and_then(|v| v.as_str()) == Some("content_block_delta")
        {
            if val.pointer("/delta/type").and_then(|v| v.as_str()) == Some("text_delta") {
                if let Some(text) = val.pointer("/delta/text").and_then(|v| v.as_str()) {
                    return Some(text.to_string());
                }
            }
            return None;
        }

        // OpenAI Responses API
        let ev_type = event.or_else(|| val.get("type").and_then(|v| v.as_str()));
        if ev_type == Some("response.output_text.delta") {
            if let Some(delta) = val.get("delta").and_then(|v| v.as_str()) {
                return Some(delta.to_string());
            }
            return None;
        }
        if ev_type == Some("response.completed") && self.text.is_empty() {
            if let Some(full) = extract_responses_text(val.get("response").unwrap_or(&val)) {
                return Some(full);
            }
        }

        // Gemini SSE
        if let Some(parts) = val
            .pointer("/candidates/0/content/parts")
            .and_then(|v| v.as_array())
        {
            let mut chunk_text = String::new();
            for p in parts {
                if p.get("thought").and_then(|v| v.as_bool()) == Some(true) {
                    continue;
                }
                if let Some(t) = p.get("text").and_then(|v| v.as_str()) {
                    chunk_text.push_str(t);
                }
            }
            if !chunk_text.is_empty() {
                return Some(chunk_text);
            }
        }

        None
    }
}

fn extract_responses_text(val: &Value) -> Option<String> {
    if let Some(ot) = val.get("output_text").and_then(|v| v.as_str()) {
        if !ot.is_empty() {
            return Some(ot.to_string());
        }
    }
    let output = val.get("output")?.as_array()?;
    let mut parts = Vec::new();
    for item in output {
        if item.get("type").and_then(|v| v.as_str()) == Some("message") {
            if let Some(content) = item.get("content").and_then(|v| v.as_array()) {
                for block in content {
                    if matches!(
                        block.get("type").and_then(|v| v.as_str()),
                        Some("output_text" | "text")
                    ) {
                        if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                            parts.push(t.to_string());
                        }
                    }
                }
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(""))
    }
}

pub fn extract_sync_response(
    protocol: Protocol,
    val: &Value,
) -> (String, Option<i64>, Option<i64>) {
    match protocol {
        Protocol::OpenAiCompletions => {
            let input_tokens = val.pointer("/usage/prompt_tokens").and_then(|v| v.as_i64());
            let output_tokens = val
                .pointer("/usage/completion_tokens")
                .and_then(|v| v.as_i64());
            let text = val
                .pointer("/choices/0/message/content")
                .and_then(|v| v.as_str())
                .or_else(|| val.pointer("/choices/0/text").and_then(|v| v.as_str()))
                .unwrap_or("")
                .to_string();
            (text, input_tokens, output_tokens)
        }
        Protocol::OpenAiResponses => {
            let input_tokens = val.pointer("/usage/input_tokens").and_then(|v| v.as_i64());
            let output_tokens = val.pointer("/usage/output_tokens").and_then(|v| v.as_i64());
            let text = extract_responses_text(val).unwrap_or_default();
            (text, input_tokens, output_tokens)
        }
        Protocol::Anthropic => {
            let input_tokens = val.pointer("/usage/input_tokens").and_then(|v| v.as_i64());
            let output_tokens = val.pointer("/usage/output_tokens").and_then(|v| v.as_i64());
            let mut text = String::new();
            if let Some(blocks) = val.get("content").and_then(|v| v.as_array()) {
                for b in blocks {
                    if b.get("type").and_then(|v| v.as_str()) == Some("text") {
                        if let Some(t) = b.get("text").and_then(|v| v.as_str()) {
                            text.push_str(t);
                        }
                    }
                }
            }
            (text, input_tokens, output_tokens)
        }
        Protocol::Gemini => {
            let input_tokens = val
                .pointer("/usageMetadata/promptTokenCount")
                .and_then(|v| v.as_i64());
            let output_tokens = val
                .pointer("/usageMetadata/candidatesTokenCount")
                .and_then(|v| v.as_i64());
            let mut text = String::new();
            if let Some(parts) = val
                .pointer("/candidates/0/content/parts")
                .and_then(|v| v.as_array())
            {
                for p in parts {
                    if p.get("thought").and_then(|v| v.as_bool()) == Some(true) {
                        continue;
                    }
                    if let Some(t) = p.get("text").and_then(|v| v.as_str()) {
                        text.push_str(t);
                    }
                }
            }
            (text, input_tokens, output_tokens)
        }
    }
}

fn is_retryable_status(status: u16) -> bool {
    matches!(status, 429 | 502 | 503 | 504 | 529)
}

fn extract_upstream_error(body: &str) -> String {
    if let Ok(val) = serde_json::from_str::<Value>(body) {
        if let Some(msg) = val
            .pointer("/error/message")
            .or_else(|| val.get("message"))
            .and_then(|v| v.as_str())
        {
            return msg.chars().take(300).collect();
        }
    }
    body.trim().chars().take(300).collect()
}

pub async fn complete_chat(
    db: &Db,
    http: &Client,
    model: &ResolvedModel,
    system_prompt: &str,
    messages: &[PromptMessage],
    stream: bool,
    audit_ctx: &AuditContext,
    delta_tx: Option<mpsc::UnboundedSender<String>>,
) -> AppResult<CompletionOutput> {
    let endpoint = endpoint_for_chat(model.protocol, &model.base_url, &model.model, stream)?;
    let payload = build_chat_payload(model, system_prompt, messages, stream, &endpoint);
    let max_attempts: i64 = 3;

    'attempt: for attempt in 1..=max_attempts {
        let started = Instant::now();
        let audit_pair = begin_audit(
            db,
            AuditBeginInput {
                kind: audit_ctx.kind.clone(),
                user_id: audit_ctx.user_id.clone(),
                user_name: audit_ctx.user_name.clone(),
                conversation_id: audit_ctx.conversation_id.clone(),
                character_id: audit_ctx.character_id.clone(),
                character_name: audit_ctx.character_name.clone(),
                supplier_id: Some(model.supplier_id.clone()),
                supplier_name: Some(model.supplier_name.clone()),
                model_id: Some(model.id.clone()),
                protocol: model.protocol.as_str().to_string(),
                model: model.model.clone(),
                endpoint: endpoint.clone(),
                request_id: audit_ctx
                    .request_id
                    .clone()
                    .or_else(|| Some(new_id())),
                attempt,
                request_body: Some(payload.clone()),
            },
        );
        let audit_id = audit_pair.as_ref().map(|(id, _)| id.clone());
        let capture = audit_pair.as_ref().map(|(_, c)| *c).unwrap_or(false);

        let mut req = http
            .post(&endpoint)
            .timeout(Duration::from_secs(120))
            .header("content-type", "application/json");
        if stream {
            req = req.header("accept", "text/event-stream");
        }
        req = apply_auth_headers(req, model.protocol, &model.api_key).json(&payload);

        let resp = match req.send().await {
            Ok(r) => r,
            Err(err) => {
                let dur = started.elapsed().as_millis() as i64;
                finish_audit(
                    db,
                    audit_id.as_deref(),
                    capture,
                    AuditFinishInput {
                        status: "failed".to_string(),
                        duration_ms: Some(dur),
                        error_code: Some("UPSTREAM_NETWORK_ERROR".to_string()),
                        error_message: Some(err.to_string()),
                        ..Default::default()
                    },
                );
                if attempt < max_attempts && (err.is_timeout() || err.is_connect()) {
                    tokio::time::sleep(Duration::from_millis(600 * attempt as u64)).await;
                    continue;
                }
                return Err(AppError::service_unavailable(
                    "UPSTREAM_ERROR",
                    format!("连接模型服务失败：{err}"),
                ));
            }
        };

        let status = resp.status();
        let status_code = i64::from(status.as_u16());
        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();

        if !status.is_success() {
            let err_body = resp.text().await.unwrap_or_default();
            let msg = extract_upstream_error(&err_body);
            let dur = started.elapsed().as_millis() as i64;
            finish_audit(
                db,
                audit_id.as_deref(),
                capture,
                AuditFinishInput {
                    status: "failed".to_string(),
                    http_status: Some(status_code),
                    duration_ms: Some(dur),
                    error_code: Some(format!("HTTP_{}", status.as_u16())),
                    error_message: Some(msg.clone()),
                    response_body: Some(err_body),
                    ..Default::default()
                },
            );
            if attempt < max_attempts && is_retryable_status(status.as_u16()) {
                tokio::time::sleep(Duration::from_millis(700 * attempt as u64)).await;
                continue;
            }
            return Err(AppError::service_unavailable(
                "UPSTREAM_HTTP_ERROR",
                if msg.is_empty() {
                    format!("模型服务返回错误状态（HTTP {}）。", status.as_u16())
                } else {
                    format!("模型服务返回错误（HTTP {}）：{}", status.as_u16(), msg)
                },
            ));
        }

        if content_type.contains("text/event-stream") {
            let mut state = StreamParseState::default();
            let mut byte_stream = resp.bytes_stream();
            while let Some(item) = byte_stream.next().await {
                match item {
                    Ok(chunk) => {
                        for delta in state.feed(&chunk) {
                            if let Some(ref tx) = delta_tx {
                                let _ = tx.send(delta);
                            }
                        }
                    }
                    Err(err) => {
                        let dur = started.elapsed().as_millis() as i64;
                        finish_audit(
                            db,
                            audit_id.as_deref(),
                            capture,
                            AuditFinishInput {
                                status: "failed".to_string(),
                                http_status: Some(status_code),
                                duration_ms: Some(dur),
                                error_code: Some("STREAM_READ_ERROR".to_string()),
                                error_message: Some(err.to_string()),
                                response_body: Some(state.text.clone()),
                                ..Default::default()
                            },
                        );
                        if state.text.is_empty() && attempt < max_attempts {
                            tokio::time::sleep(Duration::from_millis(600 * attempt as u64)).await;
                            continue 'attempt;
                        }
                        return Err(AppError::service_unavailable(
                            "STREAM_INTERRUPTED",
                            format!("流式读取模型回复中断：{err}"),
                        ));
                    }
                }
            }
            for delta in state.flush() {
                if let Some(ref tx) = delta_tx {
                    let _ = tx.send(delta);
                }
            }

            let dur = started.elapsed().as_millis() as i64;
            finish_audit(
                db,
                audit_id.as_deref(),
                capture,
                AuditFinishInput {
                    status: "success".to_string(),
                    http_status: Some(status_code),
                    duration_ms: Some(dur),
                    input_tokens: state.input_tokens,
                    output_tokens: state.output_tokens,
                    response_body: Some(state.text.clone()),
                    ..Default::default()
                },
            );
            return Ok(CompletionOutput {
                text: state.text,
                input_tokens: state.input_tokens,
                output_tokens: state.output_tokens,
                duration_ms: dur,
            });
        }

        // Non-streaming JSON (or fallback when server returns JSON even when stream=true)
        let raw_text = resp.text().await.map_err(|err| {
            let dur = started.elapsed().as_millis() as i64;
            finish_audit(
                db,
                audit_id.as_deref(),
                capture,
                AuditFinishInput {
                    status: "failed".to_string(),
                    http_status: Some(status_code),
                    duration_ms: Some(dur),
                    error_code: Some("RESPONSE_READ_ERROR".to_string()),
                    error_message: Some(err.to_string()),
                    ..Default::default()
                },
            );
            AppError::service_unavailable("UPSTREAM_ERROR", format!("读取模型响应失败：{err}"))
        })?;

        let parsed: Value = serde_json::from_str(&raw_text).map_err(|_| {
            let dur = started.elapsed().as_millis() as i64;
            finish_audit(
                db,
                audit_id.as_deref(),
                capture,
                AuditFinishInput {
                    status: "failed".to_string(),
                    http_status: Some(status_code),
                    duration_ms: Some(dur),
                    error_code: Some("INVALID_JSON".to_string()),
                    error_message: Some("模型响应不是合法 JSON".to_string()),
                    response_body: Some(raw_text.clone()),
                    ..Default::default()
                },
            );
            AppError::service_unavailable("INVALID_RESPONSE", "模型返回了无法解析的响应格式。")
        })?;

        let (text, in_tok, out_tok) = extract_sync_response(model.protocol, &parsed);
        if stream && !text.is_empty() {
            if let Some(ref tx) = delta_tx {
                let _ = tx.send(text.clone());
            }
        }
        let dur = started.elapsed().as_millis() as i64;
        finish_audit(
            db,
            audit_id.as_deref(),
            capture,
            AuditFinishInput {
                status: "success".to_string(),
                http_status: Some(status_code),
                duration_ms: Some(dur),
                input_tokens: in_tok,
                output_tokens: out_tok,
                response_body: Some(raw_text),
                ..Default::default()
            },
        );
        return Ok(CompletionOutput {
            text,
            input_tokens: in_tok,
            output_tokens: out_tok,
            duration_ms: dur,
        });
    }

    Err(AppError::service_unavailable(
        "UPSTREAM_ERROR",
        "模型服务暂时不可用，请稍后重试。",
    ))
}
