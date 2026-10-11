import assert from 'node:assert/strict';
import { basename, join, resolve } from 'node:path';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { getDb, closeDb, id, now } from '../../src/lib/db';
import { createSession } from '../../src/lib/auth';
import {
  getSettings,
  saveCharacter,
  saveProvider,
  saveSupplier,
  updateSettings,
  updateUser,
} from '../../src/lib/repository';
import { saveUserCharacter } from '../../src/lib/user-characters';
import { avatarDirectory } from '../../src/lib/avatars';
import {
  recallMemories,
  reindexMemories,
  updateEmbeddingSettings,
} from '../../src/lib/ai/embeddings';
import { registerMemoryReply, summarizeMemories } from '../../src/lib/ai/maintenance';
import { AppError } from '../../src/lib/errors';
import { toUser, type Row } from '../../src/lib/mappers';
import type {
  Bootstrap,
  Character,
  ChatEvent,
  Conversation,
  ConversationDetail,
  Memory,
  User,
  UserCharacters,
} from '../../src/lib/types';
import { GET, POST, PATCH, DELETE } from '../../src/app/api/[...path]/route';

const directory = process.env.CHATPONY_TEST_DIR;
assert.ok(directory);
process.env.DATABASE_PATH = join(directory, 'private-characters.db');
process.env.ENCRYPTION_KEY = 'e4'.repeat(32);
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
async function response(method: Method, path: string, input?: unknown, cookie = '') {
  return { GET, POST, PATCH, DELETE }[method](
    new Request(`http://private-roles.local/api/${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie.split(';')[0] } : {}),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    }),
    { params: Promise.resolve({ path: path.split('/') }) },
  );
}
async function call<T = Row>(method: Method, path: string, input?: unknown, cookie = '') {
  const result = await response(method, path, input, cookie);
  const body = (await result.json()) as { data: T; error?: { code: string; message: string } };
  return { ...body, status: result.status, cookie: result.headers.get('set-cookie') || '' };
}
async function register(name: string) {
  const result = await call<User>('POST', 'auth/register', {
    name,
    email: `${name.toLowerCase()}@example.test`,
    password: 'private-role-test-password',
  });
  assert.equal(result.status, 201);
  return result;
}
function files() {
  return existsSync(avatarDirectory()) ? readdirSync(avatarDirectory()).sort() : [];
}
const events = async (result: Response): Promise<ChatEvent[]> =>
  (await result.text())
    .split('\n\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
let upstreamCalls = 0;
let embeddingCalls = 0;
let replyText = 'Private role response';
let onUpstream: (() => void) | null = null;
const prompts: string[] = [];
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const payload = (await request.json()) as Record<string, unknown>;
    if (new URL(request.url).pathname.endsWith('/embeddings')) {
      embeddingCalls++;
      return Response.json({
        data: (payload.input as string[]).map((_text, index) => ({ index, embedding: [1, 0, 0] })),
      });
    }
    upstreamCalls++;
    prompts.push(JSON.stringify(payload));
    onUpstream?.();
    return Response.json({
      choices: [{ message: { role: 'assistant', content: replyText }, finish_reason: 'stop' }],
    });
  },
});

try {
  let db = getDb();
  assert.equal(getSettings().defaultCharacterSlots, 3);
  const alice = await register('Alice');
  const bob = await register('Bob');
  const admin = await register('Administrator');
  db.query("UPDATE users SET role='admin' WHERE id=?").run(admin.data.id);
  const adminCookie = createSession(admin.data.id);
  assert.equal(alice.data.characterSlots, 3);
  const supplier = saveSupplier(null, {
    name: 'Fixture supplier',
    protocol: 'openai-completions',
    baseUrl: server.url.toString(),
    apiKey: 'fixture-private-role-key',
    active: true,
  });
  const model = saveProvider(null, {
    supplierId: supplier.id,
    name: 'Allowed language',
    model: 'fixture-language',
  });
  const disabledModel = saveProvider(null, {
    supplierId: supplier.id,
    name: 'Unavailable language',
    model: 'fixture-disabled',
    active: false,
  });
  const vectorModel = saveProvider(null, {
    supplierId: supplier.id,
    name: 'Vector',
    model: 'fixture-vector',
    kind: 'embedding',
  });
  const publicRole = saveCharacter(null, {
    name: 'Public',
    slug: 'public',
    personality: 'Public system persona',
    active: true,
    providerId: model.id,
  });

  // Simulate the previous production schema while preserving real binding IDs and SMTP diagnostics.
  db.query("UPDATE settings SET value='7' WHERE key='defaultCharacterSlots'").run();
  db.exec(
    'DROP INDEX characters_owner; ALTER TABLE characters DROP COLUMN owner_id; ALTER TABLE users DROP COLUMN character_slots; PRAGMA user_version=12;',
  );
  closeDb();
  db = getDb();
  assert.equal((db.query('PRAGMA user_version').get() as Row).user_version, 13);
  assert.equal(
    (db.query('SELECT owner_id FROM characters WHERE id=?').get(publicRole.id) as Row).owner_id,
    null,
  );
  assert.ok(
    (db.query('SELECT character_slots FROM users').all() as Row[]).every(
      (row) => row.character_slots === 7,
    ),
  );
  assert.ok(
    db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='mail_deliveries'").get(),
  );
  assert.equal((await call<Character[]>('GET', 'characters')).data[0].id, publicRole.id);
  closeDb();
  db = getDb();
  assert.equal(
    (db.query('SELECT character_slots FROM users WHERE id=?').get(alice.data.id) as Row)
      .character_slots,
    7,
  );

  updateSettings({ defaultCharacterSlots: 3, automaticMemoryEnabled: false });
  assert.equal((await call('GET', 'account/characters')).status, 401);
  const collection = (
    await call<UserCharacters>('GET', 'account/characters', undefined, alice.cookie)
  ).data;
  assert.deepEqual(collection.slots, { used: 0, limit: 3, remaining: 3 });
  assert.deepEqual(collection.models, [{ id: model.id, name: model.name }]);
  assert.equal(
    (
      await call(
        'POST',
        'account/characters',
        { name: 'No model', personality: 'Test' },
        alice.cookie,
      )
    ).error?.code,
    'PROVIDER_REQUIRED',
  );
  assert.equal(
    (
      await call(
        'POST',
        'account/characters',
        { name: 'Not language', personality: 'Test', providerId: vectorModel.id },
        alice.cookie,
      )
    ).error?.code,
    'LANGUAGE_MODEL_REQUIRED',
  );
  assert.equal(
    (
      await call(
        'POST',
        'account/characters',
        { name: 'Disabled', personality: 'Test', active: false, providerId: disabledModel.id },
        alice.cookie,
      )
    ).error?.code,
    'MODEL_UNAVAILABLE',
  );
  assert.equal(
    (
      await call(
        'POST',
        'account/characters',
        { name: 'Owner injection', personality: 'Test', active: false, ownerId: bob.data.id },
        alice.cookie,
      )
    ).status,
    400,
  );
  const image = `data:image/png;base64,${(
    await sharp({ create: { width: 24, height: 18, channels: 3, background: '#a58bbe' } })
      .png()
      .toBuffer()
  ).toString('base64')}`;
  const a = await call<Character>(
    'POST',
    'account/characters',
    {
      name: 'Aster',
      personality: 'ALICE_PRIVATE_PERSONA',
      greeting: 'Welcome Alice',
      providerId: model.id,
      avatarDataUrl: image,
    },
    alice.cookie,
  );
  const b = await call<Character>(
    'POST',
    'account/characters',
    { name: 'Brook', personality: 'BOB_PRIVATE_PERSONA', providerId: model.id },
    bob.cookie,
  );
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(a.data.ownerId, alice.data.id);
  assert.equal(a.data.active, true);
  assert.match(a.data.slug, /^u-[a-f0-9]{32}$/);
  assert.ok(existsSync(join(avatarDirectory(), basename(a.data.avatar))));
  const privateAvatarPath = a.data.avatar.slice('/api/'.length);
  for (const cookie of ['', bob.cookie, adminCookie])
    assert.equal((await response('GET', privateAvatarPath, undefined, cookie)).status, 404);
  const privateAvatar = await response('GET', privateAvatarPath, undefined, alice.cookie);
  assert.equal(privateAvatar.status, 200);
  assert.equal(privateAvatar.headers.get('content-type'), 'image/webp');
  assert.equal(privateAvatar.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.equal(privateAvatar.headers.get('vary'), 'Cookie');
  db.query('UPDATE characters SET active=0 WHERE id=?').run(a.data.id);
  assert.equal((await response('GET', privateAvatarPath, undefined, alice.cookie)).status, 200);
  assert.equal((await response('GET', privateAvatarPath)).status, 404);
  db.query('UPDATE characters SET active=1 WHERE id=?').run(a.data.id);
  const originalSlug = a.data.slug;
  const rename = await call<Character>(
    'PATCH',
    `account/characters/${a.data.id}`,
    { description: 'A private description' },
    alice.cookie,
  );
  assert.equal(rename.data.slug, originalSlug);
  assert.equal(
    (await call('PATCH', `account/characters/${a.data.id}`, { slug: 'changed' }, alice.cookie))
      .status,
    400,
  );
  assert.equal(
    (
      await call(
        'PATCH',
        `account/characters/${a.data.id}`,
        { avatar: b.data.avatar, ownerId: bob.data.id },
        alice.cookie,
      )
    ).status,
    400,
  );
  for (const cookie of ['', bob.cookie, adminCookie]) {
    const boot = await call<Bootstrap>('GET', 'bootstrap', undefined, cookie);
    assert.equal(
      boot.data.characters.some((role) => role.id === a.data.id),
      false,
    );
    assert.equal(JSON.stringify(boot.data).includes('ALICE_PRIVATE_PERSONA'), false);
  }
  const ownBoot = await call<Bootstrap>('GET', 'bootstrap', undefined, alice.cookie);
  assert.deepEqual(
    new Set(ownBoot.data.characters.map((role) => role.id)),
    new Set([publicRole.id, a.data.id]),
  );
  assert.equal(
    'personality' in ownBoot.data.characters.find((role) => role.id === a.data.id)!,
    false,
  );
  assert.deepEqual(
    (await call<Character[]>('GET', 'admin/characters', undefined, adminCookie)).data.map(
      (role) => role.id,
    ),
    [publicRole.id],
  );
  for (const [path, cookie] of [
    [`account/characters/${a.data.id}`, bob.cookie],
    [`account/characters/${publicRole.id}`, alice.cookie],
    [`admin/characters/${a.data.id}`, adminCookie],
  ]) {
    for (const method of ['PATCH', 'DELETE'] as const)
      assert.equal(
        (await call(method, path, method === 'PATCH' ? { name: 'Forbidden' } : {}, cookie)).status,
        404,
      );
  }
  assert.equal(
    (
      await call(
        'PATCH',
        `account/characters/${a.data.id}`,
        { avatarDataUrl: 'invalid' },
        bob.cookie,
      )
    ).status,
    404,
  );
  for (const kind of ['private', 'group']) {
    const targetIds = kind === 'private' ? [a.data.id] : [publicRole.id, a.data.id];
    assert.equal(
      (await call('POST', 'conversations', { kind, characterIds: targetIds }, bob.cookie)).status,
      404,
    );
  }
  assert.equal(
    (await call('POST', 'memories', { characterId: a.data.id, content: 'Forbidden' }, bob.cookie))
      .status,
    404,
  );
  const conv = await call<Conversation>(
    'POST',
    'conversations',
    { kind: 'private', characterIds: [a.data.id] },
    alice.cookie,
  );
  assert.equal(conv.status, 201);
  assert.equal(
    (await call('GET', `conversations/${conv.data.id}`, undefined, bob.cookie)).status,
    404,
  );
  assert.equal(
    (
      await call<ConversationDetail>(
        'GET',
        `conversations/${conv.data.id}`,
        undefined,
        alice.cookie,
      )
    ).data.messages[0].content,
    'Welcome Alice',
  );
  const messageEvents = await events(
    await response(
      'POST',
      `conversations/${conv.data.id}/messages`,
      { content: 'Hello', requestId: id() },
      alice.cookie,
    ),
  );
  assert.ok(messageEvents.some((event) => event.type === 'message'));
  assert.ok(prompts.at(-1)?.includes('ALICE_PRIVATE_PERSONA'));
  assert.equal(prompts.at(-1)?.includes('BOB_PRIVATE_PERSONA'), false);
  assert.equal(
    (
      await response(
        'POST',
        `conversations/${conv.data.id}/messages`,
        { content: 'Forbidden', requestId: id() },
        bob.cookie,
      )
    ).status,
    404,
  );

  const am = await call<Memory>(
    'POST',
    'memories',
    { characterId: a.data.id, content: 'ALICE_PRIVATE_MEMORY' },
    alice.cookie,
  );
  const bm = await call<Memory>(
    'POST',
    'memories',
    { characterId: b.data.id, content: 'BOB_PRIVATE_MEMORY' },
    bob.cookie,
  );
  assert.equal(am.status, 201);
  assert.equal(bm.status, 201);
  for (const method of ['PATCH', 'DELETE'] as const)
    assert.equal(
      (await call(method, `memories/${am.data.id}`, { content: 'Forbidden' }, bob.cookie)).status,
      404,
    );
  updateEmbeddingSettings({ modelId: vectorModel.id, enabled: true });
  await reindexMemories(alice.data.id, alice.data.id);
  const recalled = await recallMemories(alice.data.id, a.data.id, 'Recall Alice');
  assert.deepEqual(
    recalled.memories.map((memory) => memory.content),
    ['ALICE_PRIVATE_MEMORY'],
  );
  const embeddingsBefore = embeddingCalls;
  await assert.rejects(
    recallMemories(bob.data.id, a.data.id, 'Forbidden'),
    (error) => error instanceof AppError && error.status === 404,
  );
  assert.equal(embeddingCalls, embeddingsBefore);
  // Legacy/tampered rows cannot bypass owner filtering through list, edit, reindex, recall or a forged conversation.
  db.query(
    "INSERT INTO memories(id,user_id,character_id,content,source,created_at,updated_at) VALUES('tampered-memory',?,?,?,'manual',?,?)",
  ).run(bob.data.id, a.data.id, 'Never index another owner', now(), now());
  assert.equal(
    (await call<Memory[]>('GET', 'memories', undefined, bob.cookie)).data.some(
      (memory) => memory.id === 'tampered-memory',
    ),
    false,
  );
  assert.equal(
    (await call('PATCH', 'memories/tampered-memory', { content: 'Bad' }, bob.cookie)).status,
    404,
  );
  await reindexMemories(bob.data.id, bob.data.id);
  assert.equal(
    db.query("SELECT memory_id FROM memory_vectors WHERE memory_id='tampered-memory'").get(),
    null,
  );
  db.query(
    "INSERT INTO conversations(id,user_id,title,kind,character_ids,created_at,updated_at) VALUES('tampered-conversation',?,'Hidden','group',?,?,?)",
  ).run(bob.data.id, JSON.stringify([publicRole.id, a.data.id]), now(), now());
  assert.equal(
    (await call('GET', 'conversations/tampered-conversation', undefined, bob.cookie)).status,
    404,
  );
  assert.equal(
    (await call<Conversation[]>('GET', 'conversations', undefined, bob.cookie)).data.some(
      (item) => item.id === 'tampered-conversation',
    ),
    false,
  );
  const callsBefore = upstreamCalls;
  assert.equal(
    (
      await response(
        'POST',
        'conversations/tampered-conversation/messages',
        { content: '@Aster', requestId: id() },
        bob.cookie,
      )
    ).status,
    404,
  );
  assert.equal(upstreamCalls, callsBefore);
  updateSettings({ automaticMemoryEnabled: true });
  const replyMessage = messageEvents.find(
    (event): event is Extract<ChatEvent, { type: 'message' }> => event.type === 'message',
  )!.message;
  registerMemoryReply(bob.data.id, a.data.id, replyMessage.id);
  assert.equal(
    db
      .query('SELECT seq FROM memory_summary_events WHERE user_id=? AND character_id=?')
      .get(bob.data.id, a.data.id),
    null,
  );
  const unauthorizedSummary = await summarizeMemories({
    user: bob.data,
    characterId: a.data.id,
    conversationId: 'tampered-conversation',
    requestId: id(),
    resolveModel: () => {
      throw new Error('Must not resolve unauthorized model');
    },
    status: () => {},
  });
  assert.equal(unauthorizedSummary, null);
  updateSettings({ automaticMemoryEnabled: false });

  const group = await call<Conversation>(
    'POST',
    'conversations',
    { kind: 'group', characterIds: [publicRole.id, a.data.id], maxRounds: 3 },
    alice.cookie,
  );
  replyText = '@Brook This role is outside the group';
  const groupBefore = upstreamCalls;
  await events(
    await response(
      'POST',
      `conversations/${group.data.id}/messages`,
      { content: '@Aster Hello', requestId: id() },
      alice.cookie,
    ),
  );
  assert.equal(upstreamCalls, groupBefore + 1);
  replyText = '@Aster Next';
  onUpstream = () => {
    db.query('UPDATE characters SET owner_id=? WHERE id=?').run(bob.data.id, a.data.id);
    onUpstream = null;
  };
  const raceBefore = upstreamCalls;
  const race = await events(
    await response(
      'POST',
      `conversations/${group.data.id}/messages`,
      { content: '@Public Begin', requestId: id() },
      alice.cookie,
    ),
  );
  assert.ok(race.some((event) => event.type === 'error'));
  assert.equal(upstreamCalls, raceBefore + 1);
  db.query('UPDATE characters SET owner_id=? WHERE id=?').run(alice.data.id, a.data.id);
  replyText = 'Private role response';

  // Failed image validation and rolled-back writes cannot consume slots or orphan files.
  const beforeFiles = files();
  const beforeSlots = (
    await call<UserCharacters>('GET', 'account/characters', undefined, alice.cookie)
  ).data.slots.used;
  assert.equal(
    (
      await call(
        'POST',
        'account/characters',
        {
          name: 'Invalid image',
          personality: 'Test',
          active: false,
          avatarDataUrl: 'data:image/png;base64,AAAA',
        },
        alice.cookie,
      )
    ).status,
    400,
  );
  assert.deepEqual(files(), beforeFiles);
  db.exec(
    "CREATE TEMP TRIGGER reject_private_avatar BEFORE UPDATE OF avatar ON characters WHEN NEW.name='Rollback' BEGIN SELECT RAISE(ABORT,'fixture_avatar_rollback'); END;",
  );
  await assert.rejects(
    saveUserCharacter(alice.data.id, null, {
      name: 'Rollback',
      personality: 'Test',
      active: false,
      avatarDataUrl: image,
    }),
  );
  db.exec('DROP TRIGGER reject_private_avatar');
  assert.deepEqual(files(), beforeFiles);
  assert.equal(
    (await call<UserCharacters>('GET', 'account/characters', undefined, alice.cookie)).data.slots
      .used,
    beforeSlots,
  );
  const replaced = await call<Character>(
    'PATCH',
    `account/characters/${a.data.id}`,
    { avatarDataUrl: image },
    alice.cookie,
  );
  assert.equal(replaced.status, 200);
  assert.notEqual(replaced.data.avatar, a.data.avatar);
  assert.equal(existsSync(join(avatarDirectory(), basename(a.data.avatar))), false);
  assert.equal(
    (
      await call(
        'PATCH',
        `account/characters/${b.data.id}`,
        { avatar: replaced.data.avatar },
        bob.cookie,
      )
    ).error?.code,
    'INVALID_AVATAR',
  );
  const pendingAvatar = saveUserCharacter(alice.data.id, null, {
    name: 'Race slot',
    personality: 'Test',
    active: false,
    avatarDataUrl: image,
  });
  updateUser(alice.data.id, { characterSlots: 1 });
  await assert.rejects(
    pendingAvatar,
    (error) => error instanceof AppError && error.code === 'CHARACTER_SLOTS_FULL',
  );
  assert.deepEqual(files(), [basename(replaced.data.avatar)]);

  // A draft uses a slot; lowering the allowance never deletes or disables an existing role.
  updateUser(alice.data.id, { characterSlots: 2 });
  const draft = await call<Character>(
    'POST',
    'account/characters',
    { name: 'Draft', personality: 'Not ready', active: false, providerId: null },
    alice.cookie,
  );
  assert.equal(draft.status, 201);
  assert.equal(draft.data.active, false);
  assert.deepEqual(
    (await call<UserCharacters>('GET', 'account/characters', undefined, alice.cookie)).data.slots,
    { used: 2, limit: 2, remaining: 0 },
  );
  assert.equal(
    (
      await call(
        'POST',
        'account/characters',
        { name: 'Full', personality: 'Test', active: false },
        alice.cookie,
      )
    ).error?.code,
    'CHARACTER_SLOTS_FULL',
  );
  assert.equal(
    (await call('PATCH', 'admin/settings', { defaultCharacterSlots: 1 }, adminCookie)).status,
    200,
  );
  assert.deepEqual(
    (await call<UserCharacters>('GET', 'account/characters', undefined, alice.cookie)).data.slots,
    { used: 2, limit: 1, remaining: 0 },
  );
  assert.equal(
    (
      await call(
        'PATCH',
        `account/characters/${a.data.id}`,
        { description: 'Still editable' },
        alice.cookie,
      )
    ).status,
    200,
  );
  const keptEvents = await events(
    await response(
      'POST',
      `conversations/${conv.data.id}/messages`,
      { content: 'Still active after allowance lower', requestId: id() },
      alice.cookie,
    ),
  );
  assert.ok(keptEvents.some((event) => event.type === 'message'));
  assert.equal(
    (await call('PATCH', `admin/users/${alice.data.id}`, { characterSlots: 4 }, adminCookie))
      .status,
    200,
  );
  updateSettings({ defaultCharacterSlots: 1 });
  assert.equal(
    (await call<UserCharacters>('GET', 'account/characters', undefined, alice.cookie)).data.slots
      .limit,
    4,
  );
  updateSettings({ siteDescription: 'Unrelated update' });
  assert.equal(
    (await call<UserCharacters>('GET', 'account/characters', undefined, alice.cookie)).data.slots
      .limit,
    4,
  );
  const accountingBefore = db.query('SELECT * FROM api_calls ORDER BY id').all();
  const usersBefore = db
    .query('SELECT id,limit_5h,limit_7d,quota_reset_at FROM users ORDER BY id')
    .all();
  updateSettings({ defaultCharacterSlots: 5 });
  assert.ok(
    (db.query('SELECT character_slots FROM users').all() as Row[]).every(
      (row) => row.character_slots === 5,
    ),
  );
  assert.deepEqual(db.query('SELECT * FROM api_calls ORDER BY id').all(), accountingBefore);
  assert.deepEqual(
    db.query('SELECT id,limit_5h,limit_7d,quota_reset_at FROM users ORDER BY id').all(),
    usersBefore,
  );
  assert.equal((await register('NewUser')).data.characterSlots, 5);
  const cli = Bun.spawn(
    [
      Bun.which('bun') || 'bun',
      resolve('scripts/create-admin.ts'),
      '--email',
      'cli@example.test',
      '--name',
      'CLI',
    ],
    {
      cwd: resolve('.'),
      env: { ...process.env, CHATPONY_ADMIN_PASSWORD: 'private-role-cli-password' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [cliOut, cliErr, cliCode] = await Promise.all([
    new Response(cli.stdout).text(),
    new Response(cli.stderr).text(),
    cli.exited,
  ]);
  assert.equal(cliCode, 0, cliOut + cliErr);
  assert.equal(
    (db.query("SELECT character_slots FROM users WHERE email='cli@example.test'").get() as Row)
      .character_slots,
    5,
  );
  for (const value of [-1, 101, 1.5]) {
    assert.equal(
      (await call('PATCH', 'admin/settings', { defaultCharacterSlots: value }, adminCookie)).status,
      400,
    );
    assert.equal(
      (await call('PATCH', `admin/users/${alice.data.id}`, { characterSlots: value }, adminCookie))
        .status,
      400,
    );
  }
  db.exec(
    "CREATE TEMP TRIGGER reject_slots BEFORE UPDATE OF character_slots ON users WHEN NEW.character_slots=6 BEGIN SELECT RAISE(ABORT,'fixture_slot_rollback'); END;",
  );
  assert.throws(() => updateSettings({ defaultCharacterSlots: 6 }));
  db.exec('DROP TRIGGER reject_slots');
  assert.equal(getSettings().defaultCharacterSlots, 5);
  assert.ok(
    (db.query('SELECT character_slots FROM users').all() as Row[]).every(
      (row) => row.character_slots === 5,
    ),
  );

  // Two processes release together to race for the final slot in the same WAL database.
  updateUser(bob.data.id, { characterSlots: 2 });
  const gate = join(directory, 'slot-gate');
  const workers = [0, 1].map((index) => {
    const ready = join(directory, `slot-ready-${index}`);
    return {
      ready,
      child: Bun.spawn(
        [
          Bun.which('bun') || 'bun',
          resolve('tests/fixtures/character-slot-worker.ts'),
          bob.data.id,
          gate,
          ready,
        ],
        { cwd: resolve('.'), env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' },
      ),
    };
  });
  for (let attempt = 0; !workers.every((worker) => existsSync(worker.ready)); attempt++) {
    assert.ok(attempt < 300, 'Concurrent workers did not start');
    await Bun.sleep(10);
  }
  writeFileSync(gate, 'go');
  const outcomes = await Promise.all(
    workers.map(async ({ child }) => {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      assert.equal(code, 0, stderr);
      return stdout.trim();
    }),
  );
  assert.deepEqual(outcomes.sort(), ['created', 'full']);
  assert.equal(
    (await call<UserCharacters>('GET', 'account/characters', undefined, bob.cookie)).data.slots
      .used,
    2,
  );

  const historyBefore = (
    await call<ConversationDetail>('GET', `conversations/${conv.data.id}`, undefined, alice.cookie)
  ).data.messages;
  assert.equal(
    (await call('DELETE', `account/characters/${a.data.id}`, {}, alice.cookie)).status,
    200,
  );
  assert.equal(
    (await call<UserCharacters>('GET', 'account/characters', undefined, alice.cookie)).data.slots
      .used,
    1,
  );
  assert.deepEqual(
    (
      await call<ConversationDetail>(
        'GET',
        `conversations/${conv.data.id}`,
        undefined,
        alice.cookie,
      )
    ).data.messages,
    historyBefore,
  );
  assert.ok(
    existsSync(join(avatarDirectory(), basename(replaced.data.avatar))),
    'Archived history keeps its avatar',
  );
  const archivedAvatarPath = replaced.data.avatar.slice('/api/'.length);
  for (const cookie of ['', bob.cookie, adminCookie])
    assert.equal((await response('GET', archivedAvatarPath, undefined, cookie)).status, 404);
  const archivedAvatar = await response('GET', archivedAvatarPath, undefined, alice.cookie);
  assert.equal(archivedAvatar.status, 200);
  assert.equal(archivedAvatar.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.equal(archivedAvatar.headers.get('vary'), 'Cookie');
  assert.equal(
    (
      await call(
        'POST',
        'conversations',
        { kind: 'private', characterIds: [a.data.id] },
        alice.cookie,
      )
    ).status,
    404,
  );
  const deletedBefore = upstreamCalls;
  const deletedEvents = await events(
    await response(
      'POST',
      `conversations/${conv.data.id}/messages`,
      { content: 'Deleted cannot reply', requestId: id() },
      alice.cookie,
    ),
  );
  assert.ok(
    deletedEvents.some((event) => event.type === 'error' && event.code === 'CHARACTER_UNAVAILABLE'),
  );
  assert.equal(upstreamCalls, deletedBefore);
  const archivedMemories = (
    await call<Memory[]>('GET', 'memories', undefined, alice.cookie)
  ).data.filter((memory) => memory.characterId === a.data.id);
  assert.ok(archivedMemories.length > 0);
  const archivedIdentity = db
    .query('SELECT name,avatar FROM characters WHERE id=?')
    .get(a.data.id) as Row;
  assert.ok(
    archivedMemories.every(
      (memory) =>
        memory.characterName === archivedIdentity.name &&
        memory.characterAvatar === archivedIdentity.avatar,
    ),
  );
  const remainingGroupBefore = upstreamCalls;
  const remainingGroup = await events(
    await response(
      'POST',
      `conversations/${group.data.id}/messages`,
      {
        content: `@${a.data.slug} @${publicRole.slug} Continue with the available member`,
        requestId: id(),
      },
      alice.cookie,
    ),
  );
  assert.equal(
    upstreamCalls,
    remainingGroupBefore + 1,
    'A deleted mention must not block an available member',
  );
  assert.ok(!remainingGroup.some((event) => event.type === 'error'));
  assert.equal(
    (
      await call(
        'PATCH',
        `account/characters/${a.data.id}`,
        { name: 'Restore forbidden' },
        alice.cookie,
      )
    ).status,
    404,
  );
  assert.equal((await call('GET', 'account/characters', undefined, bob.cookie)).status, 200);
  assert.deepEqual(db.query('PRAGMA foreign_key_check').all(), []);
  closeDb();
  db = getDb();
  assert.equal(
    (db.query('SELECT owner_id FROM characters WHERE id=?').get(b.data.id) as Row).owner_id,
    bob.data.id,
  );
  assert.equal(
    (db.query('SELECT character_slots FROM users WHERE id=?').get(bob.data.id) as Row)
      .character_slots,
    2,
  );
  console.log('Private character check passed');
} finally {
  server.stop(true);
  closeDb();
}
