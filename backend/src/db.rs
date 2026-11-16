use std::fs;
use std::path::Path;

use r2d2::{ManageConnection, Pool, PooledConnection};
use rusqlite::{Connection, OpenFlags, Transaction, TransactionBehavior};

use crate::config::Config;
use crate::error::AppResult;
use crate::models::{new_id, now_iso};

pub const SCHEMA_VERSION: i64 = 14;

#[derive(Debug)]
struct SqliteManager {
    path: String,
}

impl ManageConnection for SqliteManager {
    type Connection = Connection;
    type Error = rusqlite::Error;

    fn connect(&self) -> Result<Self::Connection, Self::Error> {
        let conn = if self.path == ":memory:" {
            Connection::open_in_memory()?
        } else {
            Connection::open_with_flags(
                &self.path,
                OpenFlags::SQLITE_OPEN_READ_WRITE
                    | OpenFlags::SQLITE_OPEN_CREATE
                    | OpenFlags::SQLITE_OPEN_URI
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?
        };
        if self.path != ":memory:" {
            conn.execute_batch(
                "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
            )?;
        } else {
            conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")?;
        }
        Ok(conn)
    }

    fn is_valid(&self, conn: &mut Self::Connection) -> Result<(), Self::Error> {
        conn.execute_batch("")?;
        Ok(())
    }

    fn has_broken(&self, _conn: &mut Self::Connection) -> bool {
        false
    }
}

#[derive(Clone)]
pub struct Db {
    pool: Pool<SqliteManager>,
    pub path: String,
}

impl Db {
    pub fn open(config: &Config) -> AppResult<Self> {
        Self::open_path(&config.database_path)
    }

    pub fn open_path(configured: &str) -> AppResult<Self> {
        let path = if configured == ":memory:" {
            ":memory:".to_string()
        } else {
            let p = Path::new(configured);
            let abs = if p.is_absolute() {
                p.to_path_buf()
            } else {
                std::env::current_dir()
                    .unwrap_or_else(|_| std::path::PathBuf::from("."))
                    .join(p)
            };
            if let Some(parent) = abs.parent() {
                fs::create_dir_all(parent).map_err(|err| {
                    tracing::error!("Failed to create database directory {:?}: {:?}", parent, err);
                    crate::error::AppError::internal()
                })?;
            }
            abs.to_string_lossy().to_string()
        };

        let max_size = if path == ":memory:" { 1 } else { 8 };
        let manager = SqliteManager { path: path.clone() };
        let pool = Pool::builder()
            .max_size(max_size)
            .build(manager)
            .map_err(|err| {
                tracing::error!("Failed to build SQLite pool: {:?}", err);
                crate::error::AppError::internal()
            })?;

        let db = Self { pool, path };
        db.init_schema()?;
        Ok(db)
    }

    fn conn(&self) -> AppResult<PooledConnection<SqliteManager>> {
        self.pool.get().map_err(|err| {
            tracing::error!("SQLite pool get failed: {:?}", err);
            crate::error::AppError::internal()
        })
    }

    pub fn read<F, T>(&self, f: F) -> AppResult<T>
    where
        F: FnOnce(&Connection) -> AppResult<T>,
    {
        let conn = self.conn()?;
        f(&conn)
    }

    pub fn write<F, T>(&self, f: F) -> AppResult<T>
    where
        F: FnOnce(&Transaction<'_>) -> AppResult<T>,
    {
        let mut conn = self.conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let res = f(&tx)?;
        tx.commit()?;
        Ok(res)
    }

    fn init_schema(&self) -> AppResult<()> {
        self.write(|tx| {
            let previous_version: i64 =
                tx.query_row("PRAGMA user_version", [], |row| row.get(0))?;
            if previous_version == SCHEMA_VERSION {
                // Ensure FTS table exists just in case, or return immediately
                return Ok(());
            }

            tx.execute_batch(
                r#"
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
      disabled INTEGER NOT NULL DEFAULT 0, timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      limit_5h INTEGER NOT NULL DEFAULT 50 CHECK(limit_5h >= 0),
      limit_7d INTEGER NOT NULL DEFAULT 500 CHECK(limit_7d >= 0),
      quota_reset_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z', created_at TEXT NOT NULL,
      email_verified_at TEXT, avatar TEXT NOT NULL DEFAULT '',
      persona TEXT NOT NULL DEFAULT '{"enabled":false,"name":"","species":"","pronouns":"","appearance":"","personality":"","background":""}'
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registration_challenges (
      email TEXT PRIMARY KEY COLLATE NOCASE, code_hash TEXT NOT NULL, salt TEXT NOT NULL,
      expires_at TEXT NOT NULL, sent_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      delivered INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS registration_challenges_expiry ON registration_challenges(expires_at);
    CREATE TABLE IF NOT EXISTS mail_deliveries (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
      recipient TEXT NOT NULL DEFAULT '', smtp_host TEXT NOT NULL DEFAULT '',
      smtp_port INTEGER NOT NULL DEFAULT 0, from_email TEXT NOT NULL DEFAULT '',
      stage TEXT NOT NULL, code TEXT, command TEXT, smtp_code INTEGER, enhanced_status TEXT,
      response TEXT, summary TEXT NOT NULL, hint TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS mail_deliveries_created ON mail_deliveries(created_at DESC);
    CREATE INDEX IF NOT EXISTS mail_deliveries_status ON mail_deliveries(status,created_at DESC);
    CREATE TABLE IF NOT EXISTS request_audits (
      id TEXT PRIMARY KEY, kind TEXT, user_id TEXT, user_name TEXT, conversation_id TEXT,
      character_id TEXT, character_name TEXT, supplier_id TEXT, supplier_name TEXT, model_id TEXT,
      protocol TEXT NOT NULL, model TEXT NOT NULL, endpoint TEXT NOT NULL, status TEXT NOT NULL,
      http_status INTEGER, duration_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      error_code TEXT, error_message TEXT, created_at TEXT NOT NULL, finished_at TEXT,
      request_id TEXT, attempt INTEGER NOT NULL DEFAULT 1, request_body TEXT, response_body TEXT,
      request_truncated INTEGER NOT NULL DEFAULT 0, response_truncated INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS request_audits_created ON request_audits(created_at DESC);
    CREATE INDEX IF NOT EXISTS request_audits_user ON request_audits(user_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS request_audits_supplier ON request_audits(supplier_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS request_audits_status ON request_audits(status,created_at DESC);
    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '',
      protocol TEXT NOT NULL DEFAULT 'openai-completions' CHECK(protocol IN ('anthropic','openai-completions','openai-responses','gemini')),
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, protocol TEXT NOT NULL CHECK(protocol IN ('anthropic','openai-completions','openai-responses','gemini')),
      supplier_id TEXT REFERENCES suppliers(id),
      kind TEXT NOT NULL DEFAULT 'language', capabilities TEXT NOT NULL DEFAULT '["text"]',
      reasoning_effort TEXT NOT NULL DEFAULT 'default', thinking_budget INTEGER,
      base_url TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
      context_window INTEGER NOT NULL DEFAULT 32768, max_output INTEGER NOT NULL DEFAULT 2048,
      temperature REAL, created_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
      description TEXT NOT NULL DEFAULT '', avatar TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#A58BBE',
      tags TEXT NOT NULL DEFAULT '[]', personality TEXT NOT NULL, greeting TEXT NOT NULL DEFAULT '',
      provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL, active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('private','group')), character_ids TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '', summary_boundary INTEGER NOT NULL DEFAULT 0,
      max_rounds INTEGER NOT NULL DEFAULT 4 CHECK(max_rounds BETWEEN 1 AND 12),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, lock_token TEXT, lock_expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS conversations_user ON conversations(user_id,updated_at DESC);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      character_id TEXT REFERENCES characters(id) ON DELETE SET NULL, content TEXT NOT NULL,
      request_id TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS messages_request ON messages(conversation_id,request_id) WHERE request_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS chat_requests (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, request_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','complete','failed')),
      response_ids TEXT NOT NULL DEFAULT '[]', error_code TEXT, error_message TEXT,
      rounds INTEGER NOT NULL DEFAULT 0, limited INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(conversation_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      content TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('manual','auto')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, source_message_id TEXT
    );
    CREATE INDEX IF NOT EXISTS memories_owner ON memories(user_id,character_id);
    CREATE TABLE IF NOT EXISTS memory_vectors (
      memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      vector TEXT, dimensions INTEGER, fingerprint TEXT, content_hash TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','ready','failed')), error_code TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_summary_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_summary_events_owner ON memory_summary_events(user_id,character_id,seq);
    CREATE TABLE IF NOT EXISTS memory_summary_state (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      last_event_seq INTEGER NOT NULL DEFAULT 0, pending_through_seq INTEGER NOT NULL DEFAULT 0,
      lock_token TEXT, lock_expires_at TEXT,
      retry_after TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,character_id)
    );
    CREATE TABLE IF NOT EXISTS api_calls (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','success','failed')),
      created_at TEXT NOT NULL, counted_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS api_calls_quota ON api_calls(user_id,status,counted_at);
    CREATE TABLE IF NOT EXISTS announcements (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO settings(key,value) VALUES
      ('registrationOpen','true'), ('defaultLimit5h','50'), ('defaultLimit7d','500'),
      ('defaultCharacterSlots','3'),
      ('maxGroupRounds','6'), ('siteDescription','"MLP 主题的 AI 角色对话平台。"'),
      ('bubbleDelimiter','""'), ('hiddenSymbols','[]'),
      ('requireEmailVerification','false'), ('emailDomainMode','"any"'), ('emailDomains','[]'),
      ('auditCaptureContent','false'), ('auditRetentionDays','7'),
      ('compressionTriggerRounds','24'), ('compressionKeepRounds','8'), ('compressionModelId','""'),
      ('memorySummaryInterval','8'), ('memorySummaryModelId','""'), ('automaticMemoryEnabled','true'),
      ('metadataEnabled','true'), ('metadataFields','["date","time","weekday","timezone","lunarDate","solarTermToday","solarTermSeason","festivals"]'),
      ('metadataTimezone','""'), ('metadataCustom','""');
                "#,
            )?;

            // Additive migrations for older databases
            for table in ["providers", "characters"] {
                if !has_column(tx, table, "deleted_at")? {
                    tx.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN deleted_at TEXT"))?;
                }
            }
            if !has_column(tx, "memories", "source_message_id")? {
                tx.execute_batch("ALTER TABLE memories ADD COLUMN source_message_id TEXT")?;
            }
            if !has_column(tx, "memory_summary_state", "pending_through_seq")? {
                tx.execute_batch(
                    "ALTER TABLE memory_summary_state ADD COLUMN pending_through_seq INTEGER NOT NULL DEFAULT 0",
                )?;
            }
            tx.execute_batch(
                "CREATE UNIQUE INDEX IF NOT EXISTS memories_source_message ON memories(user_id,character_id,source_message_id) WHERE source_message_id IS NOT NULL",
            )?;

            for (col, def) in [
                ("supplier_id", "TEXT REFERENCES suppliers(id)"),
                ("kind", "TEXT NOT NULL DEFAULT 'language'"),
                ("capabilities", "TEXT NOT NULL DEFAULT '[\"text\"]'"),
                ("reasoning_effort", "TEXT NOT NULL DEFAULT 'default'"),
                ("thinking_budget", "INTEGER"),
            ] {
                if !has_column(tx, "providers", col)? {
                    tx.execute_batch(&format!("ALTER TABLE providers ADD COLUMN {col} {def}"))?;
                }
            }
            if !has_column(tx, "suppliers", "protocol")? {
                tx.execute_batch(
                    "ALTER TABLE suppliers ADD COLUMN protocol TEXT NOT NULL DEFAULT 'openai-completions'",
                )?;
            }

            // Legacy provider -> supplier migration
            let legacy_providers: Vec<(String, String, String, String, String, String, Option<String>)> = {
                let mut stmt = tx.prepare(
                    "SELECT id,name,protocol,base_url,api_key,created_at,deleted_at FROM providers WHERE supplier_id IS NULL",
                )?;
                let rows = stmt
                    .query_map([], |r| {
                        Ok((
                            r.get(0)?,
                            r.get(1)?,
                            r.get(2)?,
                            r.get(3)?,
                            r.get(4)?,
                            r.get(5)?,
                            r.get(6)?,
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };
            for (pid, name, protocol, base_url, api_key, created_at, deleted_at) in legacy_providers
            {
                let supplier_id = new_id();
                let active = if deleted_at.is_some() { 0i64 } else { 1i64 };
                tx.execute(
                    "INSERT INTO suppliers(id,name,protocol,base_url,api_key,active,created_at,deleted_at) VALUES(?,?,?,?,?,?,?,?)",
                    rusqlite::params![
                        supplier_id,
                        name,
                        protocol,
                        base_url,
                        api_key,
                        active,
                        created_at,
                        deleted_at
                    ],
                )?;
                tx.execute(
                    "UPDATE providers SET supplier_id=?,base_url='',api_key='' WHERE id=?",
                    rusqlite::params![supplier_id, pid],
                )?;
            }
            tx.execute_batch("CREATE INDEX IF NOT EXISTS providers_supplier ON providers(supplier_id);")?;

            if !has_column(tx, "users", "character_slots")? {
                tx.execute_batch(
                    "ALTER TABLE users ADD COLUMN character_slots INTEGER NOT NULL DEFAULT 3 CHECK(character_slots >= 0 AND character_slots <= 100)",
                )?;
                let val_str: String = tx.query_row(
                    "SELECT value FROM settings WHERE key='defaultCharacterSlots'",
                    [],
                    |r| r.get(0),
                )?;
                let slots = val_str
                    .trim()
                    .parse::<i64>()
                    .ok()
                    .filter(|&v| (0..=100).contains(&v))
                    .unwrap_or(3);
                tx.execute("UPDATE users SET character_slots=?", rusqlite::params![slots])?;
            }
            if !has_column(tx, "characters", "owner_id")? {
                tx.execute_batch(
                    "ALTER TABLE characters ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE CASCADE",
                )?;
            }
            tx.execute_batch("CREATE INDEX IF NOT EXISTS characters_owner ON characters(owner_id,deleted_at)")?;
            if !has_column(tx, "users", "email_verified_at")? {
                tx.execute_batch("ALTER TABLE users ADD COLUMN email_verified_at TEXT")?;
            }
            if !has_column(tx, "users", "avatar")? {
                tx.execute_batch("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT ''")?;
            }
            if !has_column(tx, "users", "persona")? {
                tx.execute_batch(
                    r#"ALTER TABLE users ADD COLUMN persona TEXT NOT NULL DEFAULT '{"enabled":false,"name":"","species":"","pronouns":"","appearance":"","personality":"","background":""}'"#,
                )?;
            }

            if previous_version < 8 {
                let suppliers: Vec<(String, String, String, String, String, i64, String, Option<String>)> = {
                    let mut stmt = tx.prepare(
                        "SELECT id,name,protocol,base_url,api_key,active,created_at,deleted_at FROM suppliers",
                    )?;
                    let rows = stmt
                        .query_map([], |r| {
                            Ok((
                                r.get(0)?,
                                r.get(1)?,
                                r.get(2)?,
                                r.get(3)?,
                                r.get(4)?,
                                r.get(5)?,
                                r.get(6)?,
                                r.get(7)?,
                            ))
                        })?
                        .collect::<Result<Vec<_>, _>>()?;
                    rows
                };
                for (sid, sname, sproto, sbase, skey, sactive, screated, sdeleted) in suppliers {
                    let groups: Vec<String> = {
                        let mut stmt = tx.prepare(
                            "SELECT DISTINCT protocol FROM providers WHERE supplier_id=? ORDER BY protocol",
                        )?;
                        let rows = stmt
                            .query_map(rusqlite::params![sid], |r| r.get(0))?
                            .collect::<Result<Vec<_>, _>>()?;
                        rows
                    };
                    if groups.is_empty() {
                        continue;
                    }
                    let primary = if groups.iter().any(|g| g == &sproto) {
                        sproto.clone()
                    } else {
                        groups[0].clone()
                    };
                    tx.execute(
                        "UPDATE suppliers SET protocol=? WHERE id=?",
                        rusqlite::params![primary, sid],
                    )?;
                    for g in groups {
                        if g == primary {
                            continue;
                        }
                        let new_sid = new_id();
                        let prefix: String = sname.chars().take(36).collect();
                        tx.execute(
                            "INSERT INTO suppliers(id,name,protocol,base_url,api_key,active,created_at,deleted_at) VALUES(?,?,?,?,?,?,?,?)",
                            rusqlite::params![
                                new_sid,
                                format!("{prefix} · {g}"),
                                g,
                                sbase,
                                skey,
                                sactive,
                                screated,
                                sdeleted
                            ],
                        )?;
                        tx.execute(
                            "UPDATE providers SET supplier_id=? WHERE supplier_id=? AND protocol=?",
                            rusqlite::params![new_sid, sid, g],
                        )?;
                    }
                }
                if let Some(raw) = query_setting_raw(tx, "embeddingConfig")? {
                    if let Ok(config) = serde_json::from_str::<serde_json::Value>(&raw) {
                        if config.get("supplierId").and_then(|v| v.as_str()).is_none() {
                            let base_url = config
                                .get("baseUrl")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let api_key = config
                                .get("apiKey")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let model = config
                                .get("model")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let mut supplier_id = String::new();
                            if !base_url.is_empty() || !api_key.is_empty() || !model.is_empty() {
                                supplier_id = new_id();
                                let proto = if config.get("protocol").and_then(|v| v.as_str())
                                    == Some("gemini")
                                {
                                    "gemini"
                                } else {
                                    "openai-completions"
                                };
                                tx.execute(
                                    "INSERT INTO suppliers(id,name,protocol,base_url,api_key,active,created_at) VALUES(?,?,?,?,?,?,?)",
                                    rusqlite::params![
                                        supplier_id,
                                        "向量服务",
                                        proto,
                                        base_url,
                                        api_key,
                                        if base_url.is_empty() { 0 } else { 1 },
                                        now_iso()
                                    ],
                                )?;
                            }
                            let enabled = config.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false)
                                && !supplier_id.is_empty()
                                && !base_url.is_empty();
                            let top_k = config.get("topK").and_then(|v| v.as_i64()).unwrap_or(6);
                            let min_sim = config
                                .get("minSimilarity")
                                .and_then(|v| v.as_f64())
                                .unwrap_or(0.3);
                            let updated = serde_json::json!({
                                "enabled": enabled,
                                "supplierId": supplier_id,
                                "model": model,
                                "topK": top_k,
                                "minSimilarity": min_sim,
                            });
                            tx.execute(
                                "UPDATE settings SET value=? WHERE key='embeddingConfig'",
                                rusqlite::params![updated.to_string()],
                            )?;
                        }
                    }
                }
            }

            if previous_version < 9 {
                tx.execute_batch(
                    r#"INSERT OR IGNORE INTO memory_summary_events(message_id,user_id,character_id,created_at)
                    SELECT m.id,c.user_id,m.character_id,m.created_at
                    FROM chat_requests r JOIN json_each(CASE WHEN json_valid(r.response_ids) THEN r.response_ids ELSE '[]' END) j
                    JOIN messages m ON m.id=j.value AND m.conversation_id=r.conversation_id
                    JOIN conversations c ON c.id=m.conversation_id
                    WHERE m.role='assistant' AND m.character_id IS NOT NULL ORDER BY m.rowid"#,
                )?;
            }

            if previous_version < 10 {
                if let Some(raw) = query_setting_raw(tx, "embeddingConfig")? {
                    if let Ok(config) = serde_json::from_str::<serde_json::Value>(&raw) {
                        if config.get("modelId").and_then(|v| v.as_str()).is_none() {
                            let supplier_id = config
                                .get("supplierId")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let model = config
                                .get("model")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let supplier: Option<(String, i64, Option<String>)> = if !supplier_id.is_empty() {
                                let mut stmt = tx.prepare(
                                    "SELECT protocol,active,deleted_at FROM suppliers WHERE id=?",
                                )?;
                                stmt.query_row(rusqlite::params![supplier_id], |r| {
                                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                                })
                                .ok()
                            } else {
                                None
                            };
                            let mut model_id = String::new();
                            if let (Some((proto, _active, deleted)), false) =
                                (&supplier, model.is_empty())
                            {
                                let matched: Option<String> = tx
                                    .query_row(
                                        "SELECT id FROM providers WHERE supplier_id=? AND model=? AND kind='embedding' AND deleted_at IS NULL LIMIT 1",
                                        rusqlite::params![supplier_id, model],
                                        |r| r.get(0),
                                    )
                                    .ok();
                                if let Some(mid) = matched {
                                    model_id = mid;
                                } else {
                                    model_id = new_id();
                                    let name: String = format!("向量 · {model}").chars().take(60).collect();
                                    let is_active = if deleted.is_some() || proto == "anthropic" {
                                        0
                                    } else {
                                        1
                                    };
                                    tx.execute(
                                        "INSERT INTO providers(id,name,protocol,supplier_id,kind,capabilities,model,active,created_at) VALUES(?,?,?,?, 'embedding','[]',?,?,?)",
                                        rusqlite::params![model_id, name, proto, supplier_id, model, is_active, now_iso()],
                                    )?;
                                }
                            }
                            let enabled = config
                                .get("enabled")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false)
                                && !model_id.is_empty()
                                && supplier
                                    .as_ref()
                                    .map(|(p, a, d)| *a != 0 && d.is_none() && p != "anthropic")
                                    .unwrap_or(false);
                            let top_k = config.get("topK").and_then(|v| v.as_i64()).unwrap_or(6);
                            let min_sim = config
                                .get("minSimilarity")
                                .and_then(|v| v.as_f64())
                                .unwrap_or(0.3);
                            let updated = serde_json::json!({
                                "enabled": enabled,
                                "modelId": model_id,
                                "topK": top_k,
                                "minSimilarity": min_sim,
                            });
                            tx.execute(
                                "UPDATE settings SET value=? WHERE key='embeddingConfig'",
                                rusqlite::params![updated.to_string()],
                            )?;
                        }
                    }
                }
            }

            // v14 tables & columns
            tx.execute_batch(
                r#"
      CREATE TABLE IF NOT EXISTS message_attachments (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
        mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, size INTEGER NOT NULL,
        data BLOB NOT NULL, position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS message_attachments_message ON message_attachments(message_id,position);
      CREATE INDEX IF NOT EXISTS message_attachments_orphans ON message_attachments(user_id,message_id,created_at);
      CREATE INDEX IF NOT EXISTS messages_conversation_seq ON messages(conversation_id);
                "#,
            )?;
            for (col, def) in [
                ("kind", "TEXT NOT NULL DEFAULT 'note'"),
                ("importance", "REAL NOT NULL DEFAULT 0.5"),
                ("status", "TEXT NOT NULL DEFAULT 'active'"),
                ("access_count", "INTEGER NOT NULL DEFAULT 0"),
                ("last_accessed_at", "TEXT"),
                ("expires_at", "TEXT"),
                ("tags", "TEXT NOT NULL DEFAULT '[]'"),
            ] {
                if !has_column(tx, "memories", col)? {
                    tx.execute_batch(&format!("ALTER TABLE memories ADD COLUMN {col} {def}"))?;
                }
            }
            tx.execute_batch(
                "CREATE INDEX IF NOT EXISTS memories_lifecycle ON memories(user_id,character_id,status,updated_at)",
            )?;
            if !has_column(tx, "memory_summary_state", "maintained_at")? {
                tx.execute_batch("ALTER TABLE memory_summary_state ADD COLUMN maintained_at TEXT")?;
            }
            tx.execute_batch(
                r#"
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content, memory_id UNINDEXED, tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(content,memory_id) VALUES(new.content,new.id);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE OF content ON memories BEGIN
        DELETE FROM memories_fts WHERE memory_id=old.id;
        INSERT INTO memories_fts(content,memory_id) VALUES(new.content,new.id);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
        DELETE FROM memories_fts WHERE memory_id=old.id;
      END;
                "#,
            )?;
            if previous_version < 14 {
                tx.execute_batch(
                    r#"
        UPDATE memories SET kind='summary' WHERE source='auto' AND source_message_id LIKE 'summary:%';
        UPDATE memories SET importance=0.75 WHERE source='manual';
        UPDATE memories SET kind='fact',importance=0.7 WHERE source='auto' AND source_message_id IS NULL;
        DELETE FROM memories_fts;
        INSERT INTO memories_fts(content,memory_id) SELECT content,id FROM memories;
                    "#,
                )?;
            }
            tx.execute_batch("PRAGMA user_version = 14")?;
            Ok(())
        })
    }
}

fn has_column(conn: &Connection, table: &str, col: &str) -> AppResult<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == col {
            return Ok(true);
        }
    }
    Ok(false)
}

fn query_setting_raw(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    use rusqlite::OptionalExtension;
    let val = conn
        .query_row(
            "SELECT value FROM settings WHERE key=?",
            rusqlite::params![key],
            |r| r.get(0),
        )
        .optional()?;
    Ok(val)
}
