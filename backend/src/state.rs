use std::sync::Arc;

use reqwest::Client;

use crate::auth::make_dummy_hash;
use crate::config::Config;
use crate::crypto::CryptoService;
use crate::db::Db;
use crate::error::AppResult;

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub db: Db,
    pub crypto: Arc<CryptoService>,
    pub http: Client,
    pub dummy_hash: String,
}

impl AppState {
    pub fn build(config: Config) -> AppResult<Self> {
        let db = Db::open(&config)?;
        let crypto = Arc::new(CryptoService::new(&config));
        let http = Client::builder()
            .user_agent("ChatPony/2.0")
            .build()
            .expect("reqwest client");
        let dummy_hash = make_dummy_hash();
        Ok(Self {
            config,
            db,
            crypto,
            http,
            dummy_hash,
        })
    }

    pub fn from_parts(config: Config, db: Db, crypto: CryptoService) -> Self {
        let http = Client::builder()
            .user_agent("ChatPony/2.0")
            .build()
            .expect("reqwest client");
        let dummy_hash = make_dummy_hash();
        Self {
            config,
            db,
            crypto: Arc::new(crypto),
            http,
            dummy_hash,
        }
    }
}
