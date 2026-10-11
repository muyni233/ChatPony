import { Database } from 'bun:sqlite';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { getDb, closeDb } from '../../src/lib/db';
import { encrypt, decrypt } from '../../src/lib/crypto';
import { listProviders } from '../../src/lib/repository';
import { getEmbeddingSettings } from '../../src/lib/ai/embeddings';
import type { Row } from '../../src/lib/mappers';

const directory = process.env.CHATPONY_TEST_DIR;
assert.ok(directory);
process.env.DATABASE_PATH = join(directory, 'protocol-legacy.db');
process.env.ENCRYPTION_KEY = 'f3'.repeat(32);
const modelKey = encrypt('shared-model-secret');
const vectorKey = encrypt('old-vector-secret');
const timestamp = '2026-03-04T05:06:07.000Z';
const legacy = new Database(process.env.DATABASE_PATH, { create: true });
try {
  legacy.exec(`
    CREATE TABLE suppliers(id TEXT PRIMARY KEY,name TEXT NOT NULL,base_url TEXT NOT NULL,api_key TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,deleted_at TEXT);
    CREATE TABLE providers(id TEXT PRIMARY KEY,name TEXT NOT NULL,protocol TEXT NOT NULL,supplier_id TEXT REFERENCES suppliers(id),base_url TEXT NOT NULL DEFAULT '',model TEXT NOT NULL,api_key TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 1,context_window INTEGER NOT NULL DEFAULT 32768,max_output INTEGER NOT NULL DEFAULT 2048,temperature REAL,created_at TEXT NOT NULL,deleted_at TEXT);
    CREATE TABLE characters(id TEXT PRIMARY KEY,name TEXT NOT NULL,slug TEXT NOT NULL UNIQUE,description TEXT NOT NULL DEFAULT '',avatar TEXT NOT NULL DEFAULT '',color TEXT NOT NULL DEFAULT '#aabbcc',tags TEXT NOT NULL DEFAULT '[]',personality TEXT NOT NULL,greeting TEXT NOT NULL DEFAULT '',provider_id TEXT REFERENCES providers(id),active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,deleted_at TEXT);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    PRAGMA user_version=7;
  `);
  legacy
    .query(
      "INSERT INTO suppliers(id,name,base_url,api_key,created_at) VALUES('shared','Shared','https://provider.example/v1',?,?)",
    )
    .run(modelKey, timestamp);
  legacy
    .query(
      "INSERT INTO providers(id,name,protocol,supplier_id,model,created_at) VALUES('model-chat','Chat','openai-completions','shared','chat-model',?),('model-native','Native','gemini','shared','native-model',?)",
    )
    .run(timestamp, timestamp);
  legacy
    .query(
      "INSERT INTO characters(rowid,id,name,slug,personality,provider_id,created_at) VALUES(101,'first','First','first','Persona one','model-chat',?),(405,'second','Second','second','Persona two','model-native',?)",
    )
    .run(timestamp, timestamp);
  legacy.query("INSERT INTO settings(key,value) VALUES('embeddingConfig',?)").run(
    JSON.stringify({
      enabled: true,
      protocol: 'gemini',
      baseUrl: 'https://vectors.example/v1beta',
      model: 'old-vector-model',
      apiKey: vectorKey,
      topK: 3,
      minSimilarity: 0.2,
    }),
  );
} finally {
  legacy.close();
}

try {
  const db = getDb();
  const models = listProviders();
  const chat = models.find((model) => model.id === 'model-chat');
  const native = models.find((model) => model.id === 'model-native');
  assert.ok(chat && native);
  assert.equal(chat.supplierId, 'shared');
  assert.equal(chat.protocol, 'openai-completions');
  assert.equal(native.protocol, 'gemini');
  assert.notEqual(native.supplierId, chat.supplierId);
  const cloned = db.query('SELECT * FROM suppliers WHERE id=?').get(native.supplierId) as Row;
  assert.equal(cloned.api_key, modelKey);
  assert.equal(cloned.base_url, 'https://provider.example/v1');
  assert.equal(cloned.created_at, timestamp);
  assert.deepEqual(
    db.query('SELECT rowid AS seq,id,provider_id FROM characters ORDER BY rowid').all(),
    [
      { seq: 101, id: 'first', provider_id: 'model-chat' },
      { seq: 405, id: 'second', provider_id: 'model-native' },
    ],
  );
  const canonical = JSON.parse(
    String((db.query("SELECT value FROM settings WHERE key='embeddingConfig'").get() as Row).value),
  );
  assert.deepEqual(Object.keys(canonical).sort(), ['enabled', 'minSimilarity', 'modelId', 'topK']);
  const registeredEmbedding = db
    .query('SELECT * FROM providers WHERE id=?')
    .get(canonical.modelId) as Row;
  assert.equal(registeredEmbedding.kind, 'embedding');
  assert.equal(registeredEmbedding.capabilities, '[]');
  const vectorSupplier = db
    .query('SELECT * FROM suppliers WHERE id=?')
    .get(String(registeredEmbedding.supplier_id)) as Row;
  assert.equal(vectorSupplier.protocol, 'gemini');
  assert.equal(vectorSupplier.api_key, vectorKey);
  assert.equal(decrypt(String(vectorSupplier.api_key)), 'old-vector-secret');
  const embedding = getEmbeddingSettings();
  assert.equal(embedding.enabled, true);
  assert.equal(embedding.protocol, 'gemini');
  assert.equal(embedding.model, 'old-vector-model');
  assert.equal(embedding.baseUrl, 'https://vectors.example/v1beta');
  assert.equal(embedding.topK, 3);
  assert.equal(embedding.minSimilarity, 0.2);
  assert.ok(!JSON.stringify(embedding).includes('old-vector-secret'));
  assert.deepEqual(db.query('PRAGMA foreign_key_check').all(), []);
  const expectedSupplier = native.supplierId;
  closeDb();
  assert.equal((getDb().query('SELECT COUNT(*) AS count FROM suppliers').get() as Row).count, 3);
  assert.equal(
    (getDb().query("SELECT supplier_id FROM providers WHERE id='model-native'").get() as Row)
      .supplier_id,
    expectedSupplier,
  );

  closeDb();
  process.env.DATABASE_PATH = join(directory, 'empty-embedding.db');
  const emptyLegacy = new Database(process.env.DATABASE_PATH, { create: true });
  emptyLegacy.exec(
    'CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); PRAGMA user_version=7;',
  );
  emptyLegacy.query("INSERT INTO settings(key,value) VALUES('embeddingConfig',?)").run(
    JSON.stringify({
      enabled: false,
      protocol: 'openai',
      baseUrl: '',
      model: '',
      apiKey: '',
      topK: 6,
      minSimilarity: 0.3,
    }),
  );
  emptyLegacy.close();
  assert.equal((getDb().query('SELECT COUNT(*) AS count FROM suppliers').get() as Row).count, 0);
  assert.equal(getEmbeddingSettings().supplierId, '');
  assert.equal(getEmbeddingSettings().enabled, false);
  console.log('Supplier protocol migration passed');
} finally {
  closeDb();
}
