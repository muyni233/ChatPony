import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import crypto, { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import nodemailer from 'nodemailer';

// This isolated test process can pause a real scrypt callback after derivation.
// It deterministically exercises request interleavings without production hooks.
const realScrypt = crypto.scrypt;
const derivationBarriers = [];
crypto.scrypt = function (...args) {
  const callback = args.pop();
  const index = derivationBarriers.findIndex((barrier) => barrier.password === args[0]);
  const barrier = index >= 0 ? derivationBarriers.splice(index, 1)[0] : undefined;
  return realScrypt(...args, (...result) => {
    if (barrier) {
      barrier.release = () => callback(...result);
      barrier.reached();
    } else callback(...result);
  });
};
syncBuiltinESMExports();

// SMTP is intercepted only in this isolated process when a race test opts in.
// No real mailbox credentials or external delivery are used by these tests.
const realCreateTransport = nodemailer.createTransport;
let mockMailEnabled = false,
  mockMailFailure = false;
const testMailOutbox = [],
  mailBarriers = [];
nodemailer.createTransport = function (...args) {
  if (!mockMailEnabled) return realCreateTransport(...args);
  return {
    async sendMail(message) {
      testMailOutbox.push(message);
      const barrier = mailBarriers.shift();
      if (barrier) {
        barrier.reached(message);
        await barrier.pending;
      }
      if (mockMailFailure) throw new Error('isolated SMTP failure');
      return { accepted: [message.to] };
    },
    close() {},
  };
};

function pauseNextMail() {
  let reached, release, reject;
  const ready = new Promise((resolve) => {
    reached = resolve;
  });
  const pending = new Promise((resolve, fail) => {
    release = resolve;
    reject = fail;
  });
  mailBarriers.push({ reached, pending });
  return {
    async wait() {
      let timer;
      try {
        return await Promise.race([
          ready,
          new Promise((_, fail) => {
            timer = setTimeout(
              () => fail(new Error('Expected SMTP interleaving was not reached')),
              10000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    release() {
      release();
    },
    reject() {
      reject(new Error('isolated delayed SMTP failure'));
    },
  };
}

function pauseNextDerivation(password) {
  let reached;
  const ready = new Promise((resolve) => {
    reached = resolve;
  });
  const barrier = { password, reached, release: null };
  derivationBarriers.push(barrier);
  return {
    async wait() {
      let timer;
      try {
        await Promise.race([
          ready,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Expected scrypt interleaving was not reached')),
              10000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    release() {
      assert.ok(barrier.release, 'The scrypt callback must be reached before release');
      barrier.release();
    },
  };
}

const route = await import(pathToFileURL(process.argv[2]).href);
const origin = 'http://localhost:3000';
let assertions = 0;
function check(value, message) {
  assert.ok(value, message);
  assertions++;
}
async function request(method, path, body, cookie = '', extra = {}) {
  const headers = new Headers({
    Origin: origin,
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
    ...extra.headers,
  });
  return route[method](
    new Request(`${extra.requestOrigin || origin}/api/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: extra.signal,
    }),
  );
}
async function api(method, path, body, cookie = '', extra) {
  const response = await request(method, path, body, cookie, extra);
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

let upstreamMode = 'ok',
  upstreamCalls = 0,
  lastSystemPrompt = '';
const upstream = createServer(async (req, res) => {
  let requestText = '';
  for await (const chunk of req) requestText += chunk.toString();
  upstreamCalls++;
  if (upstreamMode === 'fail') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'mock failure must not leak secret-test-key' } }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  lastSystemPrompt =
    JSON.parse(requestText).messages?.find((message) => message.role === 'system')?.content || '';
  const currentRoleIsA = lastSystemPrompt.includes('当前只扮演角色「测试角色甲」');
  const reply =
    upstreamMode === 'bubbles'
      ? '第一条。 <END> <<HIDE_TEST>>第二条。'
      : upstreamMode === 'loop'
        ? currentRoleIsA
          ? '@测试角色乙 请你回应。'
          : '@测试角色甲 请你回应。'
        : '测试角色的回答。';
  res.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] })}\n\n`,
  );
  if (upstreamMode === 'slow') {
    const timer = setTimeout(() => res.end(), 30000);
    res.on('close', () => clearTimeout(timer));
    return;
  }
  res.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
  );
  res.end('data: [DONE]\n\n');
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
let db;
try {
  const initial = await api('GET', 'session');
  check(
    initial.data.bootstrapRequired === true && initial.data.user === null,
    'Fresh installation must require bootstrap',
  );
  check(
    initial.data.site.bubbleSeparator === '|||' &&
      initial.data.site.hiddenOutputMarkers.length === 0,
    'Public settings expose safe default bubble rendering configuration',
  );
  check(
    initial.data.site.allowedEmailDomains.length === 0,
    'Fresh installation permits all valid email domains by default',
  );
  check((await api('GET', 'characters')).data.characters.length === 0, 'No preset characters');
  const badOrigin = await api(
    'POST',
    'auth/register',
    { username: 'CSRF用户', email: 'csrf@example.com', password: 'strong-password-2026' },
    '',
    { headers: { Origin: 'https://other.example' } },
  );
  check(badOrigin.status === 403, 'Cross-origin registration must be rejected');
  const bindAddress = await api(
    'POST',
    'auth/login',
    { email: 'unknown@example.com', password: 'strong-password-2026' },
    '',
    { requestOrigin: 'http://0.0.0.0:3000', headers: { Host: 'localhost:3000' } },
  );
  check(
    bindAddress.status === 401,
    'CSRF uses the browser Host when Next exposes its bind address',
  );
  const concurrent = await Promise.all([
    api('POST', 'auth/register', {
      username: '管理员甲',
      email: 'first@example.com',
      password: 'strong-password-2026',
    }),
    api('POST', 'auth/register', {
      username: '管理员乙',
      email: 'second@example.com',
      password: 'strong-password-2026',
    }),
  ]);
  const administrator = concurrent.find((result) => result.status === 201);
  check(
    !!administrator && administrator.data.user.role === 'admin',
    'First completed registration becomes administrator',
  );
  check(
    concurrent.filter((result) => result.status === 201).length === 1 &&
      concurrent.some((result) => result.status === 503),
    'Bootstrap race must not create a second administrator or bypass email verification',
  );
  const adminCookie = administrator.cookie;
  check(
    (await api('GET', 'session', undefined, adminCookie)).data.bootstrapRequired === false,
    'Bootstrap completes permanently',
  );
  check(
    (await api('GET', 'admin/settings', undefined, adminCookie)).data.settings
      .requireEmailVerification === true,
    'Email verification enabled by default',
  );
  check(
    (await api('POST', 'auth/forgot-password', { email: 'first@example.com' })).status === 503,
    'Unconfigured SMTP must report a real setup error',
  );
  const settings = await api(
    'PATCH',
    'admin/settings',
    { requireEmailVerification: false, allowPrivateApiUrls: true },
    adminCookie,
  );
  check(settings.status === 200, 'Administrator can configure site without environment secrets');
  const noSeparator = await api('PATCH', 'admin/settings', { bubbleSeparator: '' }, adminCookie);
  check(
    noSeparator.status === 200 && noSeparator.data.settings.bubbleSeparator === '',
    'Empty bubble delimiter disables splitting',
  );
  const spacedSeparator = await api(
    'PATCH',
    'admin/settings',
    { bubbleSeparator: ' <END> ' },
    adminCookie,
  );
  check(
    spacedSeparator.data.settings.bubbleSeparator === ' <END> ',
    'Custom delimiter preserves meaningful leading and trailing spaces',
  );
  const escapedNewlines = await api(
    'PATCH',
    'admin/settings',
    { bubbleSeparator: '\\n\\n' },
    adminCookie,
  );
  check(
    escapedNewlines.data.settings.bubbleSeparator === '\n\n',
    'Literal newline notation is normalized into actual newlines',
  );
  check(
    (await api('GET', 'session')).data.site.bubbleSeparator === '\n\n',
    'Public settings return the normalized delimiter',
  );
  const actualNewlines = await api(
    'PATCH',
    'admin/settings',
    { bubbleSeparator: '\n\n' },
    adminCookie,
  );
  check(
    actualNewlines.status === 200 && actualNewlines.data.settings.bubbleSeparator === '\n\n',
    'Actual newline delimiter remains valid',
  );
  check(
    (await api('PATCH', 'admin/settings', { bubbleSeparator: 'x'.repeat(40) }, adminCookie))
      .status === 200,
    'Bubble delimiter accepts the exact forty-character boundary',
  );
  check(
    (await api('PATCH', 'admin/settings', { bubbleSeparator: 'x'.repeat(41) }, adminCookie))
      .status === 400,
    'Bubble delimiter rejects excessive length',
  );
  check(
    (await api('PATCH', 'admin/settings', { bubbleSeparator: '\t' }, adminCookie)).status === 400,
    'Bubble delimiter rejects tabs',
  );
  check(
    (await api('PATCH', 'admin/settings', { bubbleSeparator: '\r\n' }, adminCookie)).status === 400,
    'Bubble delimiter rejects non-newline control characters',
  );
  check(
    (await api('PATCH', 'admin/settings', { bubbleSeparator: null }, adminCookie)).status === 400,
    'Bubble delimiter rejects non-string configuration',
  );
  const markerSettings = await api(
    'PATCH',
    'admin/settings',
    { bubbleSeparator: '|||', hiddenOutputMarkers: ['<<HIDE_TEST>>', '**', '<think>'] },
    adminCookie,
  );
  check(
    markerSettings.status === 200 && markerSettings.data.settings.hiddenOutputMarkers.length === 3,
    'Literal display markers are saved as an array',
  );
  check(
    (await api('GET', 'session')).data.site.hiddenOutputMarkers[0] === '<<HIDE_TEST>>',
    'Display markers are exposed in public rendering settings',
  );
  check(
    (await api('PATCH', 'admin/settings', { hiddenOutputMarkers: ['same', 'same'] }, adminCookie))
      .status === 400,
    'Duplicate display markers are rejected',
  );
  check(
    (await api('PATCH', 'admin/settings', { hiddenOutputMarkers: [''] }, adminCookie)).status ===
      400,
    'Empty display markers are rejected',
  );
  check(
    (await api('PATCH', 'admin/settings', { hiddenOutputMarkers: ['\n'] }, adminCookie)).status ===
      400,
    'Display markers cannot contain control characters',
  );
  check(
    (await api('PATCH', 'admin/settings', { hiddenOutputMarkers: ['x'.repeat(81)] }, adminCookie))
      .status === 400,
    'Display markers reject excessive length',
  );
  check(
    (
      await api(
        'PATCH',
        'admin/settings',
        { hiddenOutputMarkers: Array.from({ length: 17 }, (_, index) => `marker-${index}`) },
        adminCookie,
      )
    ).status === 400,
    'Display markers enforce the sixteen-item limit',
  );
  const alice = await api('POST', 'auth/register', {
    username: '测试用户甲',
    email: 'alice@example.com',
    password: 'strong-password-2026',
  });
  const bob = await api('POST', 'auth/register', {
    username: '测试用户乙',
    email: 'bob@example.com',
    password: 'strong-password-2026',
  });
  check(
    alice.data.user.role === 'user' && bob.data.user.role === 'user',
    'All subsequent accounts must be unprivileged',
  );
  check(
    (await api('GET', 'admin/stats', undefined, alice.cookie)).status === 403,
    'Non-admin cannot access administrative APIs',
  );
  check(
    (
      await api('POST', 'auth/login', {
        email: 'alice@example.com',
        password: 'incorrect-password',
      })
    ).status === 401,
    'Wrong password denied',
  );
  const characters = [];
  for (const name of ['测试角色甲', '测试角色乙']) {
    const result = await api(
      'POST',
      'admin/characters',
      { name, personality: '这是测试用角色人设。', published: true },
      adminCookie,
    );
    check(
      result.status === 201 && result.data.character.avatar === '',
      'Administrator creates configurable character without artwork',
    );
    characters.push(result.data.character.id);
  }
  const greeting = '你好，欢迎来到这里。|||<<HIDE_TEST>>想聊点什么？';
  const greetingCharacter = await api(
    'POST',
    'admin/characters',
    {
      name: '开场白测试角色',
      personality: '这是专门验证开场白的测试角色。',
      greeting,
      published: true,
    },
    adminCookie,
  );
  const directWithGreeting = await api(
    'POST',
    'conversations',
    { kind: 'direct', characterIds: [greetingCharacter.data.character.id] },
    alice.cookie,
  );
  check(
    directWithGreeting.status === 201 &&
      directWithGreeting.data.conversation.lastMessageRole === 'assistant',
    'New direct conversation creates an assistant greeting preview',
  );
  const greetingMessages = (
    await api(
      'GET',
      `conversations/${directWithGreeting.data.conversation.id}`,
      undefined,
      alice.cookie,
    )
  ).data.messages;
  check(
    greetingMessages.length === 1 &&
      greetingMessages[0].role === 'assistant' &&
      greetingMessages[0].characterId === greetingCharacter.data.character.id &&
      greetingMessages[0].content === greeting &&
      upstreamCalls === 0,
    'Configured greeting is saved once as unmodified assistant content without a model call',
  );
  check(
    (
      await api(
        'GET',
        `conversations/${directWithGreeting.data.conversation.id}`,
        undefined,
        alice.cookie,
      )
    ).data.messages.length === 1,
    'Reloading a direct conversation does not repeat its greeting',
  );
  const groupWithGreeting = await api(
    'POST',
    'conversations',
    { kind: 'group', characterIds: [greetingCharacter.data.character.id, characters[0]] },
    alice.cookie,
  );
  check(
    (
      await api(
        'GET',
        `conversations/${groupWithGreeting.data.conversation.id}`,
        undefined,
        alice.cookie,
      )
    ).data.messages.length === 0,
    'Group creation does not post individual character greetings',
  );
  const directWithoutGreeting = await api(
    'POST',
    'conversations',
    { kind: 'direct', characterIds: [characters[0]] },
    alice.cookie,
  );
  check(
    (
      await api(
        'GET',
        `conversations/${directWithoutGreeting.data.conversation.id}`,
        undefined,
        alice.cookie,
      )
    ).data.messages.length === 0,
    'Empty greeting leaves a new direct conversation empty',
  );
  const greetingPreview = (
    await api('GET', 'conversations', undefined, alice.cookie)
  ).data.conversations.find((item) => item.id === directWithGreeting.data.conversation.id);
  check(
    greetingPreview.lastMessage === greeting && greetingPreview.lastMessageRole === 'assistant',
    'Conversation list exposes original assistant preview and its role',
  );
  const unconfiguredGroup = await api(
    'POST',
    'conversations',
    { kind: 'group', characterIds: characters },
    alice.cookie,
  );
  const unsummoned = events(
    await (
      await request(
        'POST',
        `conversations/${unconfiguredGroup.data.conversation.id}/messages`,
        { content: '我先记录一下今天的想法。', requestId: 'backend-no-mention' },
        alice.cookie,
      )
    ).text(),
  );
  check(
    unsummoned.map((event) => event.type).join(',') === 'user,done' && upstreamCalls === 0,
    'Unmentioned group message saves without a provider or AI call',
  );
  const userPreview = (
    await api('GET', 'conversations', undefined, alice.cookie)
  ).data.conversations.find((item) => item.id === unconfiguredGroup.data.conversation.id);
  check(
    userPreview.lastMessageRole === 'user',
    'Conversation list distinguishes user previews from assistant display transformations',
  );
  check(
    (
      await api(
        'POST',
        `conversations/${unconfiguredGroup.data.conversation.id}/messages`,
        { content: '@测试角色甲 你好。', requestId: 'backend-no-provider' },
        alice.cookie,
      )
    ).status === 503,
    'A mentioned character requires an available model',
  );
  const provider = await api(
    'POST',
    'admin/providers',
    {
      name: '本地协议测试',
      protocol: 'openai-chat',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      model: 'test-roleplay',
      apiKey: 'secret-test-key',
      enabled: true,
      isDefault: true,
    },
    adminCookie,
  );
  check(
    provider.status === 201 && provider.data.provider.hasApiKey,
    'Encrypted model service configuration saves',
  );
  check(
    !JSON.stringify(provider.data).includes('secret-test-key'),
    'Admin responses never disclose API keys',
  );
  const publicProviders = await api('GET', 'providers');
  check(
    publicProviders.data.providers[0].baseUrl === '' &&
      !JSON.stringify(publicProviders.data).includes('secret-test-key'),
    'Public model list is redacted',
  );
  db = new DatabaseSync(process.env.DATABASE_PATH);
  const conversationsBeforeFailure = db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n;
  db.exec(
    "CREATE TRIGGER reject_greeting_for_atomicity BEFORE INSERT ON messages WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT, 'simulated greeting insert failure'); END;",
  );
  const failedGreeting = await api(
    'POST',
    'conversations',
    { kind: 'direct', characterIds: [greetingCharacter.data.character.id] },
    alice.cookie,
  );
  db.exec('DROP TRIGGER reject_greeting_for_atomicity');
  check(
    failedGreeting.status >= 400 &&
      db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n === conversationsBeforeFailure,
    'Greeting insert failure rolls back the entire conversation creation',
  );
  const stored = db.prepare('SELECT api_key_cipher FROM providers').get();
  check(
    stored.api_key_cipher.startsWith('v1.') && !stored.api_key_cipher.includes('secret-test-key'),
    'API key is encrypted at rest',
  );
  check(
    readFileSync(join(dirname(process.env.DATABASE_PATH), 'application.key')).length === 32,
    'Local encryption key is generated automatically',
  );
  const created = await api(
    'POST',
    'conversations',
    { kind: 'group', characterIds: characters, scene: '图书馆里的友好交流。' },
    alice.cookie,
  );
  check(created.status === 201, 'Group conversation is created');
  const conversationId = created.data.conversation.id;
  check(
    (await api('GET', `conversations/${conversationId}`, undefined, bob.cookie)).status === 404,
    'Another account cannot read the conversation',
  );
  check(
    (await api('DELETE', `conversations/${conversationId}`, {}, bob.cookie)).status === 404,
    'Another account cannot delete the conversation',
  );
  const memory = await api(
    'POST',
    'memories',
    { characterId: characters[0], content: '用户喜欢安静的图书馆。' },
    alice.cookie,
  );
  check(memory.status === 201, 'Explicit long-term memory saves');
  check(
    (await api('PATCH', `memories/${memory.data.memory.id}`, { content: '越权修改' }, bob.cookie))
      .status === 404,
    'Memory updates are owner-scoped',
  );
  check(
    (await api('GET', 'memories', undefined, bob.cookie)).data.memories.length === 0,
    'Memory reads are owner-scoped',
  );
  await api('POST', 'favorites', { characterId: characters[0] }, alice.cookie);
  check(
    (await api('GET', 'favorites', undefined, alice.cookie)).data.characterIds.length === 1,
    'Favorites persist',
  );
  const input = {
    content: '@测试角色甲 @测试角色乙 一起聊聊书籍吧。',
    requestId: 'backend-test-001',
  };
  const generated = await request(
    'POST',
    `conversations/${conversationId}/messages`,
    input,
    alice.cookie,
  );
  const turn = events(await generated.text());
  check(
    turn.at(-1).type === 'done' && turn.filter((event) => event.type === 'message').length === 2,
    'Group characters stream sequential replies',
  );
  check(
    lastSystemPrompt.includes('消息气泡分隔符（JSON 表示）："|||"') &&
      lastSystemPrompt.includes('不要强行逐句拆分'),
    'Model receives the exact enabled delimiter with natural IM pacing guidance',
  );
  check(
    !lastSystemPrompt.includes('<<HIDE_TEST>>'),
    'Display-only hidden markers never become model instructions',
  );
  const details = await api('GET', `conversations/${conversationId}`, undefined, alice.cookie);
  check(
    details.data.messages.length === 3,
    'Successful group turn atomically saves user and both characters',
  );
  const callsBeforeReplay = upstreamCalls;
  const replay = events(
    await (
      await request('POST', `conversations/${conversationId}/messages`, input, alice.cookie)
    ).text(),
  );
  check(
    replay.at(-1).type === 'done' && upstreamCalls === callsBeforeReplay,
    'Idempotent replay never calls model twice',
  );
  check(
    (
      await api(
        'POST',
        `conversations/${conversationId}/messages`,
        { ...input, content: '更改内容' },
        alice.cookie,
      )
    ).status === 409,
    'Reused request id rejects different content',
  );
  upstreamMode = 'fail';
  const failed = events(
    await (
      await request(
        'POST',
        `conversations/${conversationId}/messages`,
        { content: '@测试角色甲 失败测试', requestId: 'backend-test-fail' },
        alice.cookie,
      )
    ).text(),
  );
  check(
    failed.at(-1).type === 'error' && !JSON.stringify(failed).includes('secret-test-key'),
    'Provider errors are safe and explicit',
  );
  check(
    (await api('GET', `conversations/${conversationId}`, undefined, alice.cookie)).data.messages
      .length === 3,
    'Failed turn saves no partial or user messages',
  );
  upstreamMode = 'slow';
  const cancellation = new AbortController();
  const active = await request(
    'POST',
    `conversations/${conversationId}/messages`,
    { content: '@测试角色甲 取消测试', requestId: 'backend-test-abort' },
    alice.cookie,
    { signal: cancellation.signal },
  );
  const reading = active.text();
  check(
    (
      await api(
        'POST',
        `conversations/${conversationId}/messages`,
        { content: '@测试角色甲 并发测试', requestId: 'backend-test-busy' },
        alice.cookie,
      )
    ).status === 409,
    'Conversation lock rejects concurrent generation',
  );
  cancellation.abort();
  await reading;
  check(
    (await api('GET', `conversations/${conversationId}`, undefined, alice.cookie)).data.messages
      .length === 3,
    'Cancelled turn leaves no partial data',
  );
  check(
    db.prepare('SELECT COUNT(*) AS n FROM generation_locks').get().n === 0,
    'Cancellation releases generation lock',
  );
  upstreamMode = 'ok';
  const continued = events(
    await (
      await request(
        'POST',
        `conversations/${conversationId}/messages`,
        { content: '', characterId: characters[1], requestId: 'backend-test-next' },
        alice.cookie,
      )
    ).text(),
  );
  check(
    continued.at(-1).type === 'done' &&
      continued.filter((event) => event.type === 'message').length === 1,
    'Selected character can continue without a fabricated user message',
  );
  upstreamMode = 'loop';
  const roleRelay = events(
    await (
      await request(
        'POST',
        `conversations/${conversationId}/messages`,
        { content: '@测试角色甲 你先开始。', requestId: 'backend-mention-relay' },
        alice.cookie,
      )
    ).text(),
  );
  check(
    roleRelay
      .filter((event) => event.type === 'message')
      .map((event) => event.message.characterId)
      .join(',') === characters.join(','),
    'Role mentions trigger another role, and repeated mutual mentions cannot loop',
  );
  await api('PATCH', 'admin/settings', { maxGroupDepth: 1 }, adminCookie);
  const depthLimited = events(
    await (
      await request(
        'POST',
        `conversations/${conversationId}/messages`,
        { content: '@测试角色甲 你先开始。', requestId: 'backend-mention-depth' },
        alice.cookie,
      )
    ).text(),
  );
  check(
    depthLimited.filter((event) => event.type === 'message').length === 1 &&
      depthLimited.some((event) => event.type === 'status' && event.message.includes('上限')),
    'Maximum relay depth stops and explains the chain',
  );
  await api('PATCH', 'admin/settings', { maxGroupDepth: 3, maxGroupReplies: 1 }, adminCookie);
  const replyLimited = events(
    await (
      await request(
        'POST',
        `conversations/${conversationId}/messages`,
        { content: '@测试角色甲 @测试角色乙 你们好。', requestId: 'backend-mention-budget' },
        alice.cookie,
      )
    ).text(),
  );
  check(
    replyLimited.filter((event) => event.type === 'message').length === 1,
    'Maximum reply count limits even multiple initial mentions',
  );
  await api('PATCH', 'admin/settings', { maxGroupReplies: 6 }, adminCookie);
  await api('PATCH', 'admin/settings', { bubbleSeparator: ' <END> ' }, adminCookie);
  upstreamMode = 'bubbles';
  const rawBubbleInput = {
    content: '@测试角色甲 分两条回复吧。',
    requestId: 'backend-raw-bubbles',
  };
  const rawBubbles = events(
    await (
      await request(
        'POST',
        `conversations/${conversationId}/messages`,
        rawBubbleInput,
        alice.cookie,
      )
    ).text(),
  );
  const rawReply = '第一条。 <END> <<HIDE_TEST>>第二条。';
  check(
    rawBubbles.find((event) => event.type === 'message')?.message.content === rawReply,
    'SSE retains the complete original reply, including delimiters and hidden display markers',
  );
  check(
    (await api('GET', `conversations/${conversationId}`, undefined, alice.cookie)).data.messages.at(
      -1,
    ).content === rawReply,
    'Persistence stores one unmodified role reply for all visible bubbles',
  );
  const replayBubbles = events(
    await (
      await request(
        'POST',
        `conversations/${conversationId}/messages`,
        rawBubbleInput,
        alice.cookie,
      )
    ).text(),
  );
  check(
    replayBubbles.find((event) => event.type === 'message')?.message.content === rawReply,
    'Idempotent replay preserves the exact original bubble content',
  );
  check(
    lastSystemPrompt.includes('消息气泡分隔符（JSON 表示）：" <END> "'),
    'Whitespace around the custom separator is preserved in the model prompt',
  );
  upstreamMode = 'ok';
  await api('PATCH', 'admin/settings', { bubbleSeparator: '' }, adminCookie);
  await (
    await request(
      'POST',
      `conversations/${conversationId}/messages`,
      { content: '@测试角色甲 正常回复。', requestId: 'backend-bubbles-disabled' },
      alice.cookie,
    )
  ).text();
  check(
    !lastSystemPrompt.includes('消息气泡分隔符'),
    'Disabling the delimiter removes IM split instructions from the system prompt',
  );
  await api('PATCH', 'admin/settings', { bubbleSeparator: '\\n\\n' }, adminCookie);
  await (
    await request(
      'POST',
      `conversations/${conversationId}/messages`,
      { content: '@测试角色甲 按换行分段。', requestId: 'backend-bubbles-newline' },
      alice.cookie,
    )
  ).text();
  check(
    lastSystemPrompt.includes(`消息气泡分隔符（JSON 表示）：${JSON.stringify('\n\n')}`),
    'Newline delimiter is unambiguously JSON-encoded in the model prompt',
  );
  const clearMarkers = await api(
    'PATCH',
    'admin/settings',
    { bubbleSeparator: '|||', hiddenOutputMarkers: [] },
    adminCookie,
  );
  check(
    clearMarkers.status === 200 && clearMarkers.data.settings.hiddenOutputMarkers.length === 0,
    'Empty marker list turns off display filtering',
  );
  const additionalLogin = await api('POST', 'auth/login', {
    email: 'alice@example.com',
    password: 'strong-password-2026',
  });
  const staleEmailToken = 'd'.repeat(64);
  db.prepare(
    'INSERT INTO verification_tokens(token_hash,user_id,expires_at,new_email) VALUES (?,?,?,?)',
  ).run(
    createHash('sha256').update(staleEmailToken).digest('hex'),
    alice.data.user.id,
    new Date(Date.now() + 60000).toISOString(),
    'stale@example.com',
  );
  const changed = await api(
    'POST',
    'auth/password',
    { currentPassword: 'strong-password-2026', newPassword: 'changed-password-2026' },
    alice.cookie,
  );
  check(changed.status === 200 && !!changed.cookie, 'Password change rotates current session');
  check(
    (await api('GET', 'session', undefined, additionalLogin.cookie)).data.user === null,
    'Password change revokes other sessions',
  );
  check(
    (await api('GET', 'session', undefined, changed.cookie)).data.user.id === alice.data.user.id,
    'Current session survives password rotation',
  );
  check(
    (await api('POST', 'auth/verify-email', { token: staleEmailToken })).status === 400,
    'Password change revokes previously issued email-change links',
  );
  const protectedCharacter = await api(
    'DELETE',
    `admin/characters/${characters[0]}`,
    {},
    adminCookie,
  );
  check(
    protectedCharacter.status === 409,
    'In-use character deletion preserves conversation history',
  );
  check(
    (
      await api(
        'PATCH',
        `admin/users/${administrator.data.user.id}`,
        { disabled: true },
        adminCookie,
      )
    ).status === 409,
    'Administrator cannot disable self',
  );
  await api('PATCH', `admin/users/${bob.data.user.id}`, { disabled: true }, adminCookie);
  check(
    (await api('GET', 'session', undefined, bob.cookie)).data.user === null,
    'Disabled account sessions are revoked',
  );
  check(
    (
      await api('POST', 'auth/reset-password', {
        token: 'a'.repeat(64),
        password: 'changed-password-2026',
      })
    ).status === 400,
    'Unknown reset tokens never grant access',
  );
  check(
    (await api('POST', 'auth/verify-email', { token: 'a'.repeat(64) })).status === 400,
    'Unknown verification tokens never grant access',
  );
  // Tokens are injected only into this isolated database to exercise consume/replay
  // semantics offline. Actual SMTP delivery still requires operator credentials.
  const verificationToken = 'b'.repeat(64),
    hash = (value) => createHash('sha256').update(value).digest('hex');
  db.prepare('UPDATE users SET email_verified=0 WHERE id=?').run(alice.data.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(alice.data.user.id);
  db.prepare(
    'INSERT INTO verification_tokens(token_hash,user_id,expires_at,new_email) VALUES (?,?,?,NULL)',
  ).run(hash(verificationToken), alice.data.user.id, new Date(Date.now() + 60000).toISOString());
  check(
    (
      await api('POST', 'auth/login', {
        email: 'alice@example.com',
        password: 'changed-password-2026',
      })
    ).data.error.code === 'EMAIL_NOT_VERIFIED',
    'Correct password cannot bypass required email verification',
  );
  const verified = await api('POST', 'auth/verify-email', { token: verificationToken });
  check(
    verified.status === 200 && verified.data.user.id === alice.data.user.id && !!verified.cookie,
    'Valid verification token grants a verified session',
  );
  check(
    (await api('POST', 'auth/verify-email', { token: verificationToken })).status === 400,
    'Verification token is consumed exactly once',
  );
  const resetToken = 'c'.repeat(64);
  db.prepare('INSERT INTO reset_tokens(token_hash,user_id,expires_at) VALUES (?,?,?)').run(
    hash(resetToken),
    alice.data.user.id,
    new Date(Date.now() + 60000).toISOString(),
  );
  check(
    (
      await api('POST', 'auth/reset-password', {
        token: resetToken,
        password: 'recovered-password-2026',
      })
    ).status === 200,
    'Valid reset token changes the password',
  );
  check(
    (await api('GET', 'session', undefined, verified.cookie)).data.user === null,
    'Password reset revokes all authenticated sessions',
  );
  check(
    (
      await api('POST', 'auth/reset-password', {
        token: resetToken,
        password: 'another-password-2026',
      })
    ).status === 400,
    'Password reset token cannot be replayed',
  );
  check(
    (
      await api('POST', 'auth/login', {
        email: 'alice@example.com',
        password: 'recovered-password-2026',
      })
    ).status === 200,
    'Recovered password authenticates normally',
  );
  const oldEmailResetToken = 'e'.repeat(64),
    changeEmailToken = 'f'.repeat(64);
  db.prepare('INSERT INTO reset_tokens(token_hash,user_id,expires_at) VALUES (?,?,?)').run(
    hash(oldEmailResetToken),
    alice.data.user.id,
    new Date(Date.now() + 60000).toISOString(),
  );
  db.prepare(
    'INSERT INTO verification_tokens(token_hash,user_id,expires_at,new_email) VALUES (?,?,?,?)',
  ).run(
    hash(changeEmailToken),
    alice.data.user.id,
    new Date(Date.now() + 60000).toISOString(),
    'alice-new@example.com',
  );
  const emailChanged = await api('POST', 'auth/verify-email', { token: changeEmailToken });
  check(
    emailChanged.status === 200 && emailChanged.data.user.email === 'alice-new@example.com',
    'Email-change token updates the verified login address',
  );
  check(
    (
      await api('POST', 'auth/reset-password', {
        token: oldEmailResetToken,
        password: 'another-password-2026',
      })
    ).status === 400,
    'Email change revokes reset links sent to the previous email address',
  );
  const raceAccount = await api('POST', 'auth/register', {
    username: '并发凭据测试用户',
    email: 'race@example.com',
    password: 'race-initial-password-2026',
  });
  check(raceAccount.status === 201, 'Race regression runs under an isolated ordinary account');
  const loginBarrier = pauseNextDerivation('race-initial-password-2026');
  const staleLoginPromise = api('POST', 'auth/login', {
    email: 'race@example.com',
    password: 'race-initial-password-2026',
  });
  await loginBarrier.wait();
  const firstRotation = await api(
    'POST',
    'auth/password',
    { currentPassword: 'race-initial-password-2026', newPassword: 'race-first-safe-password-2026' },
    raceAccount.cookie,
  );
  check(
    firstRotation.status === 200,
    'Password rotation can complete while an earlier login is suspended',
  );
  loginBarrier.release();
  const staleLogin = await staleLoginPromise;
  check(
    staleLogin.status === 401 &&
      staleLogin.data.error.code === 'INVALID_CREDENTIALS' &&
      !staleLogin.cookie,
    'Login cannot mint a session from a password snapshot invalidated during scrypt',
  );
  check(
    db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').get(raceAccount.data.user.id)
      .n === 1,
    'Rejected stale login leaves only the newly rotated session',
  );
  const changeBarrier = pauseNextDerivation('race-stale-proposal-2026');
  const staleChangePromise = api(
    'POST',
    'auth/password',
    { currentPassword: 'race-first-safe-password-2026', newPassword: 'race-stale-proposal-2026' },
    firstRotation.cookie,
  );
  await changeBarrier.wait();
  const winningRotation = await api(
    'POST',
    'auth/password',
    { currentPassword: 'race-first-safe-password-2026', newPassword: 'race-winning-password-2026' },
    firstRotation.cookie,
  );
  check(
    winningRotation.status === 200,
    'Another password change can commit before a suspended derivation resumes',
  );
  changeBarrier.release();
  const staleChange = await staleChangePromise;
  check(
    staleChange.status === 401 &&
      staleChange.data.error.code === 'UNAUTHORIZED' &&
      !staleChange.cookie,
    'An in-flight password change cannot overwrite credentials after its session was revoked',
  );
  check(
    (await api('GET', 'session', undefined, winningRotation.cookie)).data.user.id ===
      raceAccount.data.user.id,
    'Rejected stale change preserves the winning session',
  );
  check(
    (
      await api('POST', 'auth/login', {
        email: 'race@example.com',
        password: 'race-stale-proposal-2026',
      })
    ).status === 401,
    'Stale proposed password was never persisted',
  );
  check(
    (
      await api('POST', 'auth/login', {
        email: 'race@example.com',
        password: 'race-winning-password-2026',
      })
    ).status === 200,
    'The winning password remains usable after the race',
  );
  const domainBarrier = pauseNextDerivation('domain-policy-race-password-2026');
  const pendingRegistration = api('POST', 'auth/register', {
    username: '在途域名注册测试',
    email: 'domain-race@example.com',
    password: 'domain-policy-race-password-2026',
  });
  await domainBarrier.wait();
  const domainPolicy = await api(
    'PATCH',
    'admin/settings',
    { allowedEmailDomains: ['allowed.example'] },
    adminCookie,
  );
  domainBarrier.release();
  const rejectedRegistration = await pendingRegistration;
  check(
    domainPolicy.status === 200 &&
      rejectedRegistration.status === 400 &&
      rejectedRegistration.data.error.code === 'EMAIL_DOMAIN_NOT_ALLOWED',
    'Registration rechecks the newest domain policy after asynchronous password derivation',
  );
  check(
    !db.prepare('SELECT id FROM users WHERE email=?').get('domain-race@example.com'),
    'A newly disallowed in-flight registration leaves no account behind',
  );
  await api('PATCH', 'admin/settings', { allowedEmailDomains: [] }, adminCookie);
  const profileRace = await api('POST', 'auth/register', {
    username: '资料竞态用户',
    email: 'profile-race@example.com',
    password: 'profile-race-initial-password',
  });
  const priorMailSettings = (await api('GET', 'admin/settings', undefined, adminCookie)).data
    .settings;
  await api(
    'PATCH',
    'admin/settings',
    {
      siteUrl: origin,
      smtpHost: 'smtp.example.test',
      smtpPort: 465,
      smtpSecure: true,
      smtpFrom: 'test@example.test',
    },
    adminCookie,
  );
  mockMailEnabled = true;
  const profileBarrier = pauseNextDerivation('profile-race-initial-password');
  const staleProfilePromise = api(
    'PATCH',
    'profile',
    { email: 'stale-target@example.com', currentPassword: 'profile-race-initial-password' },
    profileRace.cookie,
  );
  await profileBarrier.wait();
  const profileRotation = await api(
    'POST',
    'auth/password',
    {
      currentPassword: 'profile-race-initial-password',
      newPassword: 'profile-race-current-password',
    },
    profileRace.cookie,
  );
  profileBarrier.release();
  const staleProfile = await staleProfilePromise;
  check(
    profileRotation.status === 200 &&
      staleProfile.status === 401 &&
      staleProfile.data.error.code === 'UNAUTHORIZED',
    'In-flight email change cannot outlive password rotation and original-session revocation',
  );
  check(
    testMailOutbox.length === 0 &&
      db
        .prepare('SELECT COUNT(*) AS n FROM verification_tokens WHERE user_id=?')
        .get(profileRace.data.user.id).n === 0,
    'Rejected stale profile creates no fresh email-change capability and sends no mail',
  );
  const smtpBarrier = pauseNextMail();
  const waitingProfile = api(
    'PATCH',
    'profile',
    {
      username: '授权资料已提交',
      email: 'smtp-target@example.com',
      currentPassword: 'profile-race-current-password',
    },
    profileRotation.cookie,
  );
  const pendingMail = await smtpBarrier.wait();
  check(
    db
      .prepare('SELECT COUNT(*) AS n FROM verification_tokens WHERE user_id=?')
      .get(profileRace.data.user.id).n === 1,
    'Email-change token is issued before the external SMTP await',
  );
  const smtpRotation = await api(
    'POST',
    'auth/password',
    {
      currentPassword: 'profile-race-current-password',
      newPassword: 'profile-race-final-password',
    },
    profileRotation.cookie,
  );
  smtpBarrier.release();
  const afterSmtp = await waitingProfile;
  const pendingToken = /[?&]token=([a-f0-9]{64})/.exec(pendingMail.text)[1];
  check(
    smtpRotation.status === 200 &&
      afterSmtp.status === 401 &&
      db
        .prepare('SELECT COUNT(*) AS n FROM verification_tokens WHERE user_id=?')
        .get(profileRace.data.user.id).n === 0,
    'Password rotation during SMTP keeps the issued token revoked and the stale profile request unauthorized',
  );
  check(
    (await api('POST', 'auth/verify-email', { token: pendingToken })).status === 400 &&
      (await api('GET', 'session', undefined, smtpRotation.cookie)).data.user.email ===
        'profile-race@example.com',
    'An already-delivered stale email-change link cannot reclaim the account after rotation',
  );
  mockMailFailure = true;
  check(
    (
      await api(
        'PATCH',
        'profile',
        { email: 'failed-delivery@example.com', currentPassword: 'profile-race-final-password' },
        smtpRotation.cookie,
      )
    ).status === 502 &&
      db
        .prepare('SELECT COUNT(*) AS n FROM verification_tokens WHERE user_id=?')
        .get(profileRace.data.user.id).n === 0,
    'Failed SMTP delivery removes only its unsent verification capability',
  );
  mockMailFailure = false;
  const delayedFailure = pauseNextMail();
  const earlierDelivery = api(
    'PATCH',
    'profile',
    { email: 'earlier-delivery@example.com', currentPassword: 'profile-race-final-password' },
    smtpRotation.cookie,
  );
  await delayedFailure.wait();
  const laterDelivery = await api(
    'PATCH',
    'profile',
    { email: 'later-delivery@example.com', currentPassword: 'profile-race-final-password' },
    smtpRotation.cookie,
  );
  delayedFailure.reject();
  const earlierFailed = await earlierDelivery;
  const laterToken = /[?&]token=([a-f0-9]{64})/.exec(testMailOutbox.at(-1).text)[1];
  check(
    laterDelivery.status === 200 &&
      earlierFailed.status === 502 &&
      db
        .prepare('SELECT new_email FROM verification_tokens WHERE user_id=?')
        .get(profileRace.data.user.id).new_email === 'later-delivery@example.com',
    'Late SMTP failure cannot delete a newer email-change token',
  );
  check(
    (await api('POST', 'auth/verify-email', { token: laterToken })).data.user.email ===
      'later-delivery@example.com',
    'The newest valid email-change capability still works after an older mail failure',
  );
  const emailBudgetA = await api('POST', 'auth/register', {
    username: '邮件预算用户甲',
    email: 'mail-budget-a@example.com',
    password: 'mail-budget-password-2026',
  });
  const emailBudgetB = await api('POST', 'auth/register', {
    username: '邮件预算用户乙',
    email: 'mail-budget-b@example.com',
    password: 'mail-budget-password-2026',
  });
  const emailChange = (account, email) =>
    api(
      'PATCH',
      'profile',
      { email, currentPassword: 'mail-budget-password-2026' },
      account.cookie,
    );
  for (let index = 0; index < 5; index++)
    check(
      (await emailChange(emailBudgetA, 'mail-target@example.com')).status === 200,
      'Recipient mail budget permits its configured five hourly attempts',
    );
  const mailCountAtRecipientLimit = testMailOutbox.length;
  const recipientLimited = await emailChange(emailBudgetB, 'mail-target@example.com');
  check(
    recipientLimited.status === 429 &&
      recipientLimited.data.error.code === 'RATE_LIMITED' &&
      testMailOutbox.length === mailCountAtRecipientLimit,
    'Recipient limit applies across accounts and refuses excess mail before SMTP',
  );
  check(
    (await emailChange(emailBudgetB, 'other-mail-target@example.com')).status === 200,
    'A different recipient remains usable after another recipient exhausts its budget',
  );
  for (let index = 0; index < 5; index++)
    check(
      (await emailChange(emailBudgetA, `mail-target-${index}@example.com`)).status === 200,
      'User mail budget permits a total of ten hourly attempts across recipients',
    );
  const mailCountAtUserLimit = testMailOutbox.length;
  const userLimited = await emailChange(emailBudgetA, 'unused-mail-target@example.com');
  check(
    userLimited.status === 429 &&
      userLimited.data.error.code === 'RATE_LIMITED' &&
      testMailOutbox.length === mailCountAtUserLimit,
    'User limit prevents unlimited email changes to different recipients without sending extra mail',
  );
  check(
    (await emailChange(emailBudgetB, 'unused-mail-target@example.com')).status === 200,
    'One exhausted user does not consume another user or unused recipient budget',
  );
  check(
    (
      await api(
        'PATCH',
        'profile',
        { email: 'invalid-password-target@example.com', currentPassword: 'incorrect-password' },
        emailBudgetA.cookie,
      )
    ).data.error.code === 'PASSWORD_REQUIRED',
    'Email-change authorization is checked before mail throttling',
  );
  const userHitsBeforeRename = db
    .prepare('SELECT hits FROM rate_limits WHERE key=?')
    .get(`email-change-user:${emailBudgetB.data.user.id}`).hits;
  check(
    (
      await api(
        'PATCH',
        'profile',
        { username: '仅修改昵称', email: emailBudgetB.data.user.email },
        emailBudgetB.cookie,
      )
    ).status === 200 &&
      db
        .prepare('SELECT hits FROM rate_limits WHERE key=?')
        .get(`email-change-user:${emailBudgetB.data.user.id}`).hits === userHitsBeforeRename,
    'Profile edits without a changed email consume no email budget',
  );
  check(
    db
      .prepare("SELECT key FROM rate_limits WHERE key LIKE 'email-change-target:%'")
      .all()
      .every((item) => /^[a-f0-9]{64}$/.test(item.key.slice('email-change-target:'.length))),
    'Recipient throttle keys contain only hashes, not raw email addresses',
  );
  mockMailEnabled = false;
  await api('PATCH', 'admin/settings', priorMailSettings, adminCookie);
  const deleteRace = await api('POST', 'auth/register', {
    username: '删除竞态用户',
    email: 'delete-race@example.com',
    password: 'delete-race-initial-password',
  });
  const deleteBarrier = pauseNextDerivation('delete-race-initial-password');
  const staleDeletePromise = api(
    'DELETE',
    'profile',
    { password: 'delete-race-initial-password' },
    deleteRace.cookie,
  );
  await deleteBarrier.wait();
  const deleteRotation = await api(
    'POST',
    'auth/password',
    {
      currentPassword: 'delete-race-initial-password',
      newPassword: 'delete-race-current-password',
    },
    deleteRace.cookie,
  );
  deleteBarrier.release();
  const staleDelete = await staleDeletePromise;
  check(
    deleteRotation.status === 200 &&
      staleDelete.status === 401 &&
      !!db.prepare('SELECT id FROM users WHERE id=?').get(deleteRace.data.user.id),
    'A paused deletion cannot erase an account after its password and sessions rotate',
  );
  const roleBarrier = pauseNextDerivation('delete-race-current-password');
  const promotedDeletePromise = api(
    'DELETE',
    'profile',
    { password: 'delete-race-current-password' },
    deleteRotation.cookie,
  );
  await roleBarrier.wait();
  const promotion = await api(
    'PATCH',
    `admin/users/${deleteRace.data.user.id}`,
    { role: 'admin' },
    adminCookie,
  );
  roleBarrier.release();
  const promotedDelete = await promotedDeletePromise;
  check(
    promotion.status === 200 &&
      promotedDelete.status === 401 &&
      db.prepare('SELECT role FROM users WHERE id=?').get(deleteRace.data.user.id).role === 'admin',
    'Role promotion and its session revocation prevent an in-flight ordinary-user deletion',
  );
  console.log(
    `Backend smoke: ${assertions} assertions passed (real SQLite, authentication, ownership, SSE, atomic turns, cancellation and encrypted secrets).`,
  );
} finally {
  db?.close();
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
}
