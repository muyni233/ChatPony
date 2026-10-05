import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const route = await import(pathToFileURL(process.argv[2]).href);
const origin = 'http://localhost:3000';
const FIVE_HOURS = 5 * 60 * 60 * 1000,
  SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const password = 'policy-test-password-2026';
let assertions = 0;
function check(value, message) {
  assert.ok(value, message);
  assertions++;
}
async function request(method, path, body, cookie = '', signal) {
  return route[method](
    new Request(`${origin}/api/${path}`, {
      method,
      headers: {
        Origin: origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    }),
  );
}
async function api(method, path, body, cookie = '') {
  const response = await request(method, path, body, cookie);
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0] || '',
  };
}
function events(text) {
  return text
    .split('\n\n')
    .filter((part) => part.startsWith('data: '))
    .map((part) => JSON.parse(part.slice(6)));
}
async function status(account) {
  return (await api('GET', 'quota', undefined, account.cookie)).data;
}
async function register(name, email) {
  return api('POST', 'auth/register', { username: name, email, password });
}

let mode = 'ok',
  upstreamCalls = 0;
const held = new Set();
function finish(res) {
  res.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
  );
  res.end('data: [DONE]\n\n');
}
const upstream = createServer(async (req, res) => {
  for await (const chunk of req) void chunk;
  upstreamCalls++;
  if (mode === 'fail') {
    res.writeHead(400);
    res.end('test provider failure');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '这是测试角色的完整回复。' }, finish_reason: null }] })}\n\n`,
  );
  if (mode === 'hold') {
    held.add(res);
    res.on('close', () => held.delete(res));
  } else finish(res);
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
async function waitForHeldReply() {
  const deadline = Date.now() + 10000;
  while (!held.size) {
    if (Date.now() >= deadline) throw new Error('Expected held upstream response was not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const db = new DatabaseSync(process.env.DATABASE_PATH);
// Start with the actual previous users schema to verify the additive migration.
db.exec(`CREATE TABLE users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
  disabled INTEGER NOT NULL DEFAULT 0, email_verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version=2;`);
db.prepare("INSERT INTO settings(key,value) VALUES ('site',?)").run(
  JSON.stringify({
    allowedEmailDomains: ['allowed.example'],
    requireEmailVerification: false,
    maxDailyTurns: 1,
  }),
);
try {
  const initial = await api('GET', 'session');
  check(
    initial.data.bootstrapRequired &&
      initial.data.site.allowedEmailDomains[0] === 'allowed.example',
    'Registration domain policy is public before login',
  );
  check(
    db.prepare('PRAGMA user_version').get().user_version >= 5 &&
      db
        .prepare('PRAGMA table_info(users)')
        .all()
        .some((column) => column.name === 'quota_7d'),
    'Existing version-two database receives nullable user overrides and quota tables',
  );
  const admin = await register('策略管理员', 'bootstrap@outside.example');
  check(
    admin.status === 201 && admin.data.user.role === 'admin',
    'First administrator bypasses an existing registration domain restriction',
  );
  const global = (await api('GET', 'admin/settings', undefined, admin.cookie)).data.settings;
  check(
    global.quota5h === 50 && global.quota7d === 500 && !('maxDailyTurns' in global),
    'Global rolling quotas default to 50 and 500; legacy daily cap is retired',
  );
  check(
    global.auditRetentionDays === 90,
    'Request audit history defaults to ninety days of retention',
  );
  for (const value of [6, 366, 10.5])
    check(
      (await api('PATCH', 'admin/settings', { auditRetentionDays: value }, admin.cookie)).status ===
        400,
      'Audit retention accepts only whole days from seven through 365',
    );
  check(
    (await api('GET', 'admin/audit')).status === 401,
    'Request audit requires an authenticated administrator',
  );
  check(
    (await api('GET', 'quota')).status === 401,
    'Quota status requires an authenticated account',
  );
  const rejected = await register('域名不允许', 'blocked@outside.example');
  check(
    rejected.status === 400 && rejected.data.error.code === 'EMAIL_DOMAIN_NOT_ALLOWED',
    'Subsequent registration enforces domain policy with a stable code',
  );
  const quotaUser = await register('配额测试用户', 'QUOTA@ALLOWED.EXAMPLE');
  check(
    quotaUser.status === 201 && quotaUser.data.user.email === 'quota@allowed.example',
    'Allowed registration domains match without case sensitivity',
  );
  check(
    (await api('GET', 'admin/audit', undefined, quotaUser.cookie)).status === 403,
    'Ordinary accounts cannot access any request audit entries',
  );
  check(
    (await register('子域名测试', 'sub@sub.allowed.example')).data.error.code ===
      'EMAIL_DOMAIN_NOT_ALLOWED',
    'Allowed root domain never silently allows subdomains',
  );
  const idnPolicy = await api(
    'PATCH',
    'admin/settings',
    { allowedEmailDomains: [' ALLOWED.EXAMPLE ', 'allowed.example', 'BÜCHER.EXAMPLE'] },
    admin.cookie,
  );
  check(
    idnPolicy.status === 200 &&
      idnPolicy.data.settings.allowedEmailDomains.join(',') ===
        'allowed.example,xn--bcher-kva.example',
    'Domain configuration trims, lowercases, deduplicates and normalizes IDN',
  );
  check(
    (await register('国际域名用户', 'reader@bücher.example')).status === 201,
    'International email domain matches its configured ASCII form',
  );
  for (const invalid of [
    '@example.com',
    '*.example.com',
    'https://example.com',
    'example.com/path',
    'example.com:443',
    'example.com.',
    'localhost',
    'two..example',
    '-bad.example',
    `${'x'.repeat(64)}.example`,
    '127.0.0.1',
    'exa\nmple.com',
    'exa%6dple.com',
    'exa\u0000mple.com',
  ]) {
    const response = await api(
      'PATCH',
      'admin/settings',
      { allowedEmailDomains: [invalid] },
      admin.cookie,
    );
    check(
      response.status === 400 && response.data.error.code === 'INVALID_EMAIL_DOMAINS',
      `Invalid registration domain rejected: ${JSON.stringify(invalid)}`,
    );
  }
  check(
    (
      await api(
        'PATCH',
        'admin/settings',
        { allowedEmailDomains: Array.from({ length: 65 }, (_, index) => `domain${index}.example`) },
        admin.cookie,
      )
    ).status === 400,
    'Domain policy is bounded at 64 entries',
  );
  await api(
    'PATCH',
    'admin/settings',
    { allowedEmailDomains: ['different.example'] },
    admin.cookie,
  );
  check(
    (await api('POST', 'auth/login', { email: 'quota@allowed.example', password })).status === 200,
    'Changing registration domains never prevents existing account login',
  );
  check(
    (await api('POST', 'auth/forgot-password', { email: 'quota@allowed.example' })).data.error
      .code === 'MAIL_NOT_CONFIGURED',
    'Existing account recovery is not subjected to registration domain policy',
  );
  const cleared = await api(
    'PATCH',
    'admin/settings',
    { allowedEmailDomains: [], quota5h: 2, quota7d: 3 },
    admin.cookie,
  );
  check(
    cleared.status === 200 &&
      (await api('GET', 'session')).data.site.allowedEmailDomains.length === 0,
    'Empty domain list publicly means unrestricted registration',
  );
  const concurrencyUser = await register('并发配额用户', 'parallel@outside.example');
  check(concurrencyUser.status === 201, 'Empty allowlist allows a new external domain');
  const inherited = await status(quotaUser);
  check(
    inherited.fiveHour.limit === 2 &&
      inherited.sevenDay.limit === 3 &&
      inherited.fiveHour.used === 0 &&
      inherited.fiveHour.reserved === 0 &&
      inherited.fiveHour.resetsAt === null,
    'A new user inherits effective global limits with zero usage and reservations',
  );
  const users = (await api('GET', 'admin/users', undefined, admin.cookie)).data.users;
  check(
    users.find((user) => user.id === quotaUser.data.user.id).quota5h === null &&
      users.find((user) => user.id === quotaUser.data.user.id).quota7d === null,
    'Admin user records expose nullable overrides',
  );
  check(
    (
      await api(
        'PATCH',
        `admin/users/${quotaUser.data.user.id}`,
        { quota5h: 900 },
        quotaUser.cookie,
      )
    ).status === 403,
    'Ordinary users cannot raise their own limits',
  );
  for (const value of [-1, 1.5, '2', 1000001]) {
    check(
      (await api('PATCH', 'admin/settings', { quota5h: value }, admin.cookie)).status === 400,
      'Global quota rejects out-of-range or non-integer values',
    );
    check(
      (
        await api(
          'PATCH',
          `admin/users/${quotaUser.data.user.id}`,
          { quota7d: value },
          admin.cookie,
        )
      ).status === 400,
      'User quota rejects out-of-range or non-integer values',
    );
  }
  const cast = [];
  for (const name of ['配额角色甲', '配额角色乙'])
    cast.push(
      (
        await api(
          'POST',
          'admin/characters',
          { name, personality: '你是友好的测试角色。', published: true },
          admin.cookie,
        )
      ).data.character.id,
    );
  check(
    (
      await api(
        'POST',
        'admin/providers',
        {
          name: '配额测试模型',
          protocol: 'openai-chat',
          baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
          model: 'quota-test',
          apiKey: 'isolated-quota-test-key',
          enabled: true,
          isDefault: true,
        },
        admin.cookie,
      )
    ).status === 201,
    'Isolated model service is configured',
  );
  async function conversation(account, group = false) {
    return (
      await api(
        'POST',
        'conversations',
        { kind: group ? 'group' : 'direct', characterIds: group ? cast : [cast[0]] },
        account.cookie,
      )
    ).data.conversation.id;
  }
  async function send(account, id, requestId, content = '你好', signal) {
    return request(
      'POST',
      `conversations/${id}/messages`,
      { content, requestId },
      account.cookie,
      signal,
    );
  }
  const group = await conversation(quotaUser, true),
    direct = await conversation(quotaUser);
  const plain = events(
    await (await send(quotaUser, group, 'quota-plain-message', '记录今天的想法。')).text(),
  );
  check(
    plain.at(-1).type === 'done' &&
      upstreamCalls === 0 &&
      (await status(quotaUser)).fiveHour.used === 0,
    'Unmentioned group messages have no AI charge',
  );
  check(
    db
      .prepare('SELECT COUNT(*) AS n FROM request_audit WHERE user_id=?')
      .get(quotaUser.data.user.id).n === 0,
    'Ordinary group messages never appear as AI request attempts',
  );
  const groupInput = '@配额角色甲 @配额角色乙 大家好。';
  const groupTurn = events(
    await (await send(quotaUser, group, 'quota-group-turn', groupInput)).text(),
  );
  const afterGroup = await status(quotaUser);
  check(
    groupTurn.filter((event) => event.type === 'message').length === 2 &&
      afterGroup.fiveHour.used === 1 &&
      afterGroup.sevenDay.used === 1,
    'An entire two-character relay costs one successful user-triggered AI turn',
  );
  const groupAudit = db
    .prepare('SELECT * FROM request_audit WHERE user_id=?')
    .get(quotaUser.data.user.id);
  check(
    groupAudit.status === 'success' &&
      groupAudit.reply_count === 2 &&
      groupAudit.quota_charged === 1 &&
      groupAudit.output_characters === '这是测试角色的完整回复。'.length * 2 &&
      groupAudit.provider_name === '配额测试模型',
    'Successful audit records the complete relay and actual provider atomically',
  );
  const callsBeforeReplay = upstreamCalls;
  await (await send(quotaUser, group, 'quota-group-turn', groupInput)).text();
  check(
    upstreamCalls === callsBeforeReplay && (await status(quotaUser)).fiveHour.used === 1,
    'Idempotent replay never calls the model or consumes quota again',
  );
  const replayAudit = db
    .prepare("SELECT * FROM request_audit WHERE user_id=? AND status='replayed'")
    .get(quotaUser.data.user.id);
  check(
    replayAudit &&
      replayAudit.quota_charged === 0 &&
      replayAudit.reply_count === 0 &&
      replayAudit.output_characters === 0 &&
      replayAudit.provider_id === null,
    'Replayed requests are distinguishable and never inflate response or charge statistics',
  );
  check(
    events(await (await send(quotaUser, direct, 'quota-direct-turn')).text()).at(-1).type ===
      'done',
    'Legacy maxDailyTurns=1 does not block a second successful turn',
  );
  const exceeded = await send(quotaUser, direct, 'quota-five-hour-block');
  check(
    exceeded.status === 429 && (await exceeded.json()).error.code === 'QUOTA_EXCEEDED',
    'Five-hour rolling window rejects the next turn before starting SSE',
  );
  check(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM request_audit WHERE user_id=? AND status='rejected' AND error_code='QUOTA_EXCEEDED'",
      )
      .get(quotaUser.data.user.id).n === 1,
    'Quota refusal is retained as an audited rejection before SSE begins',
  );
  const snapshot = Date.now();
  db.prepare('UPDATE quota_usage SET charged_at=? WHERE user_id=? AND request_id=?').run(
    snapshot - 2 * 3600000,
    quotaUser.data.user.id,
    'quota-group-turn',
  );
  db.prepare('UPDATE quota_usage SET charged_at=? WHERE user_id=? AND request_id=?').run(
    snapshot - 3600000,
    quotaUser.data.user.id,
    'quota-direct-turn',
  );
  await api('PATCH', `admin/users/${quotaUser.data.user.id}`, { quota5h: 1 }, admin.cookie);
  const reduced = await status(quotaUser);
  check(
    reduced.fiveHour.used === 2 &&
      reduced.fiveHour.remaining === 0 &&
      reduced.fiveHour.resetsAt === new Date(snapshot + 4 * 3600000).toISOString(),
    'Lowered limit preserves usage and reports the release that actually permits the next turn',
  );
  await api('PATCH', 'admin/settings', { quota5h: 3 }, admin.cookie);
  check(
    (await status(quotaUser)).fiveHour.limit === 1,
    'An explicit user override survives a global limit change',
  );
  const restored = await api(
    'PATCH',
    `admin/users/${quotaUser.data.user.id}`,
    { quota5h: null },
    admin.cookie,
  );
  check(
    restored.data.user.quota5h === null &&
      restored.data.user.quota7d === null &&
      (await status(quotaUser)).fiveHour.used === 2 &&
      (await status(quotaUser)).fiveHour.limit === 3,
    'Null restores inheritance without clearing historical usage or omitted overrides',
  );
  db.prepare('UPDATE quota_usage SET charged_at=? WHERE user_id=? AND request_id=?').run(
    snapshot - FIVE_HOURS - 1000,
    quotaUser.data.user.id,
    'quota-group-turn',
  );
  await api(
    'PATCH',
    `admin/users/${quotaUser.data.user.id}`,
    { quota5h: 10, quota7d: 2 },
    admin.cookie,
  );
  const independent = await status(quotaUser);
  check(
    independent.fiveHour.used === 1 &&
      independent.sevenDay.used === 2 &&
      independent.fiveHour.remaining === 9,
    'Expired five-hour usage remains charged independently in the seven-day window',
  );
  const weeklyBlocked = await send(quotaUser, direct, 'quota-seven-day-block');
  check(
    weeklyBlocked.status === 429 && (await weeklyBlocked.json()).error.message.includes('7 天'),
    'Seven-day quota can block while five-hour quota remains available',
  );
  db.prepare('UPDATE quota_usage SET charged_at=? WHERE user_id=? AND request_id=?').run(
    snapshot - SEVEN_DAYS,
    quotaUser.data.user.id,
    'quota-group-turn',
  );
  check(
    (await status(quotaUser)).sevenDay.used === 1,
    'Charges stop counting at the seven-day boundary',
  );
  check(
    events(await (await send(quotaUser, direct, 'quota-after-weekly-expiry')).text()).at(-1)
      .type === 'done',
    'A turn is admitted after sufficient rolling usage expires',
  );
  await api('PATCH', `admin/users/${quotaUser.data.user.id}`, { quota5h: 0 }, admin.cookie);
  const paused = await status(quotaUser),
    callsBeforePlain = upstreamCalls;
  check(
    paused.fiveHour.remaining === 0 &&
      paused.fiveHour.resetsAt === null &&
      paused.fiveHour.used > 0,
    'Zero pauses AI without deleting use or promising a time-based automatic reset',
  );
  check(
    events(
      await (await send(quotaUser, group, 'quota-paused-plain', '暂停时仍可记下消息。')).text(),
    ).at(-1).type === 'done' && upstreamCalls === callsBeforePlain,
    'Paused AI quotas still allow plain group messages',
  );
  check(
    (await send(quotaUser, direct, 'quota-paused-ai')).status === 429,
    'Zero user quota blocks an AI turn',
  );
  check(
    (await api('PATCH', 'admin/settings', { quota5h: 0 }, admin.cookie)).status === 200 &&
      (await status(admin)).fiveHour.limit === 0,
    'Zero global quota pauses accounts inheriting that window',
  );
  await api('PATCH', 'admin/settings', { quota5h: 3 }, admin.cookie);

  await api(
    'PATCH',
    `admin/users/${concurrencyUser.data.user.id}`,
    { quota5h: 1, quota7d: 1 },
    admin.cookie,
  );
  const parallelIds = await Promise.all([
    conversation(concurrencyUser),
    conversation(concurrencyUser),
  ]);
  mode = 'hold';
  const controllers = [new AbortController(), new AbortController()];
  const parallel = await Promise.all(
    parallelIds.map((id, index) =>
      send(concurrencyUser, id, `quota-concurrent-${index}`, '同时请求', controllers[index].signal),
    ),
  );
  const winner = parallel.findIndex((response) => response.status === 200),
    loser = 1 - winner;
  check(
    winner >= 0 &&
      parallel[loser].status === 429 &&
      (await parallel[loser].json()).error.code === 'QUOTA_EXCEEDED',
    'Concurrent conversations atomically reserve the single available turn',
  );
  const pending = await status(concurrencyUser);
  check(
    pending.fiveHour.used === 0 &&
      pending.fiveHour.reserved === 1 &&
      pending.sevenDay.reserved === 1 &&
      pending.fiveHour.remaining === 0,
    'In-flight reservations reduce both remaining windows without inflating successful usage',
  );
  check(
    db
      .prepare("SELECT COUNT(*) AS n FROM request_audit WHERE user_id=? AND status='pending'")
      .get(concurrencyUser.data.user.id).n === 1,
    'In-flight AI requests are visible with pending status',
  );
  const reading = parallel[winner].text();
  controllers[winner].abort();
  await reading;
  check(
    (await status(concurrencyUser)).fiveHour.reserved === 0 &&
      (await status(concurrencyUser)).fiveHour.remaining === 1,
    'Cancellation refunds the complete reservation',
  );
  check(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM request_audit WHERE user_id=? AND status='cancelled' AND quota_charged=0",
      )
      .get(concurrencyUser.data.user.id).n === 1,
    'Cancellation is finalized separately from provider errors and remains uncharged',
  );
  mode = 'fail';
  const failed = events(
    await (await send(concurrencyUser, parallelIds[winner], 'quota-retry-same-id')).text(),
  );
  check(
    failed.at(-1).type === 'error' &&
      (await status(concurrencyUser)).fiveHour.used === 0 &&
      (await status(concurrencyUser)).fiveHour.reserved === 0,
    'Upstream failure saves no successful charge and releases its reservation',
  );
  mode = 'ok';
  db.exec(
    "CREATE TRIGGER reject_quota_commit BEFORE INSERT ON messages WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT, 'simulated quota atomicity failure'); END;",
  );
  const atomicFailure = events(
    await (await send(concurrencyUser, parallelIds[winner], 'quota-retry-same-id')).text(),
  );
  db.exec('DROP TRIGGER reject_quota_commit');
  check(
    atomicFailure.at(-1).type === 'error' &&
      (await status(concurrencyUser)).fiveHour.used === 0 &&
      (await status(concurrencyUser)).fiveHour.reserved === 0,
    'A message write failure rolls back the quota charge in the same transaction',
  );
  check(
    db
      .prepare("SELECT COUNT(*) AS n FROM request_audit WHERE user_id=? AND status='success'")
      .get(concurrencyUser.data.user.id).n === 0,
    'Failed message transactions cannot leave a successful audit entry',
  );
  check(
    (await api('GET', `conversations/${parallelIds[winner]}`, undefined, concurrencyUser.cookie))
      .data.messages.length === 0,
    'Failed and cancelled turns leave no partially committed messages',
  );
  const retried = events(
    await (await send(concurrencyUser, parallelIds[winner], 'quota-retry-same-id')).text(),
  );
  check(
    retried.at(-1).type === 'done' && (await status(concurrencyUser)).fiveHour.used === 1,
    'Retrying an unsuccessful request id consumes exactly one successful charge',
  );
  const replayAtLimit = events(
    await (await send(concurrencyUser, parallelIds[winner], 'quota-retry-same-id')).text(),
  );
  check(
    replayAtLimit.at(-1).type === 'done' && (await status(concurrencyUser)).fiveHour.used === 1,
    'Idempotent replay succeeds even when all new-turn quota is exhausted',
  );
  check(
    (await api('DELETE', `conversations/${parallelIds[winner]}`, {}, concurrencyUser.cookie))
      .status === 200 && (await status(concurrencyUser)).fiveHour.used === 1,
    'Deleting conversation history cannot erase its quota ledger',
  );
  check(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM request_audit WHERE conversation_id=? AND status='success'",
      )
      .get(parallelIds[winner]).n === 1,
    'Deleting a conversation preserves its historical audit metadata',
  );
  check(
    (await send(concurrencyUser, parallelIds[loser], 'quota-after-delete')).status === 429,
    'A new conversation remains blocked after charged conversation deletion',
  );

  const expiryUser = await register('过期配额用户', 'expired@outside.example');
  await api(
    'PATCH',
    `admin/users/${expiryUser.data.user.id}`,
    { quota5h: 1, quota7d: 1 },
    admin.cookie,
  );
  const expiryConversation = await conversation(expiryUser),
    nextConversation = await conversation(expiryUser);
  db.prepare(
    'INSERT INTO quota_reservations(id,user_id,conversation_id,request_id,created_at,expires_at) VALUES (?,?,?,?,?,?)',
  ).run(
    'orphan-reservation',
    expiryUser.data.user.id,
    'crashed-conversation',
    'crashed-request-id',
    Date.now() - 1000000,
    Date.now() - 1,
  );
  check(
    (await status(expiryUser)).fiveHour.reserved === 0 &&
      (await status(expiryUser)).fiveHour.remaining === 1,
    'An expired crashed-process reservation no longer consumes either window',
  );
  mode = 'hold';
  const expiring = await send(expiryUser, expiryConversation, 'quota-expiring-turn');
  const expiringRead = expiring.text();
  await waitForHeldReply();
  check(
    !db.prepare('SELECT id FROM quota_reservations WHERE id=?').get('orphan-reservation'),
    'A new reservation cleans expired crashed-process holds',
  );
  db.prepare('UPDATE quota_reservations SET expires_at=? WHERE user_id=?').run(
    Date.now() - 1,
    expiryUser.data.user.id,
  );
  check(
    (await status(expiryUser)).fiveHour.reserved === 0,
    'A reservation expires while an abandoned reply is still in flight',
  );
  mode = 'ok';
  const afterExpiry = events(
    await (await send(expiryUser, nextConversation, 'quota-reuses-expired-slot')).text(),
  );
  check(
    afterExpiry.at(-1).type === 'done' && (await status(expiryUser)).fiveHour.used === 1,
    'Another conversation can use a slot recovered from an expired reservation',
  );
  for (const response of held) finish(response);
  const stale = events(await expiringRead);
  check(
    stale.at(-1).code === 'QUOTA_RESERVATION_EXPIRED' &&
      (await status(expiryUser)).fiveHour.used === 1,
    'A late reply cannot charge or commit after its reservation expired and was reused',
  );
  check(
    (await api('GET', `conversations/${expiryConversation}`, undefined, expiryUser.cookie)).data
      .messages.length === 0,
    'Expired reservation leaves no late conversation messages',
  );
  const audit = await api('GET', 'admin/audit?pageSize=100', undefined, admin.cookie);
  const successfulCharges = db.prepare('SELECT COUNT(*) AS n FROM quota_usage').get().n;
  check(
    audit.status === 200 &&
      audit.data.stats.chargedTurns === successfulCharges &&
      audit.data.stats.pending === 0 &&
      audit.data.entries.items.length === audit.data.entries.total,
    'Admin audit aggregates agree with the successful quota ledger and expose bounded pagination',
  );
  const filteredAudit = await api(
    'GET',
    `admin/audit?status=rejected&query=${encodeURIComponent(quotaUser.data.user.username)}`,
    undefined,
    admin.cookie,
  );
  check(
    filteredAudit.data.entries.items.length > 0 &&
      filteredAudit.data.entries.items.every(
        (entry) => entry.status === 'rejected' && entry.username === quotaUser.data.user.username,
      ),
    'Admin audit filters operate on the authenticated metadata endpoint',
  );
  check(
    !JSON.stringify(audit.data).includes('这是测试角色的完整回复。') &&
      !JSON.stringify(audit.data).includes('isolated-quota-test-key') &&
      !JSON.stringify(audit.data).includes('quota@allowed.example') &&
      !JSON.stringify(audit.data).includes('test provider failure'),
    'Audit responses contain no reply text, email addresses, API keys or raw upstream error bodies',
  );

  const windowsUser = await register('三窗口开关用户', 'windows@outside.example');
  const windowsConversation = await conversation(windowsUser);
  const defaultWindows = await status(windowsUser);
  check(
    defaultWindows.fiveHour.enabled &&
      !defaultWindows.oneDay.enabled &&
      defaultWindows.sevenDay.enabled &&
      defaultWindows.oneDay.limit === 100 &&
      defaultWindows.oneDay.remaining === null &&
      defaultWindows.oneDay.resetsAt === null,
    'The additional one-day window defaults to disabled with a configured limit of 100',
  );
  const enabledNames = ['quota5hEnabled', 'quota1dEnabled', 'quota7dEnabled'],
    statusNames = ['fiveHour', 'oneDay', 'sevenDay'];
  for (let mask = 0; mask < 8; mask++) {
    const flags = Object.fromEntries(
      enabledNames.map((name, index) => [name, !!(mask & (1 << index))]),
    );
    await api(
      'PATCH',
      'admin/settings',
      { ...flags, quota5h: 0, quota1d: 0, quota7d: 0 },
      admin.cookie,
    );
    const effective = await status(windowsUser);
    check(
      statusNames.every(
        (name, index) =>
          effective[name].enabled === flags[enabledNames[index]] &&
          (effective[name].enabled
            ? effective[name].remaining === 0
            : effective[name].remaining === null && effective[name].resetsAt === null),
      ),
      `Independent window switches resolve correctly for combination ${mask}`,
    );
    const response = await send(windowsUser, windowsConversation, `quota-combination-${mask}`);
    if (mask === 0)
      check(
        events(await response.text()).at(-1).type === 'done',
        'All windows disabled permits AI even when every configured limit is zero',
      );
    else
      check(
        response.status === 429 && (await response.json()).error.code === 'QUOTA_EXCEEDED',
        `Any enabled zero-limit window blocks AI in combination ${mask}`,
      );
  }
  const unrestrictedAudit = db
    .prepare("SELECT * FROM request_audit WHERE user_id=? AND status='success'")
    .get(windowsUser.data.user.id);
  check(
    unrestrictedAudit.quota_charged === 0 &&
      db
        .prepare('SELECT COUNT(*) AS n FROM quota_usage WHERE user_id=?')
        .get(windowsUser.data.user.id).n === 1,
    'Unrestricted successful turns retain original usage while audit records zero quota charges',
  );
  const personalOff = await api(
    'PATCH',
    `admin/users/${windowsUser.data.user.id}`,
    { quota5hEnabled: false, quota1dEnabled: false, quota7dEnabled: false },
    admin.cookie,
  );
  check(
    personalOff.data.user.quota1d === null &&
      enabledNames.every((name) => personalOff.data.user[name] === false),
    'User records expose explicit disabled overrides separately from nullable limits',
  );
  check(
    events(
      await (await send(windowsUser, windowsConversation, 'quota-personal-disabled')).text(),
    ).at(-1).type === 'done',
    'Personal disabled overrides bypass globally enabled zero limits',
  );
  await api(
    'PATCH',
    `admin/users/${windowsUser.data.user.id}`,
    { quota1dEnabled: null },
    admin.cookie,
  );
  check(
    (await status(windowsUser)).oneDay.enabled &&
      !(await status(windowsUser)).fiveHour.enabled &&
      !(await status(windowsUser)).sevenDay.enabled,
    'Null restores only the selected enable inheritance and preserves other explicit overrides',
  );
  check(
    (await send(windowsUser, windowsConversation, 'quota-restored-enable')).status === 429,
    'Restoring an enabled zero-limit policy pauses AI again',
  );
  check(
    (await api('PATCH', 'admin/settings', { quota1dEnabled: null }, admin.cookie)).status === 400 &&
      (
        await api(
          'PATCH',
          `admin/users/${windowsUser.data.user.id}`,
          { quota1dEnabled: 0 },
          admin.cookie,
        )
      ).status === 400,
    'Global enable flags require booleans and user enable flags require booleans or null',
  );

  const dayUser = await register('独立单日用户', 'one-day@outside.example'),
    dayConversation = await conversation(dayUser);
  await api(
    'PATCH',
    `admin/users/${dayUser.data.user.id}`,
    { quota5hEnabled: false, quota1dEnabled: true, quota7dEnabled: false, quota1d: 1 },
    admin.cookie,
  );
  check(
    events(await (await send(dayUser, dayConversation, 'quota-one-day-first')).text()).at(-1)
      .type === 'done',
    'An independently enabled one-day window allows its first turn',
  );
  const dayBlocked = await send(dayUser, dayConversation, 'quota-one-day-limit');
  check(
    dayBlocked.status === 429 && (await dayBlocked.json()).error.message.includes('1 天'),
    'Only the one-day window can exhaust and block an otherwise disabled policy',
  );
  db.prepare('UPDATE quota_usage SET charged_at=? WHERE user_id=?').run(
    Date.now() - 24 * 3600000,
    dayUser.data.user.id,
  );
  const expiredDay = await status(dayUser);
  check(
    expiredDay.oneDay.used === 0 &&
      expiredDay.oneDay.remaining === 1 &&
      expiredDay.sevenDay.used === 1 &&
      expiredDay.sevenDay.remaining === null,
    'One-day expiry is independent of retained seven-day history even while seven-day enforcement is disabled',
  );
  check(
    events(await (await send(dayUser, dayConversation, 'quota-one-day-restored')).text()).at(-1)
      .type === 'done',
    'The one-day window admits a replacement after its prior turn expires',
  );
  await api(
    'PATCH',
    `admin/users/${dayUser.data.user.id}`,
    { quota1dEnabled: false },
    admin.cookie,
  );
  check(
    events(await (await send(dayUser, dayConversation, 'quota-one-day-disabled')).text()).at(-1)
      .type === 'done' && (await status(dayUser)).oneDay.used === 2,
    'Disabled windows continue tracking successfully completed turns',
  );
  await api('PATCH', `admin/users/${dayUser.data.user.id}`, { quota1dEnabled: true }, admin.cookie);
  check(
    (await status(dayUser)).oneDay.used === 2 &&
      (await send(dayUser, dayConversation, 'quota-one-day-reenabled')).status === 429,
    'Re-enabling a window uses retained history rather than silently resetting its usage',
  );
  await api(
    'PATCH',
    'admin/settings',
    { quota5hEnabled: false, quota1dEnabled: false, quota7dEnabled: false },
    admin.cookie,
  );
  check(
    (await status(dayUser)).oneDay.enabled,
    'A personal enabled override survives disabling every global window',
  );
  await api('PATCH', `admin/users/${dayUser.data.user.id}`, { quota1dEnabled: null }, admin.cookie);
  check(
    !(await status(dayUser)).oneDay.enabled && (await status(dayUser)).oneDay.remaining === null,
    'Clearing a personal enabled override inherits the disabled global policy',
  );

  await api(
    'PATCH',
    'admin/settings',
    {
      quota5hEnabled: true,
      quota1dEnabled: true,
      quota7dEnabled: true,
      quota5h: 10,
      quota1d: 10,
      quota7d: 10,
    },
    admin.cookie,
  );
  const resetA = await register('重置隔离用户甲', 'reset-a@outside.example'),
    resetB = await register('重置隔离用户乙', 'reset-b@outside.example');
  const resetAConversation = await conversation(resetA),
    resetBConversation = await conversation(resetB);
  await (await send(resetA, resetAConversation, 'quota-reset-a-initial')).text();
  await (await send(resetB, resetBConversation, 'quota-reset-b-initial')).text();
  const ledgerBeforeReset = db.prepare('SELECT COUNT(*) AS n FROM quota_usage').get().n,
    auditBeforeReset = db.prepare('SELECT COUNT(*) AS n FROM request_audit').get().n;
  check(
    (
      await api(
        'POST',
        'admin/quotas/reset',
        { scope: 'user', userId: resetA.data.user.id, window: '5h' },
        resetA.cookie,
      )
    ).status === 403,
    'Only administrators can reset quota usage',
  );
  check(
    (
      await api(
        'POST',
        'admin/quotas/reset',
        { scope: 'user', userId: 'does-not-exist', window: '5h' },
        admin.cookie,
      )
    ).status === 404,
    'A reset never silently succeeds for a missing account',
  );
  check(
    (await api('POST', 'admin/quotas/reset', { scope: 'all', window: '2h' }, admin.cookie))
      .status === 400 &&
      (
        await api(
          'POST',
          'admin/quotas/reset',
          { scope: 'all', userId: resetA.data.user.id, window: '5h' },
          admin.cookie,
        )
      ).status === 400,
    'Reset targets and window choices must be explicit and unambiguous',
  );
  const resetOne = await api(
    'POST',
    'admin/quotas/reset',
    { scope: 'user', userId: resetA.data.user.id, window: '5h' },
    admin.cookie,
  );
  const afterResetA = await status(resetA),
    unaffectedB = await status(resetB);
  check(
    resetOne.data.resetUsers === 1 &&
      resetOne.data.windows.join(',') === '5h' &&
      Number.isFinite(Date.parse(resetOne.data.resetAt)),
    'Single-user reset returns its exact affected window and timestamp',
  );
  check(
    afterResetA.fiveHour.used === 0 &&
      afterResetA.oneDay.used === 1 &&
      afterResetA.sevenDay.used === 1 &&
      statusNames.every((name) => unaffectedB[name].used === 1),
    'Single-user reset affects only the chosen user and chosen window',
  );
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const resetAllDay = await api(
    'POST',
    'admin/quotas/reset',
    { scope: 'all', window: '1d' },
    admin.cookie,
  );
  const allDayA = await status(resetA),
    allDayB = await status(resetB);
  check(
    resetAllDay.data.resetUsers === userCount &&
      resetAllDay.data.windows.join(',') === '1d' &&
      allDayA.oneDay.used === 0 &&
      allDayB.oneDay.used === 0,
    'All-user reset advances the selected window for every existing account',
  );
  check(
    allDayA.fiveHour.used === 0 &&
      allDayB.fiveHour.used === 1 &&
      allDayA.sevenDay.used === 1 &&
      allDayB.sevenDay.used === 1,
    'All-user one-day reset preserves five-hour and seven-day usage',
  );
  const resetAllForB = await api(
    'POST',
    'admin/quotas/reset',
    { scope: 'user', userId: resetB.data.user.id, window: 'all' },
    admin.cookie,
  );
  check(
    resetAllForB.data.windows.join(',') === '5h,1d,7d',
    'All-window reset explicitly enumerates each independent window',
  );
  const resetBStatus = await status(resetB);
  check(
    statusNames.every((name) => resetBStatus[name].used === 0) &&
      (await status(resetA)).sevenDay.used === 1,
    'All-window reset for one account leaves another account untouched',
  );
  check(
    db.prepare('SELECT COUNT(*) AS n FROM quota_usage').get().n === ledgerBeforeReset &&
      db.prepare('SELECT COUNT(*) AS n FROM request_audit').get().n === auditBeforeReset,
    'Resets never delete raw usage or alter historical audit and statistics',
  );
  const epochBefore = db
    .prepare('SELECT quota_7d_epoch FROM users WHERE id=?')
    .get(resetA.data.user.id).quota_7d_epoch;
  const concurrentResets = await Promise.all(
    [1, 2].map(() =>
      api(
        'POST',
        'admin/quotas/reset',
        { scope: 'user', userId: resetA.data.user.id, window: '7d' },
        admin.cookie,
      ),
    ),
  );
  check(
    concurrentResets.every((result) => result.status === 200) &&
      db.prepare('SELECT quota_7d_epoch FROM users WHERE id=?').get(resetA.data.user.id)
        .quota_7d_epoch ===
        epochBefore + 2,
    'Concurrent resets atomically advance epochs without a lost update',
  );
  await api(
    'PATCH',
    `admin/users/${resetA.data.user.id}`,
    { quota5h: 1, quota1d: 1, quota7d: 1 },
    admin.cookie,
  );
  mode = 'hold';
  const beforeResetResponse = await send(resetA, resetAConversation, 'quota-in-flight-reset');
  const beforeResetReading = beforeResetResponse.text();
  await waitForHeldReply();
  const inFlightBefore = await status(resetA);
  check(
    statusNames.every((name) => inFlightBefore[name].reserved === 1),
    'One in-flight turn reserves all three active windows',
  );
  await api(
    'POST',
    'admin/quotas/reset',
    { scope: 'user', userId: resetA.data.user.id, window: '1d' },
    admin.cookie,
  );
  const inFlightSingleReset = await status(resetA);
  check(
    inFlightSingleReset.oneDay.used === 0 &&
      inFlightSingleReset.oneDay.reserved === 1 &&
      inFlightSingleReset.oneDay.remaining === 0,
    'Resetting an active window never releases its ongoing reservation',
  );
  await api(
    'POST',
    'admin/quotas/reset',
    { scope: 'user', userId: resetA.data.user.id, window: 'all' },
    admin.cookie,
  );
  const resetANextConversation = await conversation(resetA);
  check(
    (await send(resetA, resetANextConversation, 'quota-reset-cannot-double-spend')).status === 429,
    'Even an all-window reset cannot double-spend the slot held by an ongoing turn',
  );
  const currentEpochs = db
    .prepare('SELECT quota_5h_epoch,quota_1d_epoch,quota_7d_epoch FROM users WHERE id=?')
    .get(resetA.data.user.id);
  mode = 'ok';
  for (const response of held) finish(response);
  check(
    events(await beforeResetReading).at(-1).type === 'done',
    'The previously reserved turn still completes after resetting its windows',
  );
  const completedAfterReset = await status(resetA),
    resetCharge = db
      .prepare('SELECT * FROM quota_usage WHERE user_id=? AND request_id=?')
      .get(resetA.data.user.id, 'quota-in-flight-reset');
  check(
    statusNames.every(
      (name) => completedAfterReset[name].used === 1 && completedAfterReset[name].reserved === 0,
    ) && Object.entries(currentEpochs).every(([key, value]) => resetCharge[key] === value),
    'A finishing turn joins each window’s current epoch rather than its pre-reset epoch',
  );
  await api(
    'POST',
    'admin/quotas/reset',
    { scope: 'user', userId: resetA.data.user.id, window: 'all' },
    admin.cookie,
  );
  mode = 'hold';
  const disablingResponse = await send(resetA, resetAConversation, 'quota-disabled-during-flight'),
    disablingRead = disablingResponse.text();
  await waitForHeldReply();
  await api(
    'PATCH',
    `admin/users/${resetA.data.user.id}`,
    { quota5hEnabled: false, quota1dEnabled: false, quota7dEnabled: false },
    admin.cookie,
  );
  mode = 'ok';
  for (const response of held) finish(response);
  check(
    events(await disablingRead).at(-1).type === 'done',
    'Disabling windows does not interrupt an already admitted turn',
  );
  const afterDisable = await status(resetA);
  const latestResetAudit = db
    .prepare(
      "SELECT * FROM request_audit WHERE user_id=? AND status='success' ORDER BY created_at DESC,id DESC LIMIT 1",
    )
    .get(resetA.data.user.id);
  check(
    statusNames.every(
      (name) =>
        !afterDisable[name].enabled &&
        afterDisable[name].used === 1 &&
        afterDisable[name].remaining === null,
    ) && latestResetAudit.quota_charged === 0,
    'Audit charging uses completion-time enabled flags while the unrestricted turn remains in usage history',
  );
  console.log(
    `Backend policy smoke: ${assertions} assertions passed (three rolling windows, switches, resets, atomic reservation/refund, request audits, expiry, retention, migration and email domains).`,
  );
} finally {
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  db.close();
}
