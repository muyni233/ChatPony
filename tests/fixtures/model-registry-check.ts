import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { getDb, closeDb, id, now } from '../../src/lib/db';
import { createSession } from '../../src/lib/auth';
import { getEmbeddingSettings } from '../../src/lib/ai/embeddings';
import { getSettings, listProviders } from '../../src/lib/repository';
import { GET, POST, PATCH } from '../../src/app/api/[...path]/route';
import type { Row } from '../../src/lib/mappers';

const directory = process.env.CHATPONY_TEST_DIR;
assert.ok(directory);
process.env.DATABASE_PATH = join(directory, 'models.db');
process.env.ENCRYPTION_KEY = '73'.repeat(32);
let session = '';
async function call(method: 'GET' | 'POST' | 'PATCH', path: string, input?: unknown) {
  const response = await { GET, POST, PATCH }[method](
    new Request(`http://local.test/api/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: session.split(';')[0] },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    }),
    { params: Promise.resolve({ path: path.split('/') }) },
  );
  return {
    ...((await response.json()) as { data: Record<string, unknown>; error?: { code: string } }),
    status: response.status,
  };
}

try {
  const db = getDb();
  const adminId = id();
  db.query(
    "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,'admin@example.test','Admin','unused','admin',?)",
  ).run(adminId, now());
  session = createSession(adminId);
  const suppliers: Record<string, string> = {};
  for (const protocol of ['openai-completions', 'anthropic', 'gemini']) {
    const supplier = await call('POST', 'admin/suppliers', {
      name: protocol,
      protocol,
      baseUrl: 'https://service.example/v1',
    });
    assert.equal(supplier.status, 201);
    suppliers[protocol] = String(supplier.data.id);
  }
  const language = await call('POST', 'admin/models', {
    name: 'Reasoning model',
    supplierId: suppliers['openai-completions'],
    model: 'reasoning-model',
    kind: 'language',
    capabilities: ['image', 'audio', 'image', 'file'],
    reasoningEffort: 'max',
  });
  assert.equal(language.status, 201);
  assert.deepEqual(language.data.capabilities, ['text', 'image', 'audio', 'file']);
  assert.equal(language.data.reasoningEffort, 'max');
  const languageId = String(language.data.id);
  assert.equal(
    (await call('PATCH', `admin/models/${languageId}`, { thinkingBudget: 128 })).status,
    400,
  );
  assert.equal(
    (await call('PATCH', `admin/models/${languageId}`, { capabilities: ['video'] })).status,
    400,
  );
  assert.equal(
    (await call('PATCH', `admin/models/${languageId}`, { protocol: 'gemini' })).status,
    400,
  );
  const vector = await call('POST', 'admin/models', {
    name: 'Vector model',
    supplierId: suppliers['openai-completions'],
    model: 'vector-model',
    kind: 'embedding',
    capabilities: ['image'],
    reasoningEffort: 'high',
    thinkingBudget: 128,
  });
  assert.equal(vector.status, 201);
  assert.deepEqual(vector.data.capabilities, []);
  assert.equal(vector.data.reasoningEffort, 'default');
  assert.equal(vector.data.thinkingBudget, null);
  const vectorId = String(vector.data.id);
  assert.equal(
    (await call('PATCH', 'admin/embeddings', { enabled: true, modelId: languageId })).status,
    404,
  );
  assert.equal(
    (await call('PATCH', 'admin/embeddings', { enabled: true, modelId: vectorId })).status,
    200,
  );
  assert.equal(getEmbeddingSettings().supplierId, suppliers['openai-completions']);
  assert.equal(
    (await call('PATCH', 'admin/embeddings', { supplierId: suppliers['openai-completions'] }))
      .status,
    400,
  );
  assert.equal(
    (
      await call('POST', 'admin/characters', {
        name: 'Invalid',
        slug: 'invalid',
        personality: 'x',
        providerId: vectorId,
        active: false,
      })
    ).error?.code,
    'LANGUAGE_MODEL_REQUIRED',
  );
  assert.equal(
    (await call('PATCH', 'admin/settings', { compressionModelId: vectorId })).error?.code,
    'MAINTENANCE_MODEL_UNAVAILABLE',
  );
  const role = await call('POST', 'admin/characters', {
    name: 'Role',
    slug: 'role',
    personality: 'Role persona',
    providerId: languageId,
    active: true,
  });
  assert.equal(role.status, 201);
  await call('PATCH', 'admin/settings', {
    compressionModelId: languageId,
    memorySummaryModelId: languageId,
  });
  assert.equal(
    (await call('PATCH', `admin/models/${languageId}`, { kind: 'embedding' })).status,
    200,
  );
  assert.equal(
    (db.query('SELECT active FROM characters WHERE id=?').get(String(role.data.id)) as Row).active,
    0,
  );
  assert.equal(getSettings().compressionModelId, '');
  assert.equal(getSettings().memorySummaryModelId, '');
  assert.equal((await call('GET', 'characters')).data.length, 0);
  assert.equal((await call('PATCH', `admin/models/${vectorId}`, { kind: 'language' })).status, 200);
  assert.equal(getEmbeddingSettings().enabled, false);
  assert.equal(getEmbeddingSettings().modelId, '');
  assert.equal(
    (
      await call('POST', 'admin/models', {
        name: 'Invalid vector',
        supplierId: suppliers.anthropic,
        model: 'vector',
        kind: 'embedding',
      })
    ).error?.code,
    'EMBEDDING_PROTOCOL_UNSUPPORTED',
  );
  assert.equal(
    (
      await call('POST', 'admin/models', {
        name: 'Draft vector',
        supplierId: suppliers.anthropic,
        model: 'vector',
        kind: 'embedding',
        active: false,
      })
    ).status,
    201,
  );
  const anthropic = await call('POST', 'admin/models', {
    name: 'Thinking',
    supplierId: suppliers.anthropic,
    model: 'claude-test',
    thinkingBudget: 1024,
    maxOutput: 2048,
  });
  assert.equal(anthropic.status, 201);
  assert.equal(anthropic.data.thinkingBudget, 1024);
  assert.equal(
    (await call('PATCH', `admin/models/${anthropic.data.id}`, { reasoningEffort: 'high' })).status,
    400,
  );
  assert.equal(
    (
      await call('PATCH', `admin/models/${anthropic.data.id}`, {
        thinkingBudget: null,
        reasoningEffort: 'minimal',
      })
    ).status,
    400,
  );
  assert.equal(
    (await call('PATCH', `admin/models/${anthropic.data.id}`, { thinkingBudget: 512 })).status,
    400,
  );
  assert.equal(
    (
      await call('POST', 'admin/models', {
        name: 'Gemini',
        supplierId: suppliers.gemini,
        model: 'gemini-3-test',
        reasoningEffort: 'none',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call('POST', 'admin/models', {
        name: 'Gemini',
        supplierId: suppliers.gemini,
        model: 'gemini-2.5-pro',
        reasoningEffort: 'high',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call('POST', 'admin/models', {
        name: 'Gemini',
        supplierId: suppliers.gemini,
        model: 'gemini-model',
        reasoningEffort: 'xhigh',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call('POST', 'admin/models', {
        name: 'Gemini',
        supplierId: suppliers.gemini,
        model: 'gemini-2.5-pro',
        thinkingBudget: 128,
      })
    ).status,
    201,
  );

  // Simulate the immediately previous configuration pointing at a model name
  // already used by a language model bound to a role. Migration must clone.
  await call('PATCH', `admin/models/${vectorId}`, { model: 'shared-name', kind: 'language' });
  const bound = await call('POST', 'admin/characters', {
    name: 'Bound',
    slug: 'bound',
    personality: 'bound persona',
    providerId: vectorId,
    active: true,
  });
  assert.equal(bound.status, 201);
  db.query("UPDATE settings SET value=? WHERE key='embeddingConfig'").run(
    JSON.stringify({
      enabled: true,
      supplierId: suppliers['openai-completions'],
      model: 'shared-name',
      topK: 4,
      minSimilarity: 0.2,
    }),
  );
  db.exec('PRAGMA user_version=9');
  closeDb();
  const migrated = getDb();
  const selection = getEmbeddingSettings();
  assert.equal(selection.enabled, true);
  assert.notEqual(selection.modelId, vectorId);
  assert.equal(
    (migrated.query('SELECT kind FROM providers WHERE id=?').get(selection.modelId) as Row).kind,
    'embedding',
  );
  assert.equal(
    (migrated.query('SELECT kind FROM providers WHERE id=?').get(vectorId) as Row).kind,
    'language',
  );
  assert.equal(
    (
      migrated
        .query('SELECT provider_id,active FROM characters WHERE id=?')
        .get(String(bound.data.id)) as Row
    ).provider_id,
    vectorId,
  );
  const count = listProviders().length;
  closeDb();
  assert.equal(listProviders().length, count);
  console.log('Model registry check passed');
} finally {
  closeDb();
}
