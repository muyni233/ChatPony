import assert from 'node:assert/strict';
import { getDb, id, now, closeDb } from '../../src/lib/db';
import { encrypt } from '../../src/lib/crypto';
import { toMemory, toUser, type Row } from '../../src/lib/mappers';
import { getQuota } from '../../src/lib/quota';
import { chatResponse, testProvider } from '../../src/lib/chat';
import {
  annotateMemoryStatus,
  getEmbeddingSettings,
  indexMemoryIds,
  recallMemories,
  reindexMemories,
  testEmbedding,
  updateEmbeddingSettings,
} from '../../src/lib/ai/embeddings';
import type { ChatEvent } from '../../src/lib/types';

// Explicit deterministic responses exist only in this HTTP fixture, never in production code.
const vector = (text: string): number[] =>
  /苹果|水果|果园/.test(text) ? [1, 0, 0] : /图书馆|书籍/.test(text) ? [0, 1, 0] : [0, 0, 1];
const db = getDb();
db.query("UPDATE settings SET value='1' WHERE key='memorySummaryInterval'").run();
const requests: { path: string; body: Record<string, unknown>; headers: Headers }[] = [];
let mode: 'normal' | 'hold' | 'fail' = 'normal';
let release: (() => void) | undefined;
let lastPrompt = '';
let modelCalls = 0;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as Record<string, unknown>;
    const path = new URL(request.url).pathname;
    if (path.endsWith('/chat/completions')) {
      modelCalls++;
      lastPrompt = (body.messages as { content: string }[])[0].content;
      return Response.json({
        choices: [
          { message: { content: '当然，我们曾在苹果树下分享过野餐。' }, finish_reason: 'stop' },
        ],
      });
    }
    requests.push({ path, body, headers: request.headers });
    if (mode === 'hold')
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    if (mode === 'fail') return new Response('sensitive-embedding-server-secret', { status: 401 });
    if (path.endsWith(':batchEmbedContents')) {
      assert.equal(request.headers.get('x-goog-api-key'), 'gemini-fixture-key');
      assert.deepEqual(Object.keys(body), ['requests']);
      const nativeRequests = body.requests as {
        model: string;
        content: { parts: { text: string }[] };
        taskType: string;
      }[];
      for (const item of nativeRequests) {
        assert.deepEqual(Object.keys(item).sort(), ['content', 'model', 'taskType']);
        assert.equal(item.model, 'models/gemini-fixture-model');
        assert.ok(['RETRIEVAL_QUERY', 'RETRIEVAL_DOCUMENT'].includes(item.taskType));
      }
      return Response.json({
        embeddings: nativeRequests.map((item) => ({ values: vector(item.content.parts[0].text) })),
      });
    }
    if (path.endsWith(':embedContent')) {
      assert.equal(request.headers.get('x-goog-api-key'), 'gemini-fixture-key');
      assert.equal(request.headers.get('authorization'), null);
      assert.equal(body.model, 'models/gemini-fixture-model');
      assert.deepEqual(Object.keys(body).sort(), ['content', 'model', 'taskType']);
      assert.equal('generationConfig' in body, false);
      assert.equal('temperature' in body, false);
      assert.equal('maxOutputTokens' in body, false);
      assert.ok(['RETRIEVAL_QUERY', 'RETRIEVAL_DOCUMENT'].includes(String(body.taskType)));
      const text = (body.content as { parts: { text: string }[] }).parts[0].text;
      return Response.json({ embedding: { values: vector(text) } });
    }
    assert.equal(path, '/v1/embeddings');
    assert.equal(request.headers.get('authorization'), 'Bearer openai-fixture-key');
    assert.equal(body.encoding_format, 'float');
    assert.ok(Array.isArray(body.input));
    return Response.json({
      data: (body.input as string[]).map((text, index) => ({ index, embedding: vector(text) })),
    });
  },
});

function makeUser() {
  const userId = id();
  db.query('INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)').run(
    userId,
    `${userId}@example.com`,
    '测试用户',
    'unused',
    now(),
  );
  return toUser(db.query('SELECT * FROM users WHERE id=?').get(userId) as Row);
}
const user = makeUser();
const other = makeUser();
function embeddingSupplier(protocol: string, baseUrl: string, apiKey: string) {
  const supplierId = id();
  db.query(
    'INSERT INTO suppliers(id,name,protocol,base_url,api_key,active,created_at) VALUES(?,?,?,?,?,1,?)',
  ).run(supplierId, `Embedding ${protocol}`, protocol, baseUrl, encrypt(apiKey), now());
  return supplierId;
}
const openaiEmbeddingSupplier = embeddingSupplier(
  'openai-completions',
  `${server.url}v1`,
  'openai-fixture-key',
);
const geminiEmbeddingSupplier = embeddingSupplier(
  'gemini',
  `${server.url}v1beta`,
  'gemini-fixture-key',
);
function embeddingModel(supplier: string, model: string) {
  const modelId = id();
  db.query(
    "INSERT INTO providers(id,supplier_id,name,protocol,base_url,api_key,model,kind,capabilities,created_at) VALUES(?,?,?,'openai-completions','','',?,'embedding','[]',?)",
  ).run(modelId, supplier, model, model, now());
  return modelId;
}
const openaiEmbeddingModel = embeddingModel(openaiEmbeddingSupplier, 'fixture-embedding');
const geminiEmbeddingModel = embeddingModel(geminiEmbeddingSupplier, 'gemini-fixture-model');
const supplierId = id();
db.query(
  'INSERT INTO suppliers(id,name,base_url,api_key,active,created_at) VALUES(?,?,?,?,1,?)',
).run(supplierId, 'Role supplier', `${server.url}v1`, encrypt('role-key'), now());
const providerId = id();
db.query(
  "INSERT INTO providers(id,supplier_id,name,protocol,base_url,model,api_key,context_window,max_output,created_at) VALUES(?,?,?,'openai-completions','',?,'',?,?,?)",
).run(providerId, supplierId, 'fixture', 'test-role', 8192, 512, now());
function character(name: string) {
  const characterId = id();
  db.query(
    'INSERT INTO characters(id,name,slug,personality,provider_id,active,created_at) VALUES(?,?,?,?,?,1,?)',
  ).run(characterId, name, name.toLowerCase(), '友善的测试角色。', providerId, now());
  return characterId;
}
const alpha = character('Alpha');
const beta = character('Beta');
function memory(userId: string, characterId: string, content: string) {
  const memoryId = id();
  const time = now();
  db.query(
    "INSERT INTO memories(id,user_id,character_id,content,source,created_at,updated_at) VALUES(?,?,?,?,'auto',?,?)",
  ).run(memoryId, userId, characterId, content, time, time);
  return memoryId;
}
const apple = memory(user.id, alpha, '旧故事：我们曾一起在苹果树下野餐，带着红色餐篮。');
const books = memory(user.id, alpha, '旧故事：我们在图书馆整理书籍。');
const otherRole = memory(user.id, beta, '不同角色的苹果秘密，绝不应传给 Alpha。');
const otherUser = memory(other.id, alpha, '另一用户的苹果秘密，绝不应传给当前用户。');
const getMemory = (memoryId: string) =>
  toMemory(db.query('SELECT * FROM memories WHERE id=?').get(memoryId) as Row);
async function waitHeld() {
  for (let count = 0; count < 100; count++) {
    if (release) return;
    await Bun.sleep(5);
  }
  throw new Error('No pending embedding request');
}
async function collect(response: Response): Promise<ChatEvent[]> {
  return (await response.text())
    .split('\n\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}

try {
  assert.equal(getEmbeddingSettings().enabled, false);
  assert.equal(annotateMemoryStatus(getMemory(apple)).vectorStatus, 'disabled');
  assert.deepEqual((await recallMemories(user.id, alpha, '水果')).memories, []);
  assert.equal(requests.length, 0);
  updateEmbeddingSettings({
    enabled: true,
    modelId: openaiEmbeddingModel,
    topK: 2,
    minSimilarity: 0.7,
  });
  assert.equal(getEmbeddingSettings().hasKey, true);
  assert.equal(JSON.stringify(getEmbeddingSettings()).includes('fixture-key'), false);
  assert.equal(
    String(
      (db.query("SELECT value FROM settings WHERE key='embeddingConfig'").get() as Row).value,
    ).includes('openai-fixture-key'),
    false,
  );
  assert.equal(annotateMemoryStatus(getMemory(apple)).vectorStatus, 'pending');
  const quotaBefore = getQuota(user.id).fiveHour.used;
  const indexed = await reindexMemories(user.id);
  assert.equal(indexed.indexed, 3);
  assert.equal(indexed.pending, 0);
  assert.equal(annotateMemoryStatus(getMemory(otherUser)).vectorStatus, 'pending');
  assert.equal(annotateMemoryStatus(getMemory(apple)).vectorStatus, 'ready');
  const activeSelection = getEmbeddingSettings();
  assert.equal((await testProvider(geminiEmbeddingModel)).ok, true);
  assert.deepEqual(getEmbeddingSettings(), activeSelection);
  assert.equal(requests.at(-1)!.path, '/v1beta/models/gemini-fixture-model:batchEmbedContents');
  const recalled = await recallMemories(user.id, alpha, '能带我去摘水果吗？');
  assert.deepEqual(
    recalled.memories.map((item) => item.id),
    [apple],
  );
  assert.equal(recalled.memories[0].similarity, 1);
  assert.equal(
    recalled.memories.some((item) => [otherRole, otherUser, books].includes(item.id)),
    false,
  );
  assert.equal(getQuota(user.id).fiveHour.used, quotaBefore);

  // A complete role turn injects vector-retrieved episode context and indexes its actual transcript.
  const conversationId = id();
  const timestamp = now();
  const requestId = id();
  db.query(
    "INSERT INTO conversations(id,user_id,title,kind,character_ids,max_rounds,created_at,updated_at) VALUES(?,?,?,'private',?,1,?,?)",
  ).run(conversationId, user.id, 'Vector test', JSON.stringify([alpha]), timestamp, timestamp);
  const send = () =>
    chatResponse(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        body: JSON.stringify({ content: '能带我去摘水果吗？', requestId }),
      }),
      user,
      conversationId,
    );
  db.query(
    "INSERT INTO settings(key,value) VALUES('bubbleDelimiter',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(JSON.stringify('[next-bubble]'));
  const chat = await collect(await send());
  assert.ok(lastPrompt.includes('语义检索到的长期记忆'));
  assert.ok(lastPrompt.includes('红色餐篮'));
  assert.ok(lastPrompt.includes('[next-bubble]'));
  assert.equal(lastPrompt.includes('不同角色的苹果秘密'), false);
  assert.equal(lastPrompt.includes('另一用户的苹果秘密'), false);
  const episode = db
    .query(
      'SELECT * FROM memories WHERE source_message_id IS NOT NULL AND user_id=? AND character_id=?',
    )
    .get(user.id, alpha) as Row;
  assert.ok(episode);
  assert.ok(String(episode.content).includes('用户：能带我去摘水果吗'));
  assert.ok(String(episode.content).includes('角色：当然'));
  assert.equal(annotateMemoryStatus(toMemory(episode)).vectorStatus, 'ready');
  assert.equal(chat.at(-1)?.type, 'done');
  const beforeReplay = requests.length;
  await collect(await send());
  assert.equal(requests.length, beforeReplay);
  assert.equal(modelCalls, 1);
  assert.equal(
    (
      db
        .query('SELECT COUNT(*) AS n FROM memories WHERE source_message_id IS NOT NULL')
        .get() as Row
    ).n,
    1,
  );

  // No generation quota means no outbound query embedding or role call.
  db.query('UPDATE users SET limit_5h=0 WHERE id=?').run(user.id);
  await collect(
    await chatResponse(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        body: JSON.stringify({ content: '再次去果园', requestId: id() }),
      }),
      user,
      conversationId,
    ),
  );
  assert.equal(requests.length, beforeReplay);
  assert.equal(modelCalls, 1);
  db.query('UPDATE users SET limit_5h=50 WHERE id=?').run(user.id);

  // Edited content is immediately stale; indexing claims prevent duplicate concurrent charges.
  db.query("UPDATE memories SET content='苹果树的新故事' WHERE id=?").run(apple);
  assert.equal(annotateMemoryStatus(getMemory(apple)).vectorStatus, 'pending');
  mode = 'hold';
  release = undefined;
  const indexing = reindexMemories(user.id);
  await waitHeld();
  const beforeConcurrent = requests.length;
  const concurrent = await reindexMemories(user.id);
  assert.equal(concurrent.indexed, 0);
  assert.equal(requests.length, beforeConcurrent);
  mode = 'normal';
  release!();
  assert.equal((await indexing).indexed, 1);

  // Concurrent edits/deletes cannot be overwritten or resurrected by a late embedding response.
  db.query("UPDATE memories SET content='苹果故事第一版' WHERE id=?").run(apple);
  mode = 'hold';
  release = undefined;
  const editing = indexMemoryIds([apple]);
  await waitHeld();
  db.query("UPDATE memories SET content='图书馆故事第二版' WHERE id=?").run(apple);
  mode = 'normal';
  release!();
  assert.equal((await editing).indexed, 0);
  assert.equal(annotateMemoryStatus(getMemory(apple)).vectorStatus, 'pending');
  await indexMemoryIds([apple]);
  assert.equal(
    (await recallMemories(user.id, alpha, '水果')).memories.some((item) => item.id === apple),
    false,
  );
  const deleted = memory(user.id, alpha, '待删除的苹果记忆');
  mode = 'hold';
  release = undefined;
  const deleting = indexMemoryIds([deleted]);
  await waitHeld();
  db.query('DELETE FROM memories WHERE id=?').run(deleted);
  mode = 'normal';
  release!();
  await deleting;
  assert.equal(
    db.query('SELECT memory_id FROM memory_vectors WHERE memory_id=?').get(deleted),
    null,
  );

  // Config changes invalidate old vectors. Native Gemini must distinguish document and query tasks.
  updateEmbeddingSettings({
    modelId: geminiEmbeddingModel,
  });
  assert.equal(annotateMemoryStatus(getMemory(books)).vectorStatus, 'pending');
  const geminiStart = requests.length;
  assert.ok((await reindexMemories(user.id)).indexed >= 3);
  const nativeIndex = requests.slice(geminiStart);
  assert.equal(nativeIndex.length, 1);
  assert.ok(
    nativeIndex.every(
      (item) =>
        item.path === '/v1beta/models/gemini-fixture-model:batchEmbedContents' &&
        (item.body.requests as { taskType: string }[]).every(
          (request) => request.taskType === 'RETRIEVAL_DOCUMENT',
        ),
    ),
  );
  const nativeRecall = await recallMemories(user.id, alpha, '图书馆的书籍');
  assert.equal(
    (requests.at(-1)!.body.requests as { taskType: string }[])[0].taskType,
    'RETRIEVAL_QUERY',
  );
  assert.ok(nativeRecall.memories.some((item) => item.id === books));
  assert.ok(nativeRecall.memories.every((item) => item.id !== otherRole && item.id !== otherUser));
  assert.equal((await testEmbedding()).ok, true);

  // Explicit single and batch Native URLs retain their correct endpoint/body schema.
  const setEmbeddingEndpoint = (url: string) =>
    db.query('UPDATE suppliers SET base_url=? WHERE id=?').run(url, geminiEmbeddingSupplier);
  setEmbeddingEndpoint(`${server.url}v1beta/models/gemini-fixture-model:embedContent`);
  assert.equal((await testEmbedding()).ok, true);
  assert.equal(requests.at(-1)!.path, '/v1beta/models/gemini-fixture-model:embedContent');
  setEmbeddingEndpoint(`${server.url}v1beta/models/gemini-fixture-model:batchEmbedContents`);
  const beforeBatch = requests.length;
  assert.ok((await reindexMemories(user.id)).indexed >= 3);
  assert.equal(requests.length, beforeBatch + 1);
  assert.equal(requests.at(-1)!.path, '/v1beta/models/gemini-fixture-model:batchEmbedContents');
  assert.ok(
    (requests.at(-1)!.body.requests as { taskType: string }[]).every(
      (item) => item.taskType === 'RETRIEVAL_DOCUMENT',
    ),
  );
  memory(user.id, alpha, '新的图书馆书籍经历');
  await recallMemories(user.id, alpha, '图书馆');
  const mixed = requests.at(-1)!.body.requests as { taskType: string }[];
  assert.equal(mixed[0].taskType, 'RETRIEVAL_QUERY');
  assert.equal(mixed[1].taskType, 'RETRIEVAL_DOCUMENT');
  const beforeInvalid = requests.length;
  assert.throws(() => updateEmbeddingSettings({ protocol: 'openai' }), {
    code: 'VALIDATION_ERROR',
  });
  assert.throws(() => updateEmbeddingSettings({ apiKey: 'cannot-write-here' }), {
    code: 'VALIDATION_ERROR',
  });
  assert.throws(() => updateEmbeddingSettings({ baseUrl: server.url.toString() }), {
    code: 'VALIDATION_ERROR',
  });
  setEmbeddingEndpoint(`${server.url}v1beta/models/gemini-fixture-model:generateContent`);
  await assert.rejects(testEmbedding(), { code: 'EMBEDDING_ENDPOINT' });
  setEmbeddingEndpoint(`${server.url}v1beta/models/another-model:embedContent`);
  await assert.rejects(testEmbedding(), { code: 'EMBEDDING_MODEL_MISMATCH' });
  setEmbeddingEndpoint(`${server.url}v1/embeddings`);
  await assert.rejects(testEmbedding(), { code: 'EMBEDDING_PROTOCOL' });
  const anthropicSupplier = embeddingSupplier('anthropic', `${server.url}v1`, 'unused');
  assert.throws(
    () => updateEmbeddingSettings({ modelId: embeddingModel(anthropicSupplier, 'invalid') }),
    {
      code: 'EMBEDDING_PROTOCOL',
    },
  );
  assert.equal(requests.length, beforeInvalid);
  setEmbeddingEndpoint(`${server.url}v1beta`);

  // The embedding provider is the selected supplier; disabling it prevents indexing and reuse.
  const inFlight = memory(user.id, alpha, '停用供应商时的苹果记忆');
  mode = 'hold';
  release = undefined;
  const pendingSupplier = indexMemoryIds([inFlight]);
  await waitHeld();
  db.query('UPDATE suppliers SET active=0 WHERE id=?').run(geminiEmbeddingSupplier);
  mode = 'normal';
  release!();
  assert.equal((await pendingSupplier).failed, 1);
  assert.equal(getEmbeddingSettings().supplierActive, false);
  assert.equal(annotateMemoryStatus(getMemory(inFlight)).vectorStatus, 'disabled');
  const noRequests = requests.length;
  await assert.rejects(testEmbedding(), { code: 'EMBEDDING_SUPPLIER_DISABLED' });
  await assert.rejects(reindexMemories(user.id), { code: 'EMBEDDING_SUPPLIER_DISABLED' });
  assert.equal(requests.length, noRequests);
  db.query('UPDATE suppliers SET active=1 WHERE id=?').run(geminiEmbeddingSupplier);

  // Errors remain visible and nonfatal to chat; no failed vector is presented as ready.
  const broken = memory(user.id, alpha, '暂时无法索引的苹果记录');
  mode = 'fail';
  assert.equal((await indexMemoryIds([broken])).failed, 1);
  assert.equal(annotateMemoryStatus(getMemory(broken)).vectorStatus, 'failed');
  await assert.rejects(
    testEmbedding(),
    (error) =>
      error instanceof Error &&
      !error.message.includes('sensitive') &&
      (error as { code?: string }).code === 'EMBEDDING_AUTH',
  );
  const outage = await collect(
    await chatResponse(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        body: JSON.stringify({ content: '再去果园', requestId: id() }),
      }),
      user,
      conversationId,
    ),
  );
  assert.ok(outage.some((event) => event.type === 'message'));
  assert.ok(outage.some((event) => event.type === 'status' && event.text.includes('检索暂不可用')));
  assert.ok(outage.some((event) => event.type === 'status' && event.text.includes('索引暂时失败')));
  assert.equal(getQuota(user.id).fiveHour.used, quotaBefore + 2);
  updateEmbeddingSettings({ enabled: false });
  assert.equal(annotateMemoryStatus(getMemory(books)).vectorStatus, 'disabled');
  assert.deepEqual((await recallMemories(user.id, alpha, '图书馆')).memories, []);
  const stored = JSON.parse(
    String((db.query("SELECT value FROM settings WHERE key='embeddingConfig'").get() as Row).value),
  );
  assert.deepEqual(Object.keys(stored).sort(), ['enabled', 'minSimilarity', 'modelId', 'topK']);
  assert.equal(updateEmbeddingSettings({ enabled: false, modelId: '' }).modelId, '');
  console.log(
    'EMBEDDINGS_INTEGRATION_OK: OpenAI + Gemini native, query/document tasks, cosine isolation, invalidation, atomic claims, edit/delete races, transcript episodes, quota, outage',
  );
} finally {
  release?.();
  await server.stop(true);
  closeDb();
}
