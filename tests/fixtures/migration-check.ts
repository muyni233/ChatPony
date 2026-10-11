import { Database } from 'bun:sqlite';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { getDb, closeDb } from '../../src/lib/db';
import { encrypt, decrypt } from '../../src/lib/crypto';
import { listProviders, listSuppliers } from '../../src/lib/repository';
import type { Row } from '../../src/lib/mappers';

const directory = process.env.CHATPONY_TEST_DIR;
assert.ok(directory);
process.env.DATABASE_PATH = join(directory, 'legacy.db');
process.env.ENCRYPTION_KEY = 'cd'.repeat(32);
const timestamp = '2026-01-02T03:04:05.000Z';
const encrypted = encrypt('legacy-private-key');
const legacy = new Database(process.env.DATABASE_PATH, { create: true });
try {
  // This is the previous on-disk schema: credentials on each model, no suppliers.
  legacy.exec(`
    CREATE TABLE providers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, protocol TEXT NOT NULL, base_url TEXT NOT NULL,
      model TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
      context_window INTEGER NOT NULL DEFAULT 32768, max_output INTEGER NOT NULL DEFAULT 2048,
      temperature REAL, created_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE characters (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
      description TEXT NOT NULL DEFAULT '', avatar TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#A58BBE',
      tags TEXT NOT NULL DEFAULT '[]', personality TEXT NOT NULL, greeting TEXT NOT NULL DEFAULT '',
      provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL, active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, deleted_at TEXT
    );
    PRAGMA user_version=3;
  `);
  legacy
    .query(
      "INSERT INTO providers(id,name,protocol,base_url,model,api_key,created_at) VALUES('existing-model','Existing','openai-completions','https://legacy.example/v1','old-model',?,?)",
    )
    .run(encrypted, timestamp);
  legacy
    .query(
      "INSERT INTO providers(id,name,protocol,base_url,model,active,created_at) VALUES('disabled-model','Disabled','gemini','https://second.example/v1beta','other-model',0,?)",
    )
    .run(timestamp);
  legacy
    .query(
      "INSERT INTO characters(rowid,id,name,slug,personality,provider_id,active,created_at) VALUES(117,'existing-character','Character','existing-character','private persona','existing-model',1,?)",
    )
    .run(timestamp);
} finally {
  legacy.close();
}

try {
  const db = getDb();
  assert.equal((db.query('PRAGMA user_version').get() as Row).user_version, 11);
  const suppliers = listSuppliers();
  assert.equal(suppliers.length, 2);
  const models = listProviders();
  const model = models.find((item) => item.id === 'existing-model');
  assert.ok(model);
  assert.equal(model.baseUrl, 'https://legacy.example/v1');
  assert.equal(model.hasKey, true);
  assert.equal(model.createdAt, timestamp);
  assert.equal(model.supplierActive, true);
  assert.equal(models.find((item) => item.id === 'disabled-model')?.active, false);
  assert.equal(
    decrypt(
      String(
        (db.query('SELECT api_key FROM suppliers WHERE id=?').get(model.supplierId) as Row).api_key,
      ),
    ),
    'legacy-private-key',
  );
  assert.deepEqual(
    db.query("SELECT base_url,api_key FROM providers WHERE id='existing-model'").get(),
    { base_url: '', api_key: '' },
  );
  assert.deepEqual(
    db
      .query(
        "SELECT rowid AS sequence,id,provider_id,active FROM characters WHERE id='existing-character'",
      )
      .get(),
    { sequence: 117, id: 'existing-character', provider_id: 'existing-model', active: 1 },
  );
  assert.deepEqual(db.query('PRAGMA foreign_key_check').all(), []);
  closeDb();
  const reopened = getDb();
  assert.equal((reopened.query('SELECT COUNT(*) AS count FROM suppliers').get() as Row).count, 2);
  assert.equal(
    (reopened.query("SELECT supplier_id FROM providers WHERE id='existing-model'").get() as Row)
      .supplier_id,
    model.supplierId,
  );
  console.log('Migration check passed');
} finally {
  closeDb();
}
