import assert from 'node:assert/strict';
import { getDb, id, now, closeDb } from '../../src/lib/db';
import { encrypt } from '../../src/lib/crypto';
import { chatResponse } from '../../src/lib/chat';
import { toUser, toProvider, type Row } from '../../src/lib/mappers';
import { getQuota } from '../../src/lib/quota';
import { listAudit } from '../../src/lib/audit';
import { registerMemoryReply, summarizeMemories } from '../../src/lib/ai/maintenance';
import type { ChatEvent } from '../../src/lib/types';

const db = getDb();
const models: string[] = [];
let summaryMode: 'normal' | 'fail' | 'hold' = 'normal';
let compressionFails = false;
let release: (() => void) | undefined;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const input = (await request.json()) as {
      model: string;
      reasoning_effort?: string;
      messages: { content: string }[];
    };
    models.push(input.model);
    if (input.model === 'compressor' && compressionFails)
      return new Response('failure', { status: 400 });
    if (input.model === 'summarizer') {
      assert.equal(input.reasoning_effort, 'low');
      if (summaryMode === 'fail') return new Response('failure', { status: 400 });
      if (summaryMode === 'hold')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    }
    return Response.json({
      choices: [
        {
          message: {
            content:
              input.model === 'compressor'
                ? '由管理员指定模型压缩后的故事摘要。'
                : input.model === 'summarizer'
                  ? '我们在书店分享了友谊的故事，并约定下次继续。'
                  : '角色的正常回复。',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 9, completion_tokens: 5 },
    });
  },
});
const userId = id();
db.query('INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)').run(
  userId,
  'maintenance@example.com',
  'Maintenance user',
  'unused',
  now(),
);
const user = toUser(db.query('SELECT * FROM users WHERE id=?').get(userId) as Row);
const supplierId = id();
db.query(
  'INSERT INTO suppliers(id,name,protocol,base_url,api_key,active,created_at) VALUES(?,?,?,?,?,1,?)',
).run(
  supplierId,
  'Maintenance fixture',
  'openai-completions',
  `${server.url}v1`,
  encrypt('fixture-key'),
  now(),
);
function model(name: string) {
  const modelId = id();
  db.query(
    "INSERT INTO providers(id,supplier_id,name,protocol,base_url,api_key,model,kind,context_window,max_output,reasoning_effort,created_at) VALUES(?,?,?,'openai-completions','','',?,'language',8192,512,?,?)",
  ).run(modelId, supplierId, name, name, name === 'summarizer' ? 'low' : 'default', now());
  return modelId;
}
const roleModel = model('role');
const compressionModel = model('compressor');
const summaryModel = model('summarizer');
function character(name: string) {
  const characterId = id();
  db.query(
    'INSERT INTO characters(id,name,slug,personality,provider_id,active,created_at) VALUES(?,?,?,?,?,1,?)',
  ).run(characterId, name, name, '友善的测试角色', roleModel, now());
  return characterId;
}
const alpha = character('alpha');
const beta = character('beta');
function conversation(characterId = alpha) {
  const conversationId = id();
  db.query(
    "INSERT INTO conversations(id,user_id,title,kind,character_ids,max_rounds,created_at,updated_at) VALUES(?,?,?,'private',?,1,?,?)",
  ).run(conversationId, userId, 'Maintenance', JSON.stringify([characterId]), now(), now());
  return conversationId;
}
function setting(key: string, value: unknown) {
  db.query('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(value), key);
}
async function send(conversationId: string, content: string) {
  const response = await chatResponse(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      body: JSON.stringify({ content, requestId: id() }),
    }),
    user,
    conversationId,
  );
  const events = (await response.text())
    .split('\n\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as ChatEvent);
  assert.ok(
    events.some((event) => event.type === 'message'),
    JSON.stringify(events),
  );
  return events;
}
function countMemories(characterId = alpha) {
  return Number(
    (
      db
        .query(
          'SELECT COUNT(*) AS n FROM memories WHERE user_id=? AND character_id=? AND source_message_id IS NOT NULL',
        )
        .get(userId, characterId) as Row
    ).n,
  );
}
function addEvent(conversationId: string, characterId = beta) {
  const userMessage = id();
  const messageId = id();
  db.query(
    "INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,'user','用户原文',?)",
  ).run(userMessage, conversationId, now());
  db.query(
    "INSERT INTO messages(id,conversation_id,role,character_id,content,created_at) VALUES(?,?,'assistant',?,'角色原文',?)",
  ).run(messageId, conversationId, characterId, now());
  registerMemoryReply(userId, characterId, messageId);
  return { userMessage, messageId };
}
const resolveModel = (modelId: string) => ({
  ...toProvider(
    db
      .query(
        'SELECT p.*,s.protocol AS supplier_protocol,s.base_url AS supplier_base_url,s.api_key AS supplier_api_key,s.active AS supplier_active FROM providers p JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=?',
      )
      .get(modelId) as Row,
  ),
  apiKey: 'fixture-key',
});
const context = (conversationId: string) => ({
  user,
  characterId: beta,
  conversationId,
  requestId: id(),
  resolveModel,
  status: () => {},
});
async function waitHold() {
  for (let count = 0; !release && count < 100; count++) await Bun.sleep(5);
  assert.equal(typeof release, 'function');
}

try {
  setting('compressionTriggerRounds', 3);
  setting('compressionKeepRounds', 1);
  setting('compressionModelId', compressionModel);
  setting('memorySummaryInterval', 2);
  setting('memorySummaryModelId', summaryModel);
  const main = conversation();
  const another = conversation();
  await send(main, '第一轮');
  assert.equal(countMemories(), 0);
  await send(another, '第二轮跨会话');
  assert.equal(countMemories(), 1);
  assert.equal(models.filter((name) => name === 'summarizer').length, 1);
  await send(main, '第三次成功回复');
  await send(main, '当前会话第三轮');
  assert.equal(models.filter((name) => name === 'compressor').length, 1);
  assert.equal(countMemories(), 2);
  assert.equal(getQuota(userId).fiveHour.used, 4);
  const compressed = db
    .query('SELECT summary,summary_boundary FROM conversations WHERE id=?')
    .get(main) as Row;
  assert.ok(String(compressed.summary).includes('管理员指定模型'));
  assert.equal(
    (
      db
        .query(
          "SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND role='user' AND rowid>?",
        )
        .get(main, Number(compressed.summary_boundary)) as Row
    ).n,
    1,
  );
  assert.equal(
    (db.query('SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?').get(main) as Row).n,
    6,
  );
  assert.equal(listAudit({ kind: 'compression', modelId: compressionModel }).total, 1);
  assert.equal(listAudit({ kind: 'memory-summary', modelId: summaryModel }).total, 2);

  // Remote compression fails over to local excerpts; memory summarization remains pending with cooldown.
  compressionFails = true;
  await send(main, '继续一轮');
  const fallback = await send(main, '触发失败压缩');
  assert.ok(
    fallback.some((event) => event.type === 'status' && event.text.includes('本地原文摘录')),
  );
  assert.equal(getQuota(userId).fiveHour.used, 6);
  summaryMode = 'fail';
  await send(main, '待总结第一轮');
  const cursorBefore = (
    db
      .query('SELECT last_event_seq FROM memory_summary_state WHERE user_id=? AND character_id=?')
      .get(userId, alpha) as Row
  ).last_event_seq;
  await send(main, '待总结第二轮');
  const failedState = db
    .query('SELECT * FROM memory_summary_state WHERE user_id=? AND character_id=?')
    .get(userId, alpha) as Row;
  assert.equal(failedState.last_event_seq, cursorBefore);
  assert.ok(failedState.retry_after);
  const summariesBefore = models.filter((name) => name === 'summarizer').length;
  await send(main, '冷却期继续');
  assert.equal(models.filter((name) => name === 'summarizer').length, summariesBefore);
  db.query(
    'UPDATE memory_summary_state SET retry_after=NULL WHERE user_id=? AND character_id=?',
  ).run(userId, alpha);
  summaryMode = 'normal';
  await send(main, '冷却后重试');
  assert.ok(
    Number(
      (
        db
          .query(
            'SELECT last_event_seq FROM memory_summary_state WHERE user_id=? AND character_id=?',
          )
          .get(userId, alpha) as Row
      ).last_event_seq,
    ) > Number(cursorBefore),
  );

  // Disable skips automatic episodes entirely, but explicit user facts still save immediately.
  setting('automaticMemoryEnabled', false);
  const beforeDisabled = countMemories();
  const eventsBefore = (db.query('SELECT COUNT(*) AS n FROM memory_summary_events').get() as Row).n;
  await send(main, '记住：我喜欢苹果。');
  assert.equal(countMemories(), beforeDisabled);
  assert.equal(
    (db.query('SELECT COUNT(*) AS n FROM memory_summary_events').get() as Row).n,
    eventsBefore,
  );
  assert.ok(
    db
      .query("SELECT id FROM memories WHERE user_id=? AND character_id=? AND content='我喜欢苹果'")
      .get(userId, alpha),
  );
  setting('automaticMemoryEnabled', true);
  setting('compressionModelId', '');
  setting('memorySummaryInterval', 2);

  // Shared durable lease prevents two conversations from summarizing the same user/character batch.
  const betaFirst = conversation(beta);
  const betaSecond = conversation(beta);
  addEvent(betaFirst);
  addEvent(betaSecond);
  summaryMode = 'hold';
  release = undefined;
  const pending = summarizeMemories(context(betaFirst));
  await waitHold();
  const beforeConcurrent = models.filter((name) => name === 'summarizer').length;
  assert.equal(await summarizeMemories(context(betaSecond)), null);
  assert.equal(models.filter((name) => name === 'summarizer').length, beforeConcurrent);
  summaryMode = 'normal';
  release!();
  assert.ok(await pending);
  assert.equal(countMemories(beta), 1);
  assert.equal(await summarizeMemories(context(betaSecond)), null);

  // Deleting a source while its summary is in flight neither writes a false memory nor advances its cursor.
  const deletionConversation = conversation(beta);
  addEvent(deletionConversation);
  addEvent(deletionConversation);
  const betaCursor = (
    db
      .query('SELECT last_event_seq FROM memory_summary_state WHERE user_id=? AND character_id=?')
      .get(userId, beta) as Row
  ).last_event_seq;
  summaryMode = 'hold';
  release = undefined;
  const deleting = summarizeMemories(context(deletionConversation));
  await waitHold();
  db.query('DELETE FROM conversations WHERE id=?').run(deletionConversation);
  summaryMode = 'normal';
  release!();
  assert.equal(await deleting, null);
  assert.equal(
    (
      db
        .query('SELECT last_event_seq FROM memory_summary_state WHERE user_id=? AND character_id=?')
        .get(userId, beta) as Row
    ).last_event_seq,
    betaCursor,
  );
  assert.equal(countMemories(beta), 1);

  // Local summaries obey the same interval without making a hidden model request or changing role quota.
  db.query(
    'UPDATE memory_summary_state SET retry_after=NULL WHERE user_id=? AND character_id=?',
  ).run(userId, beta);
  setting('memorySummaryModelId', '');
  addEvent(betaFirst);
  addEvent(betaSecond);
  const beforeLocal = models.length;
  const quotaLocal = getQuota(userId).fiveHour.used;
  assert.ok(await summarizeMemories(context(betaFirst)));
  assert.equal(models.length, beforeLocal);
  assert.equal(getQuota(userId).fiveHour.used, quotaLocal);
  const local = db
    .query(
      'SELECT content FROM memories WHERE user_id=? AND character_id=? ORDER BY rowid DESC LIMIT 1',
    )
    .get(userId, beta) as Row;
  assert.ok(String(local.content).includes('用户原文'));
  assert.ok(String(local.content).includes('角色原文'));
  console.log(
    'MAINTENANCE_INTEGRATION_OK: round trigger/keep, selected models, audit kinds, cross-conversation intervals, quota, fallback, cooldown, optout, lease, source deletion, local summaries',
  );
} finally {
  release?.();
  await server.stop(true);
  closeDb();
}
