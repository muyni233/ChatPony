import assert from 'node:assert/strict';
import { getDb, id, now, closeDb } from '../../src/lib/db';
import { encrypt } from '../../src/lib/crypto';
import { chatResponse } from '../../src/lib/chat';
import { toUser, toProvider, type Row } from '../../src/lib/mappers';
import { getQuota } from '../../src/lib/quota';
import { listAudit } from '../../src/lib/audit';
import {
  compressConversation,
  registerMemoryReply,
  summarizeMemories,
} from '../../src/lib/ai/maintenance';
import type { ChatEvent } from '../../src/lib/types';

const db = getDb();
const models: string[] = [];
const summaryInputs: { model: string; content: string }[] = [];
let summaryMode: 'normal' | 'fail' | 'hold' = 'normal';
let compressionFails = false;
let compressionHolds = false;
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
    if (input.model === 'compressor' || input.model === 'summarizer')
      summaryInputs.push({ model: input.model, content: input.messages.at(-1)?.content || '' });
    if (input.model === 'compressor' && compressionFails)
      return new Response('failure', { status: 400 });
    if (input.model === 'compressor' && compressionHolds)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
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

  // Disabling automatic memory also skips the immediate explicit-fact extractor.
  setting('automaticMemoryEnabled', false);
  const beforeDisabled = countMemories();
  const eventsBefore = (db.query('SELECT COUNT(*) AS n FROM memory_summary_events').get() as Row).n;
  await send(main, '记住：我喜欢苹果。');
  assert.equal(countMemories(), beforeDisabled);
  assert.equal(
    (db.query('SELECT COUNT(*) AS n FROM memory_summary_events').get() as Row).n,
    eventsBefore,
  );
  assert.equal(
    db
      .query("SELECT id FROM memories WHERE user_id=? AND character_id=? AND content='我喜欢苹果'")
      .get(userId, alpha),
    null,
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

  // Capacity pressure must use the selected model even before the round trigger.
  // The model sees the middle of full messages, which the old excerpt-only path lost.
  setting('compressionTriggerRounds', 24);
  setting('compressionKeepRounds', 8);
  setting('compressionModelId', compressionModel);
  setting('automaticMemoryEnabled', false);
  compressionFails = false;
  const pressureConversation = conversation();
  const marker = 'IMPORTANT_AGREEMENT_MOON_LAKE';
  const oldIds: string[] = [];
  for (let index = 0; index < 8; index++) {
    const messageId = id();
    oldIds.push(messageId);
    db.query(
      "INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,'user',?,?)",
    ).run(
      messageId,
      pressureConversation,
      '前'.repeat(300) + (index === 0 ? marker : '') + '后'.repeat(300),
      now(),
    );
    db.query(
      "INSERT INTO messages(id,conversation_id,role,character_id,content,created_at) VALUES(?,?,'assistant',?,?,?)",
    ).run(id(), pressureConversation, alpha, '答'.repeat(600), now());
  }
  const compressionBefore = models.filter((name) => name === 'compressor').length;
  const quotaBeforePressure = getQuota(userId).fiveHour.used;
  const pressureEvents = await send(pressureConversation, '继续这个故事。');
  assert.equal(models.filter((name) => name === 'compressor').length, compressionBefore + 1);
  assert.ok(
    summaryInputs
      .filter((input) => input.model === 'compressor')
      .at(-1)!
      .content.includes(marker),
  );
  const pressureState = db
    .query('SELECT summary,summary_boundary FROM conversations WHERE id=?')
    .get(pressureConversation) as Row;
  assert.ok(String(pressureState.summary).includes('管理员指定模型'));
  assert.ok(
    pressureEvents.some((event) => event.type === 'status' && event.text.includes('原文截取')),
  );
  assert.equal(getQuota(userId).fiveHour.used, quotaBeforePressure + 1);
  await send(pressureConversation, '后续继续。');
  assert.equal(models.filter((name) => name === 'compressor').length, compressionBefore + 2);
  assert.ok(
    Number(
      (
        db
          .query('SELECT summary_boundary FROM conversations WHERE id=?')
          .get(pressureConversation) as Row
      ).summary_boundary,
    ) > Number(pressureState.summary_boundary),
  );

  // Summaries advance only through complete episodes actually sent to the model.
  // A small summary window cannot consume a large interval by clipping its tail.
  setting('automaticMemoryEnabled', true);
  setting('memorySummaryModelId', summaryModel);
  setting('memorySummaryInterval', 20);
  const gamma = character('gamma');
  const largeMemoryConversation = conversation(gamma);
  const episodeIds: string[] = [];
  const addLargeEpisode = (index: number) => {
    const pair = addEvent(largeMemoryConversation, gamma);
    episodeIds.push(pair.messageId);
    db.query('UPDATE messages SET content=? WHERE id=?').run(
      `EPISODE_${index}_USER ` + '用'.repeat(600),
      pair.userMessage,
    );
    db.query('UPDATE messages SET content=? WHERE id=?').run(
      `EPISODE_${index}_ASSISTANT ` + '答'.repeat(600),
      pair.messageId,
    );
    return pair;
  };
  for (let index = 0; index < 20; index++) addLargeEpisode(index);
  const memoryContext = { ...context(largeMemoryConversation), characterId: gamma };
  const largeId = await summarizeMemories(memoryContext);
  assert.ok(largeId);
  const sentSource = summaryInputs.filter((input) => input.model === 'summarizer').at(-1)!.content;
  assert.ok(sentSource.includes('EPISODE_0_USER'));
  assert.ok(sentSource.includes('EPISODE_0_ASSISTANT'));
  assert.ok(!sentSource.includes('EPISODE_1_USER'));
  const firstEvent = db
    .query('SELECT seq FROM memory_summary_events WHERE message_id=?')
    .get(episodeIds[0]) as Row;
  assert.equal(
    (
      db
        .query('SELECT last_event_seq FROM memory_summary_state WHERE user_id=? AND character_id=?')
        .get(userId, gamma) as Row
    ).last_event_seq,
    firstEvent.seq,
  );
  assert.ok(
    String(
      (db.query('SELECT content FROM memories WHERE id=?').get(largeId) as Row).content,
    ).includes('1 轮'),
  );
  const batchThrough = Number(
    (
      db
        .query('SELECT seq FROM memory_summary_events WHERE message_id=?')
        .get(episodeIds[19]) as Row
    ).seq,
  );
  assert.equal(
    (
      db
        .query(
          'SELECT pending_through_seq FROM memory_summary_state WHERE user_id=? AND character_id=?',
        )
        .get(userId, gamma) as Row
    ).pending_through_seq,
    batchThrough,
  );
  // Raising the interval applies to the next batch, without trapping this one's
  // remaining 19 episodes below the new threshold.
  setting('memorySummaryInterval', 100);
  assert.ok(await summarizeMemories(memoryContext));
  assert.ok(
    summaryInputs
      .filter((input) => input.model === 'summarizer')
      .at(-1)!
      .content.includes('EPISODE_1_USER'),
  );
  assert.equal(
    (
      db
        .query('SELECT last_event_seq FROM memory_summary_state WHERE user_id=? AND character_id=?')
        .get(userId, gamma) as Row
    ).last_event_seq,
    (db.query('SELECT seq FROM memory_summary_events WHERE message_id=?').get(episodeIds[1]) as Row)
      .seq,
  );

  setting('automaticMemoryEnabled', false);
  const pausedCalls = models.length;
  assert.equal(await summarizeMemories(memoryContext), null);
  assert.equal(models.length, pausedCalls);
  assert.equal(
    (
      db
        .query(
          'SELECT pending_through_seq FROM memory_summary_state WHERE user_id=? AND character_id=?',
        )
        .get(userId, gamma) as Row
    ).pending_through_seq,
    batchThrough,
  );
  setting('automaticMemoryEnabled', true);
  setting('memorySummaryInterval', 1);
  addLargeEpisode(20);
  // Deletions within a pending batch do not pull newer events into that batch.
  for (const messageId of episodeIds.slice(2, 19))
    db.query('DELETE FROM messages WHERE id=?').run(messageId);
  assert.ok(await summarizeMemories(memoryContext));
  const tailSource = summaryInputs.filter((input) => input.model === 'summarizer').at(-1)!.content;
  assert.ok(tailSource.includes('EPISODE_19_USER'));
  assert.ok(!tailSource.includes('EPISODE_20_USER'));
  assert.equal(
    (
      db
        .query(
          'SELECT pending_through_seq FROM memory_summary_state WHERE user_id=? AND character_id=?',
        )
        .get(userId, gamma) as Row
    ).pending_through_seq,
    0,
  );
  setting('memorySummaryInterval', 2);
  assert.equal(await summarizeMemories(memoryContext), null);
  addLargeEpisode(21);
  assert.ok(await summarizeMemories(memoryContext));
  db.query('DELETE FROM messages WHERE id=?').run(episodeIds[21]);
  addLargeEpisode(22);
  assert.equal(await summarizeMemories(memoryContext), null);
  assert.equal(
    (
      db
        .query(
          'SELECT pending_through_seq FROM memory_summary_state WHERE user_id=? AND character_id=?',
        )
        .get(userId, gamma) as Row
    ).pending_through_seq,
    0,
  );

  // One oversized episode must not block every later memory. Its bounded excerpt
  // includes both speakers and both ends, with an explicit omission marker.
  setting('memorySummaryInterval', 1);
  const delta = character('delta');
  const oversizedConversation = conversation(delta);
  const oversizedPair = addEvent(oversizedConversation, delta);
  db.query('UPDATE messages SET content=? WHERE id=?').run(
    'USER_START ' + '长'.repeat(20_000) + ' USER_END',
    oversizedPair.userMessage,
  );
  db.query('UPDATE messages SET content=? WHERE id=?').run(
    'ASSISTANT_START ' + '长'.repeat(40_000) + ' ASSISTANT_END',
    oversizedPair.messageId,
  );
  assert.ok(await summarizeMemories({ ...context(oversizedConversation), characterId: delta }));
  const oversizedSource = summaryInputs
    .filter((input) => input.model === 'summarizer')
    .at(-1)!.content;
  for (const fragment of ['USER_START', 'USER_END', 'ASSISTANT_START', 'ASSISTANT_END', '原文过长'])
    assert.ok(oversizedSource.includes(fragment));

  // Changing the selected compressor during a request discards the old result;
  // losing a lease must likewise leave the durable cursor untouched.
  const stateBeforeChange = db
    .query('SELECT summary,summary_boundary FROM conversations WHERE id=?')
    .get(pressureConversation);
  const cutoff =
    Number(
      (
        db
          .query('SELECT MAX(rowid) AS seq FROM messages WHERE conversation_id=?')
          .get(pressureConversation) as Row
      ).seq,
    ) - 1;
  const compressionContext = {
    ...context(pressureConversation),
    characterId: alpha,
    forceBoundary: cutoff,
  };
  compressionHolds = true;
  release = undefined;
  const changing = compressConversation({ ...compressionContext, assertLease: () => {} });
  await waitHold();
  setting('compressionModelId', '');
  release!();
  await changing;
  assert.deepEqual(
    db
      .query('SELECT summary,summary_boundary FROM conversations WHERE id=?')
      .get(pressureConversation),
    stateBeforeChange,
  );
  setting('compressionModelId', compressionModel);
  let leaseLive = true;
  release = undefined;
  const losingLease = compressConversation({
    ...compressionContext,
    assertLease: () => {
      if (!leaseLive) throw new Error('TEST_LEASE_LOST');
    },
  });
  await waitHold();
  leaseLive = false;
  release!();
  await assert.rejects(losingLease, /TEST_LEASE_LOST/);
  assert.deepEqual(
    db
      .query('SELECT summary,summary_boundary FROM conversations WHERE id=?')
      .get(pressureConversation),
    stateBeforeChange,
  );
  compressionHolds = false;

  // Cancelled requests and disabled summary models never consume memory events.
  const epsilon = character('epsilon');
  const interruptedConversation = conversation(epsilon);
  const interruptedPair = addEvent(interruptedConversation, epsilon);
  const interruptContext = { ...context(interruptedConversation), characterId: epsilon };
  const abortSummary = new AbortController();
  summaryMode = 'hold';
  release = undefined;
  const cancelling = summarizeMemories({ ...interruptContext, signal: abortSummary.signal });
  await waitHold();
  abortSummary.abort();
  release!();
  assert.equal(await cancelling, null);
  assert.equal(
    (
      db
        .query('SELECT last_event_seq FROM memory_summary_state WHERE user_id=? AND character_id=?')
        .get(userId, epsilon) as Row
    ).last_event_seq,
    0,
  );
  db.query(
    'UPDATE memory_summary_state SET retry_after=NULL WHERE user_id=? AND character_id=?',
  ).run(userId, epsilon);
  let modelActive = true;
  release = undefined;
  const disabling = summarizeMemories({
    ...interruptContext,
    resolveModel: (modelId) => {
      if (!modelActive) throw new Error('Summary model disabled');
      return resolveModel(modelId);
    },
  });
  await waitHold();
  modelActive = false;
  release!();
  assert.equal(await disabling, null);
  assert.equal(
    (
      db
        .query('SELECT last_event_seq FROM memory_summary_state WHERE user_id=? AND character_id=?')
        .get(userId, epsilon) as Row
    ).last_event_seq,
    0,
  );
  assert.equal(countMemories(epsilon), 0);
  summaryMode = 'normal';
  db.query(
    'UPDATE memory_summary_state SET retry_after=NULL WHERE user_id=? AND character_id=?',
  ).run(userId, epsilon);
  assert.ok(await summarizeMemories(interruptContext));
  assert.equal(
    (
      db
        .query('SELECT last_event_seq FROM memory_summary_state WHERE user_id=? AND character_id=?')
        .get(userId, epsilon) as Row
    ).last_event_seq,
    (
      db
        .query('SELECT seq FROM memory_summary_events WHERE message_id=?')
        .get(interruptedPair.messageId) as Row
    ).seq,
  );
  console.log(
    'MAINTENANCE_INTEGRATION_OK: round and capacity triggers, selected models, complete bounded episodes, audit kinds, cross-conversation intervals, quota, fallback, cooldown, optout, lease, source deletion, local summaries',
  );
} finally {
  release?.();
  await server.stop(true);
  closeDb();
}
