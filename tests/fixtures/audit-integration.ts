import assert from 'node:assert/strict';
import { getDb, id, now, closeDb } from '../../src/lib/db';
import { encrypt } from '../../src/lib/crypto';
import { createSession } from '../../src/lib/auth';
import { getQuota } from '../../src/lib/quota';
import { toProvider, type Row } from '../../src/lib/mappers';
import {
  beginAudit,
  finishAudit,
  getAudit,
  getAuditStats,
  listAudit,
  reportedUsage,
  sanitizedEndpoint,
} from '../../src/lib/audit';
import { generateText, type ModelProvider } from '../../src/lib/ai/protocols';
import { testEmbedding, updateEmbeddingSettings } from '../../src/lib/ai/embeddings';
import { testProvider } from '../../src/lib/chat';
import { GET } from '../../src/app/api/[...path]/route';

const db = getDb();
const key = 'secret-upstream-fixture-key';
let mode: 'normal' | 'retry' | 'hold' | 'empty' = 'normal';
let retries = 0;
let release: (() => void) | undefined;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = (await request.json()) as Record<string, unknown>;
    if (path.endsWith('/embeddings'))
      return Response.json({
        data: (body.input as string[]).map((_, index) => ({ index, embedding: [1, 0.25] })),
        usage: { prompt_tokens: 13, total_tokens: 13 },
      });
    if (path.endsWith(':batchEmbedContents'))
      return Response.json({
        embeddings: (body.requests as unknown[]).map(() => ({ values: [0, 1] })),
        usageMetadata: { promptTokenCount: 5 },
      });
    if (path.endsWith(':embedContent'))
      return Response.json({
        embedding: { values: [0, 1] },
        usageMetadata: { promptTokenCount: 5 },
      });
    if (mode === 'retry' && retries++ === 0)
      return new Response(`credential=${key}; private upstream detail`, {
        status: 429,
        headers: { 'Retry-After': '0.1' },
      });
    if (mode === 'hold')
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    if (mode === 'empty')
      return Response.json({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 0 } });
    return Response.json({
      choices: [
        {
          message: {
            content: `可见的回复 ${key}`,
            reasoning_content: 'HIDDEN_REASONING_MUST_NOT_BE_LOGGED',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    });
  },
});

function makeUser(role: 'admin' | 'user') {
  const userId = id();
  db.query(
    'INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)',
  ).run(
    userId,
    `${userId}@example.com`,
    role === 'admin' ? 'Audit Admin' : 'Audit User',
    'unused',
    role,
    now(),
  );
  return userId;
}
const userId = makeUser('user');
const adminId = makeUser('admin');
const supplierId = id();
const modelId = id();
const characterId = id();
db.query(
  'INSERT INTO suppliers(id,name,base_url,api_key,active,created_at) VALUES(?,?,?,?,1,?)',
).run(supplierId, 'Audit Supplier', `${server.url}v1`, encrypt(key), now());
db.query(
  "INSERT INTO providers(id,supplier_id,name,protocol,base_url,api_key,model,active,context_window,max_output,created_at) VALUES(?,?,?,'openai-completions','','',?,1,8192,512,?)",
).run(modelId, supplierId, 'Audit Model', 'audit-model', now());
db.query(
  'INSERT INTO characters(id,name,slug,personality,provider_id,active,created_at) VALUES(?,?,?,?,?,1,?)',
).run(characterId, 'Audit Character', 'audit-character', '测试角色', modelId, now());
const provider: ModelProvider = {
  ...toProvider(
    db
      .query(
        'SELECT p.*,s.protocol AS supplier_protocol,s.base_url AS supplier_base_url,s.api_key AS supplier_api_key,s.active AS supplier_active,s.name AS supplier_name FROM providers p JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=?',
      )
      .get(modelId) as Row,
  ),
  apiKey: key,
};
const input = { system: '私有系统提示词', messages: [{ role: 'user' as const, content: '你好' }] };
const context = { kind: 'chat' as const, userId, characterId, supplierId, modelId };
const cookie = (who: string) => createSession(who).split(';')[0];
async function api(path: string, session?: string) {
  const url = new URL(`http://localhost/api/${path}`);
  return GET(new Request(url, { headers: session ? { Cookie: session } : {} }), {
    params: Promise.resolve({ path: url.pathname.slice('/api/'.length).split('/') }),
  });
}

try {
  const trace = id();
  await generateText(provider, input, { audit: { ...context, requestId: trace } });
  const first = listAudit({ search: trace }).items[0];
  assert.ok(first);
  assert.equal(first.status, 'success');
  assert.equal(first.httpStatus, 200);
  assert.equal(first.userName, 'Audit User');
  assert.equal(first.characterName, 'Audit Character');
  assert.equal(first.supplierName, 'Audit Supplier');
  assert.equal(first.inputTokens, 11);
  assert.equal(first.outputTokens, 7);
  assert.equal(first.attempt, 1);
  assert.ok(first.durationMs! >= 0);
  assert.equal(getAudit(first.id).requestBody, null);
  assert.equal(getAudit(first.id).responseBody, null);
  assert.equal('requestBody' in first, false);
  assert.equal(getQuota(userId).fiveHour.used, 0);

  // Every actual retry gets its own result; private errors, auth and hidden reasoning are not copied.
  db.query("UPDATE settings SET value='true' WHERE key='auditCaptureContent'").run();
  mode = 'retry';
  const retryTrace = id();
  await generateText(
    provider,
    { ...input, system: `系统 ${key} ${'长'.repeat(10000)}` },
    { audit: { ...context, requestId: retryTrace } },
  );
  const attempts = listAudit({ search: retryTrace }).items.sort(
    (left, right) => left.attempt - right.attempt,
  );
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].status, 'failed');
  assert.equal(attempts[0].httpStatus, 429);
  assert.equal(attempts[1].status, 'success');
  assert.equal(attempts[0].attempt, 1);
  assert.equal(attempts[1].attempt, 2);
  const details = attempts.map((item) => getAudit(item.id));
  assert.ok(details[1].requestTruncated);
  assert.ok(new TextEncoder().encode(details[1].requestBody!).length <= 16384);
  assert.ok(details[1].requestBody!.includes('[REDACTED]'));
  assert.ok(details[1].responseBody!.includes('可见的回复'));
  assert.equal(JSON.stringify(details).includes(key), false);
  assert.equal(JSON.stringify(details).includes('private upstream detail'), false);
  assert.equal(JSON.stringify(details).includes('HIDDEN_REASONING'), false);
  assert.equal(details[0].inputTokens, null);

  // If a response contains no visible text, its reported consumed tokens still remain accurate.
  mode = 'empty';
  const emptyTrace = id();
  await assert.rejects(
    generateText(provider, input, { audit: { ...context, requestId: emptyTrace } }),
    { code: 'PROVIDER_EMPTY' },
  );
  const empty = listAudit({ search: emptyTrace }).items[0];
  assert.equal(empty.status, 'failed');
  assert.equal(empty.httpStatus, 200);
  assert.equal(empty.inputTokens, 12);
  assert.equal(empty.outputTokens, 0);

  // Abort is an actual cancelled attempt, not a successful request or a platform quota charge.
  mode = 'hold';
  release = undefined;
  const abort = new AbortController();
  const cancelTrace = id();
  const cancelled = generateText(provider, input, {
    audit: { ...context, requestId: cancelTrace },
    signal: abort.signal,
  });
  for (let count = 0; !release && count < 100; count++) await Bun.sleep(5);
  assert.equal(typeof release, 'function');
  abort.abort();
  (release as (() => void) | undefined)?.();
  await assert.rejects(cancelled, { code: 'CANCELLED' });
  assert.equal(listAudit({ search: cancelTrace }).items[0].status, 'cancelled');
  mode = 'normal';

  // Connection checks are attributed to the admin; embedding responses retain dimensions, never vectors.
  await testProvider(modelId, adminId);
  const embeddingId = id();
  db.query(
    "INSERT INTO providers(id,supplier_id,name,protocol,base_url,api_key,model,kind,capabilities,created_at) VALUES(?,?,?,'openai-completions','','',?,'embedding','[]',?)",
  ).run(embeddingId, supplierId, 'audit-embedding', 'audit-embedding', now());
  updateEmbeddingSettings({
    enabled: true,
    modelId: embeddingId,
  });
  await testEmbedding(adminId);
  const nativeSupplierId = id();
  db.query(
    'INSERT INTO suppliers(id,name,protocol,base_url,api_key,active,created_at) VALUES(?,?,?,?,?,1,?)',
  ).run(
    nativeSupplierId,
    'Native embedding supplier',
    'gemini',
    `${server.url}v1beta`,
    encrypt(key),
    now(),
  );
  const nativeModelId = id();
  db.query(
    "INSERT INTO providers(id,supplier_id,name,protocol,base_url,api_key,model,kind,capabilities,created_at) VALUES(?,?,?,'gemini','','',?,'embedding','[]',?)",
  ).run(nativeModelId, nativeSupplierId, 'audit-native-embedding', 'audit-native-embedding', now());
  updateEmbeddingSettings({ modelId: nativeModelId });
  await testEmbedding(adminId);
  const checks = listAudit({ kind: 'connection-test', userId: adminId }).items;
  assert.equal(checks.length, 3);
  assert.ok(checks.every((item) => item.userName === 'Audit Admin' && item.status === 'success'));
  const openaiEmbedding = getAudit(
    checks.find((item) => item.protocol === 'openai-embeddings')!.id,
  );
  const nativeEmbedding = getAudit(checks.find((item) => item.protocol === 'gemini-embedding')!.id);
  assert.equal(openaiEmbedding.inputTokens, 13);
  assert.equal(nativeEmbedding.inputTokens, 5);
  assert.equal(openaiEmbedding.outputTokens, null);
  assert.equal(nativeEmbedding.outputTokens, null);
  assert.equal(JSON.parse(openaiEmbedding.responseBody!).dimensions, 2);
  assert.equal(openaiEmbedding.responseBody!.includes('0.25'), false);
  assert.equal(nativeEmbedding.responseBody!.includes('values'), false);
  assert.equal(openaiEmbedding.supplierId, supplierId);
  assert.equal(nativeEmbedding.supplierId, nativeSupplierId);
  assert.equal(openaiEmbedding.modelId, embeddingId);

  // Defence in depth strips credentials/query strings and token-like fields from optional content.
  const direct = beginAudit({
    ...context,
    kind: 'chat',
    protocol: 'fixture',
    model: 'fixture',
    endpoint: `https://name:password@example.com/v1?api_key=${key}#fragment`,
    secrets: [key],
    requestBody: { authorization: `Bearer ${key}`, apiKey: key, safe: 'visible' },
  });
  finishAudit(direct, { status: 'success', responseBody: { visible: true } });
  const safe = getAudit(direct!.id);
  assert.equal(safe.endpoint, 'https://example.com/v1');
  assert.equal(JSON.stringify(safe).includes(key), false);
  assert.equal(
    sanitizedEndpoint('https://u:p@host.test/path?key=secret#x'),
    'https://host.test/path',
  );
  assert.deepEqual(reportedUsage({ usage: { prompt_tokens: '123' } }), {
    inputTokens: null,
    outputTokens: null,
  });
  assert.equal(listAudit({ pageSize: '100' }).pageSize, 50);
  assert.equal(listAudit({ supplierId, status: 'failed' }).total, 2);
  assert.equal(listAudit({ search: "x%_' OR 1=1 --" }).total, 0);
  assert.throws(() => listAudit({ from: 'not-a-date' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => listAudit({ status: 'bogus' }), { code: 'VALIDATION_ERROR' });
  const stats = getAuditStats('all');
  assert.equal(stats.total, stats.success + stats.failed + stats.pending);
  assert.equal(stats.failed, 3);
  assert.equal(stats.pending, 0);
  assert.equal(stats.inputTokens, 11 + 11 + 12 + 11 + 13 + 5);
  assert.equal(stats.outputTokens, 7 + 7 + 7);

  // Audit data and captured prompts are available only through administrator-protected routes.
  assert.equal((await api('admin/requests')).status, 401);
  assert.equal((await api('admin/requests', cookie(userId))).status, 403);
  const adminSession = cookie(adminId);
  assert.equal((await api('admin/requests?kind=connection-test', adminSession)).status, 200);
  assert.equal((await api(`admin/requests/${first.id}`, adminSession)).status, 200);
  assert.equal((await api('admin/requests/stats?period=24h', adminSession)).status, 200);

  // Indexed retention cleanup is bounded and crash-left pending attempts are settled visibly.
  const expiredId = id();
  const interruptedId = id();
  db.query(
    "INSERT INTO request_audits(id,kind,protocol,model,endpoint,status,created_at) VALUES(?,'chat','fixture','old','http://example.com','success',?)",
  ).run(expiredId, new Date(Date.now() - 9 * 86400000).toISOString());
  db.query(
    "INSERT INTO request_audits(id,kind,protocol,model,endpoint,status,created_at) VALUES(?,'chat','fixture','crashed','http://example.com','pending',?)",
  ).run(interruptedId, new Date(Date.now() - 20 * 60000).toISOString());
  const actualNow = Date.now;
  try {
    Date.now = () => actualNow() + 600000;
    listAudit();
  } finally {
    Date.now = actualNow;
  }
  assert.equal(db.query('SELECT id FROM request_audits WHERE id=?').get(expiredId), null);
  assert.equal(getAudit(interruptedId).errorCode, 'REQUEST_INTERRUPTED');

  // Logging storage failure must not break a provider request or create a hidden platform charge.
  db.exec('DROP TABLE request_audits');
  assert.ok((await generateText(provider, input, { audit: context })).text.includes('可见的回复'));
  assert.equal(getQuota(userId).fiveHour.used, 0);
  console.log(
    'AUDIT_INTEGRATION_OK: attempts, metadata defaults, secret/reasoning/vector exclusion, reported usage, cancellation, connection-test actors, retention, admin access, nonfatal logging',
  );
} finally {
  release?.();
  await server.stop(true);
  closeDb();
}
