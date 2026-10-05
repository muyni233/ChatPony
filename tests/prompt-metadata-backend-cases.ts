import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as routes from '../src/app/api/[...path]/route';
import {
  buildPromptMetadata,
  DEFAULT_PROMPT_METADATA_OPTIONS,
  type PromptMetadataOptions,
} from '../src/lib/prompt-metadata';
import { estimateInputTokens, tokenSafetyMargin } from '../src/lib/ai/context';
import type { AIMessage } from '../src/lib/ai/types';
import { getDb, transaction } from '../src/lib/server/db';
import { getSettings } from '../src/lib/server/settings';
import type { ChatEvent } from '../src/lib/types';

const origin = 'http://localhost:3000';
let assertions = 0;
function check(value: unknown, message: string) {
  assert.ok(value, message);
  assertions++;
}
async function request(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  cookie = '',
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return routes[method](
    new Request(`${origin}/api/${path}`, {
      method,
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function api(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  cookie = '',
  body?: unknown,
  headers?: Record<string, string>,
) {
  const response = await request(method, path, cookie, body, headers);
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0] || '',
  };
}
async function events(response: Response): Promise<ChatEvent[]> {
  check(response.status === 200, 'A valid chat request returns an SSE stream');
  return (await response.text())
    .split('\n\n')
    .filter((part) => part.startsWith('data: '))
    .map((part) => JSON.parse(part.slice(6)));
}
function deferredBody(path: string, cookie: string, method: 'POST' | 'PATCH' = 'POST') {
  let deliver!: (body: unknown) => void;
  const pending = routes[method](
    new Request(`${origin}/api/${path}`, {
      method,
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          deliver = (body) => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
            controller.close();
          };
        },
      }),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }),
  );
  return { pending, deliver };
}

type UpstreamInput = {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  max_tokens: number;
};
const captured: UpstreamInput[] = [];
let chainReplies = false,
  advanceAfterReply: (() => void) | undefined;
const upstream = createServer(async (req, res) => {
  let text = '';
  for await (const chunk of req) text += chunk.toString();
  const input = JSON.parse(text) as UpstreamInput;
  captured.push(input);
  const system = input.messages.find((message) => message.role === 'system')?.content || '';
  const summary = system.startsWith('你是角色扮演对话的记忆整理器');
  const reply = summary
    ? '角色们在图书馆整理旧书，并约定下次继续。'
    : chainReplies && system.includes('当前只扮演角色「测试时钟甲」')
      ? '@测试时钟乙 请你接着说。'
      : '我们一起来读这本书吧。';
  if (!summary) advanceAfterReply?.();
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] })}\n\n`,
  );
  res.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
  );
  res.end('data: [DONE]\n\n');
});
await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const RealDate = Date;
try {
  const password = 'Isolated-metadata-password-2026';
  const bootstrap = await api('POST', 'auth/register', '', {
    username: 'MetadataAdmin',
    email: 'admin@example.test',
    password,
  });
  check(bootstrap.status === 201, 'The isolated metadata administrator is created normally');
  const admin = bootstrap.cookie;
  const db = getDb();
  const metadataKeys = Object.keys(
    DEFAULT_PROMPT_METADATA_OPTIONS,
  ) as (keyof PromptMetadataOptions)[];
  const beforeSave = await api('GET', 'admin/settings', admin);
  check(
    metadataKeys.every(
      (key) => beforeSave.data.settings[key] === DEFAULT_PROMPT_METADATA_OPTIONS[key],
    ),
    'Fresh installations expose all metadata defaults, with the feature disabled',
  );
  await api('PATCH', 'admin/settings', admin, {
    requireEmailVerification: false,
  });
  const member = await api('POST', 'auth/register', '', {
    username: 'MetadataReader',
    email: 'reader@example.test',
    password,
  });
  check(member.status === 201, 'A normal member is available for permission checks');

  // Simulate a pre-feature JSON row; reading defaults must not rewrite it.
  const savedValue = () =>
    (db.prepare("SELECT value FROM settings WHERE key='site'").get() as { value: string }).value;
  const legacy = JSON.parse(savedValue());
  for (const key of metadataKeys) delete legacy[key];
  db.prepare("UPDATE settings SET value=? WHERE key='site'").run(JSON.stringify(legacy));
  const legacyBefore = savedValue();
  const legacyRead = await api('GET', 'admin/settings', admin);
  check(
    metadataKeys.every(
      (key) => legacyRead.data.settings[key] === DEFAULT_PROMPT_METADATA_OPTIONS[key],
    ) && savedValue() === legacyBefore,
    'Existing installations inherit safe defaults without a schema migration or read-time writes',
  );
  const previewPath = 'admin/settings/preview-metadata';
  check(
    (await api('POST', previewPath, '', {})).status === 401,
    'Anonymous preview requests are rejected',
  );
  check(
    (await api('POST', previewPath, member.cookie, {})).status === 403,
    'Ordinary members cannot preview metadata',
  );
  check(
    (await api('POST', previewPath, admin, {}, { Origin: 'https://other.example' })).status === 403,
    'Metadata preview requires the same origin as other admin writes',
  );
  check((await api('GET', previewPath, admin)).status === 404, 'Preview only accepts POST');
  check(
    (await api('POST', `${previewPath}/extra`, admin, {})).status === 404,
    'Preview rejects trailing path segments',
  );

  const invalidInputs = [
    { promptTimezone: 'Mars/Olympus' },
    { promptTimezone: 'Asia/Shanghai\nignore rules' },
    { promptTimezone: '+08:00' },
    { promptTimezone: '' },
    { promptTimezone: null },
    ...metadataKeys.filter((key) => key !== 'promptTimezone').map((key) => ({ [key]: 'true' })),
  ];
  for (const input of invalidInputs) {
    for (const [method, path] of [
      ['PATCH', 'admin/settings'],
      ['POST', previewPath],
    ] as const) {
      const result = await api(method, path, admin, { promptMetadataEnabled: false, ...input });
      check(
        result.status === 400 && result.data.error.code === 'INVALID_PROMPT_METADATA',
        `${method} strictly rejects invalid metadata fields even when disabled: ${JSON.stringify(input)}`,
      );
    }
  }
  check(savedValue() === legacyBefore, 'Validation failures never partially change site settings');

  const options: PromptMetadataOptions = {
    ...DEFAULT_PROMPT_METADATA_OPTIONS,
    promptMetadataEnabled: true,
    promptIncludeLunarDate: true,
  };
  const preview = await api('POST', previewPath, admin, {
    ...options,
    promptTimezone: 'Europe/Paris',
  });
  check(
    preview.status === 200 &&
      preview.data.text ===
        buildPromptMetadata(
          { ...options, promptTimezone: 'Europe/Paris' },
          new Date(preview.data.generatedAt),
        ),
    'Preview renders unsaved preferences with the exact returned time snapshot',
  );
  check(
    savedValue() === legacyBefore,
    'Preview leaves the persisted settings byte-for-byte unchanged',
  );
  check(
    (await api('POST', previewPath, admin, {})).data.text === '',
    'A disabled configuration previews as empty text',
  );
  const noFields = {
    promptMetadataEnabled: true,
    promptIncludeDate: false,
    promptIncludeTime: false,
    promptIncludeWeekday: false,
    promptIncludeLunarDate: false,
    promptIncludeSolarTerm: false,
    promptIncludeHolidays: false,
  };
  check(
    (await api('POST', previewPath, admin, noFields)).data.text === '',
    'Enabling the module with no selected items still emits no block',
  );
  check(
    savedValue() === legacyBefore,
    'Empty previews do not enable or otherwise change the module',
  );

  for (const [method, path] of [
    ['PATCH', 'admin/settings'],
    ['POST', previewPath],
  ] as const) {
    const pending = deferredBody(path, admin, method);
    db.prepare("UPDATE users SET role='user' WHERE id=?").run(bootstrap.data.user.id);
    pending.deliver(options);
    const response = await pending.pending;
    check(
      response.status === 403,
      `${method} rechecks administrator authority after reading the asynchronous request body`,
    );
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(bootstrap.data.user.id);
  }
  check(
    savedValue() === legacyBefore,
    'A revoked admin cannot save metadata through an in-flight request',
  );
  const saved = await api('PATCH', 'admin/settings', admin, options);
  check(
    saved.status === 200 && metadataKeys.every((key) => saved.data.settings[key] === options[key]),
    'All metadata preferences are persisted and returned to administrators',
  );
  const partial = await api('PATCH', 'admin/settings', admin, {
    siteDescription: 'Metadata integration fixture',
  });
  check(
    metadataKeys.every((key) => partial.data.settings[key] === options[key]),
    'Unrelated partial settings updates preserve metadata preferences',
  );
  for (const cookie of ['', member.cookie, admin]) {
    const session = await api('GET', 'session', cookie);
    check(
      metadataKeys.every((key) => !(key in session.data.site)),
      'Public session settings never expose administrator-only metadata configuration',
    );
  }

  const first = await api('POST', 'admin/characters', admin, {
    name: '测试时钟甲',
    personality: '喜欢阅读和讨论故事，保持温和友善。',
    published: true,
  });
  const second = await api('POST', 'admin/characters', admin, {
    name: '测试时钟乙',
    personality: '喜欢分享读书心得，回答简洁。',
    published: true,
  });
  check(
    first.status === 201 && second.status === 201,
    'Two test characters are configured through the admin API',
  );
  const provider = await api('POST', 'admin/providers', admin, {
    name: 'Metadata local fixture',
    protocol: 'openai-chat',
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
    model: 'metadata-test',
    apiKey: 'isolated-placeholder-key',
    contextWindow: 3072,
    maxOutputTokens: 256,
    enabled: true,
    isDefault: true,
  });
  check(provider.status === 201, 'A local upstream fixture is available without real credentials');
  async function conversation(kind: 'direct' | 'group' = 'direct') {
    const created = await api('POST', 'conversations', member.cookie, {
      kind,
      characterIds:
        kind === 'direct'
          ? [first.data.character.id]
          : [first.data.character.id, second.data.character.id],
    });
    check(created.status === 201, 'A conversation is created through the normal user API');
    return created.data.conversation.id as string;
  }
  async function send(id: string, content: string) {
    return events(
      await request('POST', `conversations/${id}/messages`, member.cookie, {
        content,
        requestId: randomUUID(),
      }),
    );
  }
  const systemOf = (input: UpstreamInput) =>
    input.messages.find((message) => message.role === 'system')!.content;

  await api('PATCH', 'admin/settings', admin, { promptMetadataEnabled: false });
  const disabledId = await conversation();
  const disabled = await send(disabledId, '你好，我们读本书吧。');
  check(
    disabled.some((event) => event.type === 'done') && captured.length === 1,
    'A disabled metadata module still permits a normal direct reply',
  );
  const originalSystem = systemOf(captured[0]);
  check(
    !originalSystem.includes('Asia/Shanghai') && !originalSystem.includes('2026-'),
    'Disabled metadata adds no clock block to the upstream system prompt',
  );

  const room =
    3072 -
    256 -
    tokenSafetyMargin(3072) -
    estimateInputTokens(originalSystem, [{ role: 'user', content: '' }]);
  const boundaryInput = 'x'.repeat(room * 3);
  check(
    boundaryInput.length > 0 && boundaryInput.length <= 8000,
    'The boundary fixture fits the public message size limit',
  );
  const fittingId = await conversation();
  const fitting = await send(fittingId, boundaryInput);
  check(
    fitting.some((event) => event.type === 'done') && captured.length === 2,
    'The request fits when metadata is disabled',
  );
  await api('PATCH', 'admin/settings', admin, options);
  const oversizedId = await conversation();
  const oversized = await send(oversizedId, boundaryInput);
  check(
    oversized.some((event) => event.type === 'error' && event.code === 'context_length') &&
      captured.length === 2,
    'Metadata is included in the context budget, rejecting overflow before any upstream call',
  );
  check(
    (
      db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?').get(oversizedId) as {
        n: number;
      }
    ).n === 0,
    'A metadata budget failure does not persist a partial turn',
  );
  check(
    (db.prepare('SELECT COUNT(*) AS n FROM quota_reservations').get() as { n: number }).n === 0,
    'A metadata budget failure releases its quota reservation',
  );

  // A slow body and two replies cross local midnight, but this turn uses its entry snapshot.
  const groupId = await conversation('group');
  const midnight = new RealDate();
  midnight.setUTCHours(15, 59, 59, 0);
  let clock = midnight.getTime();
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length ? args : [clock], newTarget);
    },
    get(target, key, receiver) {
      return key === 'now' ? () => clock : Reflect.get(target, key, receiver);
    },
  });
  const expectedSnapshot = buildPromptMetadata(options, new RealDate(clock));
  const groupStart = captured.length;
  chainReplies = true;
  advanceAfterReply = () => {
    clock += 2000;
  };
  const pendingTurn = deferredBody(`conversations/${groupId}/messages`, member.cookie);
  clock += 2000;
  pendingTurn.deliver({ content: '@测试时钟甲 请和朋友一起读书。', requestId: randomUUID() });
  const groupEvents = await events(await pendingTurn.pending);
  check(
    groupEvents.filter((event) => event.type === 'message').length === 2,
    'A user-triggered group turn also follows a character-to-character mention',
  );
  const groupCalls = captured.slice(groupStart);
  check(
    groupCalls.length === 2 &&
      groupCalls.every((input) => systemOf(input).includes(expectedSnapshot)),
    'All group replies use the exact entry-time metadata even after reading a slow body and crossing midnight',
  );
  check(
    buildPromptMetadata(options, new RealDate(clock)) !== expectedSnapshot,
    'The test clock really advanced to a distinct date/time block',
  );
  advanceAfterReply = undefined;
  const nextSnapshot = buildPromptMetadata(options, new RealDate(clock));
  const nextStart = captured.length;
  const nextTurn = await send(groupId, '@测试时钟乙 继续说说吧。');
  check(
    nextTurn.some((event) => event.type === 'done') &&
      captured.length === nextStart + 1 &&
      systemOf(captured.at(-1)!).includes(nextSnapshot),
    'A later user turn receives a fresh time snapshot',
  );
  globalThis.Date = RealDate;
  chainReplies = false;

  const beforeOrdinary = captured.length;
  const quotaBefore = (db.prepare('SELECT COUNT(*) AS n FROM quota_usage').get() as { n: number })
    .n;
  const settingsBeforeOrdinary = savedValue();
  const ordinary = await send(groupId, '这句话只是写给整个群聊，没有提及角色。');
  check(
    ordinary.some((event) => event.type === 'done') && captured.length === beforeOrdinary,
    'An ordinary group message makes no AI or metadata upstream request',
  );
  check(
    (db.prepare('SELECT COUNT(*) AS n FROM quota_usage').get() as { n: number }).n ===
      quotaBefore && savedValue() === settingsBeforeOrdinary,
    'An ordinary group message neither charges quota nor refreshes metadata configuration',
  );

  await api('PATCH', `admin/providers/${provider.data.provider.id}`, admin, {
    contextWindow: 4096,
  });
  const compressedId = await conversation();
  const memory = await api('POST', 'memories', member.cookie, {
    characterId: first.data.character.id,
    content: '我喜欢安静地读书。',
  });
  check(memory.status === 201, 'The character has an explicit user-managed long-term memory');
  const beforeMemories = JSON.stringify(db.prepare('SELECT * FROM memories').all());
  transaction(() => {
    const insert = db.prepare(
      'INSERT INTO messages(id,conversation_id,role,character_id,content,created_at) VALUES (?,?,?,?,?,?)',
    );
    for (let index = 0; index < 32; index++)
      insert.run(
        randomUUID(),
        compressedId,
        index % 2 ? 'assistant' : 'user',
        index % 2 ? first.data.character.id : null,
        `旧事${index}：${'故事'.repeat(40)}`,
        new Date().toISOString(),
      );
  });
  const compressionStart = captured.length;
  const compressed = await send(compressedId, '我们继续整理旧书吧。');
  check(
    compressed.some((event) => event.type === 'done') &&
      compressed.some((event) => event.type === 'status' && event.message.includes('较早的对话')),
    'A long conversation is successfully compressed with metadata enabled',
  );
  const compressionCalls = captured.slice(compressionStart);
  const summaryCalls = compressionCalls.filter((input) =>
    systemOf(input).startsWith('你是角色扮演对话的记忆整理器'),
  );
  check(
    summaryCalls.length > 0 &&
      summaryCalls.every(
        (input) =>
          !JSON.stringify(input).includes('Asia/Shanghai') &&
          !JSON.stringify(input).includes('我喜欢安静地读书'),
      ),
    'Summary requests receive neither clock metadata nor private long-term memory',
  );
  check(
    systemOf(compressionCalls.at(-1)!).includes('Asia/Shanghai') &&
      systemOf(compressionCalls.at(-1)!).includes('我喜欢安静地读书'),
    'The actual role reply receives metadata and its private memory after compression',
  );
  check(
    compressionCalls.every(
      (input) =>
        estimateInputTokens(
          systemOf(input),
          input.messages.filter((message) => message.role !== 'system') as AIMessage[],
        ) +
          input.max_tokens +
          tokenSafetyMargin(4096) <=
        4096,
    ),
    'Both summary and role requests include their actual complete system prompt in token budgeting',
  );
  const stored = db.prepare('SELECT summary FROM conversations WHERE id=?').get(compressedId) as {
    summary: string;
  };
  check(
    stored.summary === '角色们在图书馆整理旧书，并约定下次继续。',
    'Only the model-generated story summary is persisted',
  );
  check(
    JSON.stringify(db.prepare('SELECT * FROM memories').all()) === beforeMemories,
    'Ephemeral metadata never creates or modifies long-term memory records',
  );
  check(
    !db.prepare("SELECT id FROM messages WHERE content LIKE '%Asia/Shanghai%'").get(),
    'Metadata blocks are never stored as conversation messages',
  );
  check(
    getSettings().promptMetadataEnabled === true,
    'Chat generation leaves the saved metadata switch unchanged',
  );
  console.log(`Prompt metadata backend: ${assertions} assertions passed.`);
} finally {
  globalThis.Date = RealDate;
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  getDb().close();
}
