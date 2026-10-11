import assert from 'node:assert/strict';
import { getDb, id, now, closeDb } from '../../src/lib/db';
import { encrypt } from '../../src/lib/crypto';
import { chatResponse, testProvider } from '../../src/lib/chat';
import { toUser, type Row } from '../../src/lib/mappers';
import { getQuota, reserveCall, resetQuota } from '../../src/lib/quota';
import type { ChatEvent, User } from '../../src/lib/types';

const db = getDb();
let calls = 0;
const requestedModels: string[] = [];
let lastPrompt = '';
let mode: 'normal' | 'loop' | 'auth-error' | 'hold' = 'normal';
let release: (() => void) | undefined;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    calls++;
    assert.equal(request.headers.get('authorization'), 'Bearer fixture-key');
    const input = (await request.json()) as {
      model: string;
      messages: { role: string; content: string }[];
    };
    requestedModels.push(input.model);
    lastPrompt = input.messages[0].content;
    if (mode === 'auth-error')
      return new Response('sensitive-provider-key-and-internal-details', { status: 401 });
    if (mode === 'hold')
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    const alpha = input.messages[0].content.includes('「Alpha」');
    const text =
      mode === 'loop'
        ? alpha
          ? 'Alpha 的回复。 @beta 你呢？'
          : 'Beta 的回复。 @alpha 你呢？'
        : '这是模型的真实测试回复。';
    return Response.json({
      choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    });
  },
});

function makeUser(email: string): User {
  const userId = id();
  db.query('INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)').run(
    userId,
    email,
    'Test User',
    'not-used-in-engine-test',
    now(),
  );
  return toUser(db.query('SELECT * FROM users WHERE id=?').get(userId) as Row);
}
const user = makeUser('test@example.com');
const other = makeUser('other@example.com');
const supplierId = id();
db.query(
  'INSERT INTO suppliers(id,name,base_url,api_key,active,created_at) VALUES(?,?,?,?,1,?)',
).run(supplierId, 'Fixture supplier', server.url.toString(), encrypt('fixture-key'), now());
const providerId = id();
db.query(
  "INSERT INTO providers(id,supplier_id,name,protocol,base_url,model,api_key,context_window,max_output,created_at) VALUES(?,?,?,'openai-completions','',?,'',?,?,?)",
).run(providerId, supplierId, 'Alpha model', 'fixture-alpha', 8192, 512, now());
const secondModelId = id();
db.query(
  "INSERT INTO providers(id,supplier_id,name,protocol,base_url,model,api_key,context_window,max_output,created_at) VALUES(?,?,?,'openai-completions','',?,'',?,?,?)",
).run(secondModelId, supplierId, 'Beta model', 'fixture-beta', 8192, 384, now());
function makeCharacter(name: string, slug: string, modelId = providerId) {
  const characterId = id();
  db.query(
    'INSERT INTO characters(id,name,slug,personality,provider_id,active,created_at) VALUES(?,?,?,?,?,1,?)',
  ).run(characterId, name, slug, `${name} 是友善的测试角色。`, modelId, now());
  return characterId;
}
const alpha = makeCharacter('Alpha', 'alpha');
const beta = makeCharacter('Beta', 'beta', secondModelId);
function conversation(kind: 'private' | 'group' = 'private', maxRounds = 3) {
  const conversationId = id();
  const time = now();
  db.query(
    'INSERT INTO conversations(id,user_id,title,kind,character_ids,max_rounds,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
  ).run(
    conversationId,
    user.id,
    'Test conversation',
    kind,
    JSON.stringify(kind === 'private' ? [alpha] : [alpha, beta]),
    maxRounds,
    time,
    time,
  );
  return conversationId;
}
function request(content: string, requestId = id(), signal?: AbortSignal, retryOf?: string) {
  return new Request('http://localhost/api/conversations/test/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, requestId, retryOf }),
    signal,
  });
}
async function events(response: Response): Promise<ChatEvent[]> {
  return (await response.text())
    .split('\n\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as ChatEvent);
}
const last = (items: ChatEvent[]) => items.at(-1) as Extract<ChatEvent, { type: 'done' }>;
const userMessages = (conversationId: string) =>
  Number(
    (
      db
        .query("SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND role='user'")
        .get(conversationId) as Row
    ).n,
  );
async function waitForHold() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (release) return;
    await Bun.sleep(5);
  }
  throw new Error('Provider request did not start');
}

try {
  // The first valid request is charged exactly once and creates a user-scoped explicit memory.
  const privateId = conversation();
  const firstId = id();
  const first = await events(
    await chatResponse(request('记住：我喜欢苹果。', firstId), user, privateId),
  );
  assert.equal(first.filter((event) => event.type === 'message').length, 1);
  assert.equal(last(first).rounds, 1);
  assert.equal(getQuota(user.id).fiveHour.used, 1);
  assert.equal(calls, 1);
  assert.equal(
    (
      db
        .query('SELECT content FROM memories WHERE user_id=? AND character_id=?')
        .get(user.id, alpha) as Row
    ).content,
    '我喜欢苹果',
  );
  assert.equal(db.query('SELECT id FROM memories WHERE user_id=?').get(other.id), null);
  const replay = await events(
    await chatResponse(request('记住：我喜欢苹果。', firstId), user, privateId),
  );
  assert.deepEqual(
    replay.filter((event) => event.type === 'message'),
    first.filter((event) => event.type === 'message'),
  );
  assert.equal(calls, 1);
  assert.equal(userMessages(privateId), 1);
  await assert.rejects(chatResponse(request('changed text', firstId), user, privateId), {
    code: 'REQUEST_CONFLICT',
  });
  await assert.rejects(chatResponse(request('hello'), other, privateId), {
    code: 'CONVERSATION_NOT_FOUND',
  });

  // User-only group chat costs zero, and character-to-character loops obey a total reply cap.
  const groupId = conversation('group', 3);
  const quiet = await events(await chatResponse(request('大家好。'), user, groupId));
  assert.equal(last(quiet).rounds, 0);
  assert.equal(calls, 1);
  mode = 'loop';
  const group = await events(await chatResponse(request('@alpha 你好'), user, groupId));
  assert.equal(last(group).rounds, 3);
  assert.equal(last(group).limited, true);
  assert.equal(group.filter((event) => event.type === 'message').length, 3);
  assert.equal(getQuota(user.id).fiveHour.used, 4);
  assert.equal(calls, 4);
  assert.deepEqual(requestedModels.slice(1, 4), ['fixture-alpha', 'fixture-beta', 'fixture-alpha']);

  // Each individual group reply reserves quota. A mid-chain limit preserves earlier replies.
  db.query('UPDATE users SET limit_5h=5 WHERE id=?').run(user.id);
  const limitedId = id();
  const partial = await events(
    await chatResponse(request('@alpha 继续', limitedId), user, groupId),
  );
  assert.equal(last(partial).rounds, 1);
  assert.equal(last(partial).limited, true);
  assert.equal(
    partial.some((event) => event.type === 'error' && event.code === 'QUOTA_EXCEEDED'),
    true,
  );
  assert.equal(calls, 5);
  const partialReplay = await events(
    await chatResponse(request('@alpha 继续', limitedId), user, groupId),
  );
  assert.equal(last(partialReplay).rounds, 1);
  assert.equal(calls, 5);
  await assert.rejects(
    chatResponse(request('@alpha 继续', id(), undefined, limitedId), user, groupId),
    { code: 'RETRY_UNAVAILABLE' },
  );
  assert.equal(
    (db.query("SELECT COUNT(*) AS n FROM api_calls WHERE status='pending'").get() as Row).n,
    0,
  );
  db.query('UPDATE users SET limit_5h=50 WHERE id=?').run(user.id);

  // A provider failure keeps the user's message, refunds its reservation, and sanitizes errors.
  mode = 'auth-error';
  const failedId = id();
  const failed = await events(await chatResponse(request('失败请求', failedId), user, privateId));
  assert.equal(
    failed.some((event) => event.type === 'error' && event.code === 'PROVIDER_AUTH'),
    true,
  );
  assert.equal(JSON.stringify(failed).includes('sensitive-provider'), false);
  assert.equal(getQuota(user.id).fiveHour.used, 5);
  assert.equal(userMessages(privateId), 2);

  // An explicit fresh retry reuses the unanswered message and remains idempotent itself.
  mode = 'normal';
  const retryId = id();
  const retried = await events(
    await chatResponse(request('失败请求', retryId, undefined, failedId), user, privateId),
  );
  assert.equal(last(retried).rounds, 1);
  assert.deepEqual(
    retried.find((event) => event.type === 'user'),
    failed.find((event) => event.type === 'user'),
  );
  assert.equal(userMessages(privateId), 2);
  assert.equal(getQuota(user.id).fiveHour.used, 6);
  const callsBeforeReplay = calls;
  await events(
    await chatResponse(request('失败请求', retryId, undefined, failedId), user, privateId),
  );
  assert.equal(calls, callsBeforeReplay);
  await assert.rejects(
    chatResponse(request('失败请求', id(), undefined, failedId), user, privateId),
    { code: 'RETRY_NOT_LATEST' },
  );

  // A lease prevents both duplicate and different concurrent requests across DB connections.
  mode = 'hold';
  release = undefined;
  const lockId = conversation();
  const pendingId = id();
  const pendingResponse = await chatResponse(request('等待回复', pendingId), user, lockId);
  await waitForHold();
  await assert.rejects(chatResponse(request('第二条'), user, lockId), {
    code: 'CONVERSATION_BUSY',
  });
  await assert.rejects(chatResponse(request('等待回复', pendingId), user, lockId), {
    code: 'REQUEST_IN_PROGRESS',
  });
  release!();
  assert.equal(last(await events(pendingResponse)).rounds, 1);
  assert.equal(userMessages(lockId), 1);
  assert.equal(
    (db.query('SELECT lock_token FROM conversations WHERE id=?').get(lockId) as Row).lock_token,
    null,
  );

  // Cancellation refunds an unfinished call and releases the conversation for future requests.
  const cancelId = conversation();
  const abort = new AbortController();
  release = undefined;
  const cancelledResponse = await chatResponse(
    request('取消此请求', id(), abort.signal),
    user,
    cancelId,
  );
  await waitForHold();
  const beforeCancel = getQuota(user.id).fiveHour.used;
  abort.abort();
  release!();
  const cancelled = await events(cancelledResponse);
  assert.equal(
    cancelled.some((event) => event.type === 'error' && event.code === 'CANCELLED'),
    true,
  );
  assert.equal(last(cancelled).rounds, 0);
  assert.equal(getQuota(user.id).fiveHour.used, beforeCancel - 1);
  assert.equal(
    (db.query('SELECT lock_token FROM conversations WHERE id=?').get(cancelId) as Row).lock_token,
    null,
  );

  // Lease ownership is checked again at commit, so an expired owner cannot write or charge.
  const stolenId = conversation();
  release = undefined;
  const stolenResponse = await chatResponse(request('旧进程的请求'), user, stolenId);
  await waitForHold();
  db.query("UPDATE conversations SET lock_token='new-owner' WHERE id=?").run(stolenId);
  release!();
  const stolen = await events(stolenResponse);
  assert.equal(
    stolen.some((event) => event.type === 'error' && event.code === 'GENERATION_INTERRUPTED'),
    true,
  );
  assert.equal(last(stolen).rounds, 0);
  assert.equal(
    (db.query('SELECT lock_token FROM conversations WHERE id=?').get(stolenId) as Row).lock_token,
    'new-owner',
  );

  // Crash recovery replays prior results without reissuing upstream requests.
  const staleId = conversation();
  const staleRequest = id();
  const staleMessage = id();
  const timestamp = now();
  db.query(
    "INSERT INTO messages(id,conversation_id,role,content,request_id,created_at) VALUES(?,?,'user','旧消息',?,?)",
  ).run(staleMessage, staleId, staleRequest, timestamp);
  db.query(
    'INSERT INTO chat_requests(conversation_id,request_id,user_message_id,created_at,updated_at) VALUES(?,?,?,?,?)',
  ).run(staleId, staleRequest, staleMessage, timestamp, timestamp);
  db.query(
    "UPDATE conversations SET lock_token='dead-process',lock_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?",
  ).run(staleId);
  const staleReservation = reserveCall(user.id, staleId, alpha);
  const beforeRecoveryCalls = calls;
  const recovered = await events(
    await chatResponse(request('旧消息', staleRequest), user, staleId),
  );
  assert.equal(
    recovered.some((event) => event.type === 'error' && event.code === 'GENERATION_INTERRUPTED'),
    true,
  );
  assert.equal(
    (db.query('SELECT status FROM api_calls WHERE id=?').get(staleReservation) as Row).status,
    'failed',
  );
  assert.equal(calls, beforeRecoveryCalls);

  // Compression changes only context state, never deletes or rewrites the transcript.
  mode = 'normal';
  const longId = conversation();
  for (let index = 0; index < 400; index++)
    db.query(
      'INSERT INTO messages(id,conversation_id,role,character_id,content,created_at) VALUES(?,?,?,?,?,?)',
    ).run(
      id(),
      longId,
      index % 2 ? 'assistant' : 'user',
      index % 2 ? alpha : null,
      `${index}：${'从前有一个关于友谊的故事。'.repeat(20)}`,
      now(),
    );
  const compressed = await events(await chatResponse(request('我们继续吧'), user, longId));
  assert.equal(last(compressed).rounds, 1);
  const state = db
    .query('SELECT summary,summary_boundary FROM conversations WHERE id=?')
    .get(longId) as Row;
  assert.ok(Number(state.summary_boundary) > 0);
  assert.ok(String(state.summary).length > 0);
  assert.equal(
    (db.query('SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?').get(longId) as Row).n,
    402,
  );

  // Administrative changes are checked again after awaits and before committing a reply.
  mode = 'hold';
  release = undefined;
  const disabledId = conversation();
  const disabledResponse = await chatResponse(request('测试停用账号'), user, disabledId);
  await waitForHold();
  const disabledQuota = getQuota(user.id).fiveHour.used;
  db.query('UPDATE users SET disabled=1 WHERE id=?').run(user.id);
  release!();
  const disabled = await events(disabledResponse);
  assert.ok(disabled.some((event) => event.type === 'error' && event.code === 'ACCOUNT_DISABLED'));
  assert.equal(last(disabled).rounds, 0);
  assert.equal(getQuota(user.id).fiveHour.used, disabledQuota - 1);
  db.query('UPDATE users SET disabled=0 WHERE id=?').run(user.id);
  release = undefined;
  const unavailableId = conversation();
  const unavailableResponse = await chatResponse(request('测试停用服务'), user, unavailableId);
  await waitForHold();
  db.query('UPDATE providers SET active=0 WHERE id=?').run(providerId);
  release!();
  const unavailable = await events(unavailableResponse);
  assert.ok(
    unavailable.some((event) => event.type === 'error' && event.code === 'PROVIDER_DISABLED'),
  );
  assert.equal(last(unavailable).rounds, 0);
  db.query('UPDATE providers SET active=1 WHERE id=?').run(providerId);

  // Disabling the shared supplier affects every model, including in-flight generation.
  release = undefined;
  const supplierUnavailableId = conversation();
  const supplierResponse = await chatResponse(
    request('测试停用供应商'),
    user,
    supplierUnavailableId,
  );
  await waitForHold();
  const beforeSupplierDisable = getQuota(user.id).fiveHour.used;
  db.query('UPDATE suppliers SET active=0 WHERE id=?').run(supplierId);
  release!();
  const supplierDisabled = await events(supplierResponse);
  assert.ok(
    supplierDisabled.some((event) => event.type === 'error' && event.code === 'SUPPLIER_DISABLED'),
  );
  assert.equal(last(supplierDisabled).rounds, 0);
  assert.equal(getQuota(user.id).fiveHour.used, beforeSupplierDisable - 1);
  await assert.rejects(testProvider(secondModelId), { code: 'SUPPLIER_DISABLED' });
  db.query('UPDATE suppliers SET active=1 WHERE id=?').run(supplierId);

  // Lowering the round cap stops the next queued role, including in an already-running group turn.
  release = undefined;
  const reducedId = conversation('group', 3);
  const reducedResponse = await chatResponse(request('@alpha 开始'), user, reducedId);
  await waitForHold();
  db.query("UPDATE settings SET value='1' WHERE key='maxGroupRounds'").run();
  mode = 'loop';
  release!();
  const reduced = await events(reducedResponse);
  assert.equal(last(reduced).rounds, 1);
  assert.equal(last(reduced).limited, true);
  db.query("UPDATE settings SET value='6' WHERE key='maxGroupRounds'").run();

  // Reset keeps an in-flight reservation; lowering quota honors it but blocks the next turn.
  mode = 'hold';
  release = undefined;
  const resetId = conversation();
  const resettingResponse = await chatResponse(request('限额重置中的回复'), user, resetId);
  await waitForHold();
  resetQuota(user.id);
  assert.equal(getQuota(user.id).fiveHour.used, 1);
  db.query('UPDATE users SET limit_5h=0 WHERE id=?').run(user.id);
  mode = 'normal';
  release!();
  assert.equal(last(await events(resettingResponse)).rounds, 1);
  assert.equal(getQuota(user.id).fiveHour.used, 1);
  const callsBeforeLimit = calls;
  const nextLimited = await events(await chatResponse(request('新的回复'), user, resetId));
  assert.ok(nextLimited.some((event) => event.type === 'error' && event.code === 'QUOTA_EXCEEDED'));
  assert.equal(calls, callsBeforeLimit);
  db.query('UPDATE users SET limit_5h=50 WHERE id=?').run(user.id);
  // Enabled user-authored personas are bounded RP references and do not change call accounting.
  const persona = {
    enabled: true,
    name: '星迹',
    species: '独角兽',
    pronouns: '她',
    appearance: '浅紫色鬃毛'.repeat(200),
    personality: '开朗友善'.repeat(250),
    background: '在小马谷经营书店。'.repeat(250),
  };
  const personaId = conversation();
  const beforePersona = getQuota(user.id).fiveHour.used;
  const withPersona = await events(
    await chatResponse(request('你好'), { ...user, persona }, personaId),
  );
  assert.equal(last(withPersona).rounds, 1);
  assert.ok(lastPrompt.includes('用户自设角色资料'));
  assert.ok(lastPrompt.includes('并非现实身份'));
  assert.ok(lastPrompt.includes('"name":"星迹"'));
  assert.ok(lastPrompt.includes('"species":"独角兽"'));
  assert.ok(lastPrompt.includes(`用户显示名：${JSON.stringify(user.name)}`));
  assert.ok(
    lastPrompt.length <
      persona.background.length + persona.personality.length + persona.appearance.length,
  );
  assert.equal(getQuota(user.id).fiveHour.used, beforePersona + 1);
  const withoutPersona = await events(
    await chatResponse(
      request('继续'),
      { ...user, persona: { ...persona, enabled: false } },
      personaId,
    ),
  );
  assert.equal(last(withoutPersona).rounds, 1);
  assert.equal(lastPrompt.includes('用户自设角色资料'), false);
  assert.equal(getQuota(user.id).fiveHour.used, beforePersona + 2);
  const beforeTestQuota = getQuota(user.id).fiveHour.used;
  assert.equal((await testProvider(providerId)).ok, true);
  assert.equal((await testProvider(secondModelId)).ok, true);
  assert.equal(getQuota(user.id).fiveHour.used, beforeTestQuota);
  // A stale legacy model protocol cannot override the supplier's shared wire protocol.
  db.query("UPDATE providers SET protocol='anthropic' WHERE id=?").run(providerId);
  assert.equal((await testProvider(providerId)).ok, true);
  assert.equal(getQuota(user.id).fiveHour.used, beforeTestQuota);
  const beforeInvalidModel = calls;
  db.query("UPDATE providers SET protocol='gemini',model='gemini-embedding-001' WHERE id=?").run(
    providerId,
  );
  await assert.rejects(testProvider(providerId), { code: 'PROVIDER_EMBEDDING_MODEL' });
  assert.equal(calls, beforeInvalidModel);
  db.query('UPDATE providers SET deleted_at=? WHERE id=?').run(now(), providerId);
  await assert.rejects(testProvider(providerId), { code: 'PROVIDER_DISABLED' });
  console.log(
    'CHAT_INTEGRATION_OK: replay, ownership, memory, group cap, quota, errors, locking, cancellation, crash recovery, compression',
  );
} finally {
  release?.();
  await server.stop(true);
  closeDb();
}
