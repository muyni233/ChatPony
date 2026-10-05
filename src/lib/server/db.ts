import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

type DatabaseHolder = typeof globalThis & {
  __chatponyDatabase?: DatabaseSync;
  __chatponyDatabasePath?: string;
};

export function databasePath() {
  return resolve(/* turbopackIgnore: true */ process.env.DATABASE_PATH || 'data/chatpony.sqlite');
}

export function getDb(): DatabaseSync {
  const state = globalThis as DatabaseHolder;
  const path = databasePath();
  if (state.__chatponyDatabase && state.__chatponyDatabasePath === path)
    return state.__chatponyDatabase;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  // Keep additive migrations serial across Node workers sharing this file.
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
      disabled INTEGER NOT NULL DEFAULT 0, email_verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, english_name TEXT NOT NULL DEFAULT '',
      subtitle TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', personality TEXT NOT NULL,
      greeting TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#84749a', avatar TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]', published INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, protocol TEXT NOT NULL,
      base_url TEXT NOT NULL, model TEXT NOT NULL, context_window INTEGER NOT NULL DEFAULT 32768,
      max_output_tokens INTEGER NOT NULL DEFAULT 2048, temperature REAL NOT NULL DEFAULT 0.8,
      enabled INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0,
      api_key_cipher TEXT NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX IF NOT EXISTS providers_one_default ON providers(is_default) WHERE is_default = 1;
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('direct','group')), character_ids TEXT NOT NULL,
      scene TEXT NOT NULL DEFAULT '', provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
      summary TEXT NOT NULL DEFAULT '', summary_message_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS conversations_owner ON conversations(user_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')), character_id TEXT,
      content TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, created_at, id);
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memories_owner ON memories(user_id, character_id);
    CREATE TABLE IF NOT EXISTS favorites (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      PRIMARY KEY(user_id, character_id)
    );
    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(expires_at);
    CREATE TABLE IF NOT EXISTS reset_tokens (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS verification_tokens (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL, new_email TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS generation_locks (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      lock_id TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS completed_turns (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, input_hash TEXT NOT NULL, messages TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(conversation_id, request_id)
    );
    CREATE TABLE IF NOT EXISTS quota_usage (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL, request_id TEXT NOT NULL, charged_at INTEGER NOT NULL,
      quota_5h_epoch INTEGER NOT NULL DEFAULT 0, quota_1d_epoch INTEGER NOT NULL DEFAULT 0, quota_7d_epoch INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id, conversation_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS quota_usage_window ON quota_usage(user_id, charged_at);
    CREATE TABLE IF NOT EXISTS quota_reservations (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL, request_id TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      UNIQUE(user_id, conversation_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS quota_reservations_user ON quota_reservations(user_id, expires_at);
    CREATE INDEX IF NOT EXISTS quota_reservations_expiry ON quota_reservations(expires_at);
    CREATE TABLE IF NOT EXISTS request_audit (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, finished_at INTEGER,
      status TEXT NOT NULL CHECK(status IN ('pending','success','error','cancelled','rejected','replayed')),
      user_id TEXT NOT NULL, username TEXT NOT NULL, conversation_id TEXT NOT NULL, conversation_title TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('direct','group')), provider_id TEXT, provider_name TEXT, protocol TEXT, model TEXT,
      character_names TEXT NOT NULL DEFAULT '[]', duration_ms INTEGER,
      reply_count INTEGER NOT NULL DEFAULT 0, output_characters INTEGER NOT NULL DEFAULT 0,
      quota_charged INTEGER NOT NULL DEFAULT 0 CHECK(quota_charged IN (0,1)), error_code TEXT, error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS request_audit_time ON request_audit(created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS request_audit_status_time ON request_audit(status,created_at DESC);
    CREATE TABLE IF NOT EXISTS announcements (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','published')), pinned INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1, published_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS announcements_published ON announcements(status,pinned DESC,published_at DESC);
    CREATE TABLE IF NOT EXISTS announcement_reads (
      announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, read_at TEXT NOT NULL,
      PRIMARY KEY(announcement_id,user_id)
    );
    CREATE INDEX IF NOT EXISTS announcement_reads_user ON announcement_reads(user_id);
  `);
    const columns = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'email_verified'))
      db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1');
    if (!columns.some((column) => column.name === 'quota_5h'))
      db.exec(
        'ALTER TABLE users ADD COLUMN quota_5h INTEGER CHECK(quota_5h IS NULL OR (quota_5h BETWEEN 0 AND 1000000))',
      );
    if (!columns.some((column) => column.name === 'quota_7d'))
      db.exec(
        'ALTER TABLE users ADD COLUMN quota_7d INTEGER CHECK(quota_7d IS NULL OR (quota_7d BETWEEN 0 AND 1000000))',
      );
    if (!columns.some((column) => column.name === 'quota_1d'))
      db.exec(
        'ALTER TABLE users ADD COLUMN quota_1d INTEGER CHECK(quota_1d IS NULL OR (quota_1d BETWEEN 0 AND 1000000))',
      );
    for (const window of ['5h', '1d', '7d']) {
      if (!columns.some((column) => column.name === `quota_${window}_enabled`))
        db.exec(
          `ALTER TABLE users ADD COLUMN quota_${window}_enabled INTEGER CHECK(quota_${window}_enabled IS NULL OR quota_${window}_enabled IN (0,1))`,
        );
      if (!columns.some((column) => column.name === `quota_${window}_epoch`))
        db.exec(`ALTER TABLE users ADD COLUMN quota_${window}_epoch INTEGER NOT NULL DEFAULT 0`);
    }
    const usageColumns = db.prepare('PRAGMA table_info(quota_usage)').all() as { name: string }[];
    for (const window of ['5h', '1d', '7d']) {
      if (!usageColumns.some((column) => column.name === `quota_${window}_epoch`))
        db.exec(
          `ALTER TABLE quota_usage ADD COLUMN quota_${window}_epoch INTEGER NOT NULL DEFAULT 0`,
        );
    }
    const verificationColumns = db.prepare('PRAGMA table_info(verification_tokens)').all() as {
      name: string;
    }[];
    if (!verificationColumns.some((column) => column.name === 'new_email'))
      db.exec('ALTER TABLE verification_tokens ADD COLUMN new_email TEXT');
    db.exec('PRAGMA user_version = 6');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }
  state.__chatponyDatabase = db;
  state.__chatponyDatabasePath = path;
  return db;
}

export function transaction<T>(operation: () => T): T {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function now() {
  return new Date().toISOString();
}
