import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA_VERSION = 11;
const globalDb = globalThis as typeof globalThis & {
  __chatponyDb?: Database;
  __chatponyDbPath?: string;
  __chatponySchemaVersion?: number;
};

export const id = (): string => randomUUID();
export const now = (): string => new Date().toISOString();

export function getDb(): Database {
  const configured = process.env.DATABASE_PATH || './data/chatpony.db';
  const path = configured === ':memory:' ? configured : resolve(configured);
  if (
    globalDb.__chatponyDb &&
    globalDb.__chatponyDbPath === path &&
    globalDb.__chatponySchemaVersion === SCHEMA_VERSION
  )
    return globalDb.__chatponyDb;
  const existing = globalDb.__chatponyDbPath === path ? globalDb.__chatponyDb : undefined;
  if (globalDb.__chatponyDb && !existing) globalDb.__chatponyDb.close();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = existing || new Database(path, { create: true, strict: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.transaction(() => {
    const previousVersion = Number(
      (db.query('PRAGMA user_version').get() as { user_version: number }).user_version,
    );
    db.exec(`
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
      ('maxGroupRounds','6'), ('siteDescription','"与熟悉的角色，开启新的故事。"'),
      ('bubbleDelimiter','""'), ('hiddenSymbols','[]'),
      ('requireEmailVerification','false'), ('emailDomainMode','"any"'), ('emailDomains','[]'),
      ('auditCaptureContent','false'), ('auditRetentionDays','7'),
      ('compressionTriggerRounds','24'), ('compressionKeepRounds','8'), ('compressionModelId','""'),
      ('memorySummaryInterval','8'), ('memorySummaryModelId','""'), ('automaticMemoryEnabled','true'),
      ('metadataEnabled','true'), ('metadataFields','["date","time","weekday","timezone","lunarDate","solarTermToday","solarTermSeason","festivals"]'),
      ('metadataTimezone','""'), ('metadataCustom','""');
  `);
    // Small additive migrations also cover databases opened during local setup.
    for (const table of ['providers', 'characters']) {
      const columns = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!columns.some((column) => column.name === 'deleted_at'))
        db.exec(`ALTER TABLE ${table} ADD COLUMN deleted_at TEXT`);
    }
    const memoryColumns = db.query('PRAGMA table_info(memories)').all() as { name: string }[];
    if (!memoryColumns.some((column) => column.name === 'source_message_id'))
      db.exec('ALTER TABLE memories ADD COLUMN source_message_id TEXT');
    const memoryStateColumns = db.query('PRAGMA table_info(memory_summary_state)').all() as {
      name: string;
    }[];
    if (!memoryStateColumns.some((column) => column.name === 'pending_through_seq'))
      db.exec(
        'ALTER TABLE memory_summary_state ADD COLUMN pending_through_seq INTEGER NOT NULL DEFAULT 0',
      );
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS memories_source_message ON memories(user_id,character_id,source_message_id) WHERE source_message_id IS NOT NULL',
    );
    const providerColumns = db.query('PRAGMA table_info(providers)').all() as { name: string }[];
    if (!providerColumns.some((column) => column.name === 'supplier_id'))
      db.exec('ALTER TABLE providers ADD COLUMN supplier_id TEXT REFERENCES suppliers(id)');
    if (!providerColumns.some((column) => column.name === 'kind'))
      db.exec("ALTER TABLE providers ADD COLUMN kind TEXT NOT NULL DEFAULT 'language'");
    if (!providerColumns.some((column) => column.name === 'capabilities'))
      db.exec(`ALTER TABLE providers ADD COLUMN capabilities TEXT NOT NULL DEFAULT '["text"]'`);
    if (!providerColumns.some((column) => column.name === 'reasoning_effort'))
      db.exec("ALTER TABLE providers ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'default'");
    if (!providerColumns.some((column) => column.name === 'thinking_budget'))
      db.exec('ALTER TABLE providers ADD COLUMN thinking_budget INTEGER');
    const supplierColumns = db.query('PRAGMA table_info(suppliers)').all() as { name: string }[];
    if (!supplierColumns.some((column) => column.name === 'protocol'))
      db.exec(
        "ALTER TABLE suppliers ADD COLUMN protocol TEXT NOT NULL DEFAULT 'openai-completions'",
      );
    // Preserve every model ID and all character bindings while moving credentials
    // into a parent supplier. This is atomic and safe to run again after a restart.
    const legacyProviders = db
      .query(
        'SELECT id,name,protocol,base_url,api_key,created_at,deleted_at FROM providers WHERE supplier_id IS NULL',
      )
      .all() as Record<string, unknown>[];
    for (const provider of legacyProviders) {
      const supplierId = id();
      db.query(
        'INSERT INTO suppliers(id,name,protocol,base_url,api_key,active,created_at,deleted_at) VALUES(?,?,?,?,?,?,?,?)',
      ).run(
        supplierId,
        String(provider.name),
        String(provider.protocol),
        String(provider.base_url),
        String(provider.api_key),
        provider.deleted_at ? 0 : 1,
        String(provider.created_at),
        provider.deleted_at ? String(provider.deleted_at) : null,
      );
      db.query("UPDATE providers SET supplier_id=?,base_url='',api_key='' WHERE id=?").run(
        supplierId,
        String(provider.id),
      );
    }
    db.exec('CREATE INDEX IF NOT EXISTS providers_supplier ON providers(supplier_id);');
    const userColumns = db.query('PRAGMA table_info(users)').all() as { name: string }[];
    if (!userColumns.some((column) => column.name === 'email_verified_at'))
      db.exec('ALTER TABLE users ADD COLUMN email_verified_at TEXT');
    if (!userColumns.some((column) => column.name === 'avatar'))
      db.exec("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT ''");
    if (!userColumns.some((column) => column.name === 'persona'))
      db.exec(
        `ALTER TABLE users ADD COLUMN persona TEXT NOT NULL DEFAULT '{"enabled":false,"name":"","species":"","pronouns":"","appearance":"","personality":"","background":""}'`,
      );
    if (previousVersion < 8) {
      // A legacy shared supplier could contain models using different protocols.
      // Split those groups before the parent protocol becomes authoritative.
      const suppliers = db.query('SELECT * FROM suppliers').all() as Record<string, unknown>[];
      for (const supplier of suppliers) {
        const groups = db
          .query('SELECT DISTINCT protocol FROM providers WHERE supplier_id=? ORDER BY protocol')
          .all(String(supplier.id)) as { protocol: string }[];
        if (!groups.length) continue;
        const primary = groups.some((group) => group.protocol === supplier.protocol)
          ? String(supplier.protocol)
          : groups[0].protocol;
        db.query('UPDATE suppliers SET protocol=? WHERE id=?').run(primary, String(supplier.id));
        for (const group of groups) {
          if (group.protocol === primary) continue;
          const supplierId = id();
          db.query(
            'INSERT INTO suppliers(id,name,protocol,base_url,api_key,active,created_at,deleted_at) VALUES(?,?,?,?,?,?,?,?)',
          ).run(
            supplierId,
            `${String(supplier.name).slice(0, 36)} · ${group.protocol}`,
            group.protocol,
            String(supplier.base_url),
            String(supplier.api_key),
            Number(supplier.active),
            String(supplier.created_at),
            supplier.deleted_at ? String(supplier.deleted_at) : null,
          );
          db.query('UPDATE providers SET supplier_id=? WHERE supplier_id=? AND protocol=?').run(
            supplierId,
            String(supplier.id),
            group.protocol,
          );
        }
      }
      const row = db.query("SELECT value FROM settings WHERE key='embeddingConfig'").get() as {
        value: string;
      } | null;
      if (row) {
        const config = JSON.parse(row.value) as Record<string, unknown>;
        if (typeof config.supplierId !== 'string') {
          const baseUrl = String(config.baseUrl || '');
          const apiKey = String(config.apiKey || '');
          const model = String(config.model || '');
          let supplierId = '';
          if (baseUrl || apiKey || model) {
            supplierId = id();
            db.query(
              'INSERT INTO suppliers(id,name,protocol,base_url,api_key,active,created_at) VALUES(?,?,?,?,?,?,?)',
            ).run(
              supplierId,
              '向量服务',
              config.protocol === 'gemini' ? 'gemini' : 'openai-completions',
              baseUrl,
              apiKey,
              baseUrl ? 1 : 0,
              now(),
            );
          }
          db.query("UPDATE settings SET value=? WHERE key='embeddingConfig'").run(
            JSON.stringify({
              enabled: Boolean(config.enabled && supplierId && baseUrl),
              supplierId,
              model,
              topK: config.topK ?? 6,
              minSimilarity: config.minSimilarity ?? 0.3,
            }),
          );
        }
      }
    }
    if (previousVersion < 9) {
      db.query(
        `INSERT OR IGNORE INTO memory_summary_events(message_id,user_id,character_id,created_at)
        SELECT m.id,c.user_id,m.character_id,m.created_at
        FROM chat_requests r JOIN json_each(CASE WHEN json_valid(r.response_ids) THEN r.response_ids ELSE '[]' END) j
        JOIN messages m ON m.id=j.value AND m.conversation_id=r.conversation_id
        JOIN conversations c ON c.id=m.conversation_id
        WHERE m.role='assistant' AND m.character_id IS NOT NULL ORDER BY m.rowid`,
      ).run();
    }
    if (previousVersion < 10) {
      const row = db.query("SELECT value FROM settings WHERE key='embeddingConfig'").get() as {
        value: string;
      } | null;
      if (row) {
        const config = JSON.parse(row.value) as Record<string, unknown>;
        if (typeof config.modelId !== 'string') {
          const supplierId = String(config.supplierId || '');
          const model = String(config.model || '');
          const supplier = supplierId
            ? (db.query('SELECT * FROM suppliers WHERE id=?').get(supplierId) as Record<
                string,
                unknown
              > | null)
            : null;
          let modelId = '';
          if (supplier && model) {
            const matched = db
              .query(
                "SELECT id FROM providers WHERE supplier_id=? AND model=? AND kind='embedding' AND deleted_at IS NULL LIMIT 1",
              )
              .get(supplierId, model) as { id: string } | null;
            modelId = matched?.id || id();
            if (!matched)
              db.query(
                "INSERT INTO providers(id,name,protocol,supplier_id,kind,capabilities,model,active,created_at) VALUES(?,?,?,?, 'embedding','[]',?,?,?)",
              ).run(
                modelId,
                `向量 · ${model}`.slice(0, 60),
                String(supplier.protocol),
                supplierId,
                model,
                supplier.deleted_at || supplier.protocol === 'anthropic' ? 0 : 1,
                now(),
              );
          }
          db.query("UPDATE settings SET value=? WHERE key='embeddingConfig'").run(
            JSON.stringify({
              enabled: Boolean(
                config.enabled &&
                  modelId &&
                  supplier?.active &&
                  !supplier.deleted_at &&
                  supplier.protocol !== 'anthropic',
              ),
              modelId,
              topK: config.topK ?? 6,
              minSimilarity: config.minSimilarity ?? 0.3,
            }),
          );
        }
      }
    }
    db.exec('PRAGMA user_version=11');
  }).immediate();
  globalDb.__chatponyDb = db;
  globalDb.__chatponyDbPath = path;
  globalDb.__chatponySchemaVersion = SCHEMA_VERSION;
  return db;
}

/** Primarily useful to isolated test processes and maintenance scripts. */
export function closeDb(): void {
  globalDb.__chatponyDb?.close();
  delete globalDb.__chatponyDb;
  delete globalDb.__chatponyDbPath;
  delete globalDb.__chatponySchemaVersion;
}
