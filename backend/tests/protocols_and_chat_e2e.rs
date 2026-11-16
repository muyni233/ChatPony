use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::State as AxumState;
use axum::http::{Request, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tower::ServiceExt;

use chatpony_backend::build_app;
use chatpony_backend::config::Config;
use chatpony_backend::crypto::CryptoService;
use chatpony_backend::db::Db;
use chatpony_backend::mail::{MailConfigInput, test_mail, update_mail_config};
use chatpony_backend::models::{new_id, now_iso};
use chatpony_backend::state::AppState;

fn temp_config(dir: &TempDir) -> Config {
    Config {
        database_path: dir.path().join("e2e.db").to_string_lossy().to_string(),
        encryption_key: None,
        trust_proxy: false,
        host: "127.0.0.1".to_string(),
        port: 0,
        static_dir: PathBuf::from("nonexistent"),
    }
}

async fn spawn_mock_ai_server() -> (String, Arc<Mutex<Vec<String>>>) {
    let calls = Arc::new(Mutex::new(Vec::<String>::new()));

    let app = Router::new()
        .route(
            "/openai/v1/chat/completions",
            post(|AxumState(c): AxumState<Arc<Mutex<Vec<String>>>>, Json(body): Json<Value>| async move {
                c.lock().unwrap().push(format!("openai-chat:{}", body["model"]));
                if body["stream"].as_bool() == Some(true) {
                    let sse = concat!(
                        "data: {\"choices\":[{\"delta\":{\"content\":\"你好！\"}}]}\n\n",
                        "data: {\"choices\":[{\"delta\":{\"content\":\"我是小马。\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":6}}\n\n",
                        "data: [DONE]\n\n"
                    );
                    Response::builder()
                        .header("content-type", "text/event-stream")
                        .body(Body::from(sse))
                        .unwrap()
                } else {
                    Json(json!({
                        "choices": [{"message": {"content": "OK"}}],
                        "usage": {"prompt_tokens": 5, "completion_tokens": 1}
                    }))
                    .into_response()
                }
            }),
        )
        .route(
            "/anthropic/v1/messages",
            post(|AxumState(c): AxumState<Arc<Mutex<Vec<String>>>>, Json(_body): Json<Value>| async move {
                c.lock().unwrap().push("anthropic".into());
                let sse = concat!(
                    "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10}}}\n\n",
                    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Anthropic测试\"}}\n\n",
                    "event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":4}}\n\n"
                );
                Response::builder()
                    .header("content-type", "text/event-stream")
                    .body(Body::from(sse))
                    .unwrap()
            }),
        )
        .route(
            "/gemini/v1beta/models/{model_action}",
            post(|AxumState(c): AxumState<Arc<Mutex<Vec<String>>>>, axum::extract::Path(ma): axum::extract::Path<String>, Json(_body): Json<Value>| async move {
                c.lock().unwrap().push(format!("gemini:{ma}"));
                if ma.ends_with(":embedContent") {
                    Json(json!({ "embedding": { "values": [0.1, 0.2, 0.3, 0.4] } })).into_response()
                } else {
                    Json(json!({
                        "candidates": [{"content": {"parts": [{"text": "Gemini OK"}]}}],
                        "usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 2}
                    }))
                    .into_response()
                }
            }),
        )
        .with_state(calls.clone());

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}"), calls)
}

async fn spawn_mock_smtp_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (reader, mut writer) = stream.split();
                let mut lines = BufReader::new(reader).lines();
                let _ = writer.write_all(b"220 mock-smtp.local ESMTP Ready\r\n").await;
                let mut in_data = false;
                while let Ok(Some(line)) = lines.next_line().await {
                    if in_data {
                        if line == "." {
                            in_data = false;
                            let _ = writer.write_all(b"250 2.0.0 Queued OK\r\n").await;
                        }
                        continue;
                    }
                    let upper = line.to_ascii_uppercase();
                    if upper.starts_with("EHLO") || upper.starts_with("HELO") {
                        let _ = writer.write_all(b"250-mock-smtp.local\r\n250 OK\r\n").await;
                    } else if upper.starts_with("MAIL FROM") || upper.starts_with("RCPT TO") {
                        let _ = writer.write_all(b"250 2.1.0 OK\r\n").await;
                    } else if upper.starts_with("DATA") {
                        in_data = true;
                        let _ = writer.write_all(b"354 End data with <CR><LF>.<CR><LF>\r\n").await;
                    } else if upper.starts_with("NOOP") {
                        let _ = writer.write_all(b"250 OK\r\n").await;
                    } else if upper.starts_with("QUIT") {
                        let _ = writer.write_all(b"221 Bye\r\n").await;
                        break;
                    } else {
                        let _ = writer.write_all(b"250 OK\r\n").await;
                    }
                }
            });
        }
    });
    port
}

async fn read_json(resp: Response) -> (StatusCode, Value) {
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let val: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, val)
}

fn extract_cookie_pair(resp: &Response) -> String {
    resp.headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn mock_smtp_delivery_and_diagnostics() {
    let dir = TempDir::new().unwrap();
    let cfg = temp_config(&dir);
    let db = Db::open(&cfg).unwrap();
    let crypto = CryptoService::new(&cfg);
    let port = spawn_mock_smtp_server().await;

    update_mail_config(
        &db,
        &crypto,
        MailConfigInput {
            host: "127.0.0.1".into(),
            port,
            secure: false,
            require_tls: false,
            username: "".into(),
            password: None,
            from_email: "noreply@example.com".into(),
            from_name: "ChatPony Test".into(),
        },
    )
    .unwrap();

    let res = test_mail(&db, &crypto, Some("user@example.com")).await.unwrap();
    assert!(res.ok);
    let delivery = res.delivery.unwrap();
    assert_eq!(delivery.status, "success");
    assert_eq!(delivery.smtp_code, Some(250));
}

#[tokio::test]
async fn full_api_e2e_auth_chat_streaming_replay_private_chars_and_admin() {
    let dir = TempDir::new().unwrap();
    let cfg = temp_config(&dir);
    let db = Db::open(&cfg).unwrap();
    let crypto = CryptoService::new(&cfg);
    let state = AppState::from_parts(cfg, db.clone(), crypto);
    let (mock_url, ai_calls) = spawn_mock_ai_server().await;

    // Seed an admin account directly in DB
    let admin_id = new_id();
    let admin_hash = chatpony_backend::auth::hash_password("AdminPass123!").unwrap();
    db.write(|tx| {
        tx.execute(
            "INSERT INTO users(id,email,name,password_hash,role,created_at,character_slots)
             VALUES(?,'admin@example.com','Admin',?,'admin',?,5)",
            rusqlite::params![admin_id, admin_hash, now_iso()],
        )?;
        Ok(())
    })
    .unwrap();

    let app = build_app(state);

    // 1. CSRF cross-site rejection & health check
    let (st, health_val) = read_json(
        app.clone()
            .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(health_val["data"]["ok"], true);

    let (st, _) = read_json(
        app.clone()
            .oneshot(
                Request::post("/api/auth/login")
                    .header("content-type", "application/json")
                    .header("sec-fetch-site", "cross-site")
                    .body(Body::from(r#"{"email":"a@b.com","password":"123"}"#))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // 2. Register regular user (WITHOUT Origin header, matching LAN/CLI compatibility!)
    let reg_resp = app
        .clone()
        .oneshot(
            Request::post("/api/auth/register")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"email":"pony@example.com","password":"UserPass123!","name":"LittlePony"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(reg_resp.status(), StatusCode::CREATED);
    let user_cookie = extract_cookie_pair(&reg_resp);

    // 3. Login as admin & create supplier + model + public character
    let admin_login = app
        .clone()
        .oneshot(
            Request::post("/api/auth/login")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"email":"admin@example.com","password":"AdminPass123!"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(admin_login.status(), StatusCode::OK);
    let admin_cookie = extract_cookie_pair(&admin_login);

    // Non-admin rejected from admin endpoint
    let (st, _) = read_json(
        app.clone()
            .oneshot(
                Request::get("/api/admin/overview")
                    .header("cookie", &user_cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    let (st, sup_val) = read_json(
        app.clone()
            .oneshot(
                Request::post("/api/admin/suppliers")
                    .header("cookie", &admin_cookie)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "name": "MockOpenAI",
                            "protocol": "openai-completions",
                            "baseUrl": format!("{mock_url}/openai/v1"),
                            "apiKey": "sk-secret-key",
                            "active": true
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED);
    let supplier_id = sup_val["data"]["id"].as_str().unwrap().to_string();
    assert_eq!(sup_val["data"]["hasKey"], true);

    let (st, mod_val) = read_json(
        app.clone()
            .oneshot(
                Request::post("/api/admin/providers")
                    .header("cookie", &admin_cookie)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "name": "PonyGPT",
                            "supplierId": supplier_id,
                            "model": "gpt-mock",
                            "kind": "language",
                            "capabilities": ["text", "image"],
                            "active": true
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED);
    let model_id = mod_val["data"]["id"].as_str().unwrap().to_string();

    // Test model endpoint
    let (st, test_val) = read_json(
        app.clone()
            .oneshot(
                Request::post(format!("/api/admin/providers/{model_id}/test"))
                    .header("cookie", &admin_cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(test_val["data"]["ok"], true);

    // Admin creates public character
    let (st, char_val) = read_json(
        app.clone()
            .oneshot(
                Request::post("/api/admin/characters")
                    .header("cookie", &admin_cookie)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "name": "暮光闪闪",
                            "slug": "twilight",
                            "description": "小马谷图书管理员",
                            "personality": "热爱学习的紫悦",
                            "greeting": "你好呀，今天想聊哪本书？",
                            "providerId": model_id,
                            "active": true
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED);
    let char_id = char_val["data"]["id"].as_str().unwrap().to_string();

    // 4. Regular user creates private conversation + streams SSE reply + idempotent replay
    let (st, conv_val) = read_json(
        app.clone()
            .oneshot(
                Request::post("/api/conversations")
                    .header("cookie", &user_cookie)
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "characterIds": [char_id] }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED);
    let conv_id = conv_val["data"]["id"].as_str().unwrap().to_string();

    let sse_resp = app
        .clone()
        .oneshot(
            Request::post(format!("/api/conversations/{conv_id}/messages"))
                .header("cookie", &user_cookie)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "content": "你好，记住：我最喜欢蓝色星空",
                        "requestId": "req-idem-1"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(sse_resp.status(), StatusCode::OK);
    let sse_bytes = sse_resp.into_body().collect().await.unwrap().to_bytes();
    let sse_text = String::from_utf8_lossy(&sse_bytes);
    assert!(sse_text.contains("\"type\":\"delta\""));
    assert!(sse_text.contains("你好！"));
    assert!(sse_text.contains("我是小马。"));
    assert!(sse_text.contains("\"type\":\"done\""));

    let calls_before_replay = ai_calls.lock().unwrap().len();

    // Replay same requestId: must NOT call upstream AI again
    let replay_resp = app
        .clone()
        .oneshot(
            Request::post(format!("/api/conversations/{conv_id}/messages"))
                .header("cookie", &user_cookie)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "content": "你好，记住：我最喜欢蓝色星空",
                        "requestId": "req-idem-1"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(replay_resp.status(), StatusCode::OK);
    let replay_bytes = replay_resp.into_body().collect().await.unwrap().to_bytes();
    let replay_text = String::from_utf8_lossy(&replay_bytes);
    assert!(replay_text.contains("你好！我是小马。"));
    assert_eq!(ai_calls.lock().unwrap().len(), calls_before_replay);

    // Explicit remember should have stored memory for user + char
    let (st, mems) = read_json(
        app.clone()
            .oneshot(
                Request::get("/api/memories")
                    .header("cookie", &user_cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert!(!mems["data"].as_array().unwrap().is_empty());

    // 5. Private character slot limit check & audit secret redaction
    let (st, audit_list) = read_json(
        app.clone()
            .oneshot(
                Request::get("/api/admin/audit")
                    .header("cookie", &admin_cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert!(audit_list["data"]["total"].as_i64().unwrap() >= 2);

    // 6. Anthropic, Gemini chat + Gemini embedding protocol verification via Admin suppliers & test endpoints
    for (name, proto, url, model_name, kind) in [
        ("MockAnthropic", "anthropic", format!("{mock_url}/anthropic"), "claude-mock", "language"),
        ("MockGemini", "gemini", format!("{mock_url}/gemini"), "gemini-mock", "language"),
        ("MockGemEmb", "gemini", format!("{mock_url}/gemini"), "text-embedding-004", "embedding"),
    ] {
        let (st, s_val) = read_json(
            app.clone()
                .oneshot(
                    Request::post("/api/admin/suppliers")
                        .header("cookie", &admin_cookie)
                        .header("content-type", "application/json")
                        .body(Body::from(
                            json!({
                                "name": name,
                                "protocol": proto,
                                "baseUrl": url,
                                "apiKey": "test-key",
                                "active": true
                            })
                            .to_string(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::CREATED);
        let sid = s_val["data"]["id"].as_str().unwrap();

        let (st, m_val) = read_json(
            app.clone()
                .oneshot(
                    Request::post("/api/admin/providers")
                        .header("cookie", &admin_cookie)
                        .header("content-type", "application/json")
                        .body(Body::from(
                            json!({
                                "name": format!("{name}-Model"),
                                "supplierId": sid,
                                "model": model_name,
                                "kind": kind,
                                "capabilities": ["text"],
                                "active": true
                            })
                            .to_string(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::CREATED);
        let mid = m_val["data"]["id"].as_str().unwrap();

        let (st, tst) = read_json(
            app.clone()
                .oneshot(
                    Request::post(format!("/api/admin/providers/{mid}/test"))
                        .header("cookie", &admin_cookie)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(tst["data"]["ok"], true);
    }
}

#[tokio::test]
async fn spa_fallback_returns_200_and_missing_api_returns_404_json() {
    let dir = TempDir::new().unwrap();
    let static_dir = dir.path().join("static");
    std::fs::create_dir_all(static_dir.join("assets")).unwrap();
    std::fs::write(static_dir.join("index.html"), "<!doctype html><html><body>SPA</body></html>").unwrap();

    let cfg = Config {
        database_path: dir.path().join("spa.db").to_string_lossy().to_string(),
        encryption_key: None,
        trust_proxy: false,
        host: "127.0.0.1".to_string(),
        port: 0,
        static_dir,
    };
    let state = AppState::build(cfg).unwrap();
    let app = build_app(state);

    let spa_resp = app
        .clone()
        .oneshot(Request::get("/conversations").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(spa_resp.status(), StatusCode::OK);

    let missing_asset = app
        .clone()
        .oneshot(Request::get("/assets/missing.js").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(missing_asset.status(), StatusCode::NOT_FOUND);

    let (st, api_404) = read_json(
        app.oneshot(Request::get("/api/does-not-exist").body(Body::empty()).unwrap())
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert_eq!(api_404["error"]["code"], "NOT_FOUND");
}
