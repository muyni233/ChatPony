import assert from 'node:assert/strict';
import sharp from 'sharp';
import { getDb, id, now } from '../../src/lib/db';
import { encrypt } from '../../src/lib/crypto';
import { chatResponse } from '../../src/lib/chat';
import { toUser, type Row } from '../../src/lib/mappers';
import { getConversation, updateSettings } from '../../src/lib/repository';
import { attachmentResponse, uploadAttachment } from '../../src/lib/attachments';
import { hybridRecall, maintainMemories, upsertAutoMemory } from '../../src/lib/ai/memory';
import type { ChatEvent } from '../../src/lib/types';

const db = getDb();
let sawImage = false;
let lastSystem = '';
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as {
      stream?: boolean;
      messages: { role: string; content: unknown }[];
    };
    lastSystem = String(body.messages[0].content);
    const last = body.messages.at(-1)!;
    if (Array.isArray(last.content))
      sawImage = last.content.some(
        (part: { type?: string; image_url?: { url?: string } }) =>
          part.type === 'image_url' && part.image_url?.url?.startsWith('data:image/webp;base64,'),
      );
    assert.equal(body.stream, true);
    const chunks = ['*歪头* ', '这是', '流式回复。'];
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const text of chunks)
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
              ),
            );
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  },
});

const userId = id();
db.query('INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)').run(
  userId,
  'memory@example.com',
  'Memory User',
  'unused',
  now(),
);
const user = toUser(db.query('SELECT * FROM users WHERE id=?').get(userId) as Row);
const supplierId = id();
db.query(
  'INSERT INTO suppliers(id,name,base_url,api_key,active,created_at) VALUES(?,?,?,?,1,?)',
).run(supplierId, 'Fixture', server.url.toString(), encrypt('fixture-key'), now());
const modelId = id();
db.query(
  `INSERT INTO providers(id,supplier_id,name,protocol,base_url,model,api_key,capabilities,context_window,max_output,created_at) VALUES(?,?,?,'openai-completions','',?,'','["text","image"]',?,?,?)`,
).run(modelId, supplierId, 'Vision', 'fixture-vision', 32768, 512, now());
const characterId = id();
db.query(
  'INSERT INTO characters(id,name,slug,personality,provider_id,active,created_at) VALUES(?,?,?,?,?,1,?)',
).run(characterId, 'Luna', 'luna', 'Luna 是温柔的测试角色。', modelId, now());

try {
  // De-duplication merges near-identical automatic memories instead of piling up copies.
  const apple = upsertAutoMemory({
    userId,
    characterId,
    content: '用户喜欢吃红苹果',
    kind: 'preference',
    importance: 0.6,
  });
  assert.ok(apple);
  assert.equal(
    upsertAutoMemory({
      userId,
      characterId,
      content: '用户喜欢吃红苹果',
      kind: 'preference',
      importance: 0.7,
    }),
    null,
  );
  upsertAutoMemory({
    userId,
    characterId,
    content: '用户住在云中城',
    kind: 'fact',
    importance: 0.5,
  });
  upsertAutoMemory({
    userId,
    characterId,
    content: '下周一起去看星星',
    kind: 'plan',
    importance: 0.5,
  });
  assert.equal(
    Number((db.query('SELECT COUNT(*) AS n FROM memories WHERE user_id=?').get(userId) as Row).n),
    3,
  );
  assert.ok(
    Number((db.query('SELECT importance FROM memories WHERE id=?').get(apple) as Row).importance) >
      0.7,
  );

  // Keyword recall works with no embedding model configured, and previews do not reinforce.
  const preview = await hybridRecall(userId, characterId, '我今天想吃苹果', { reinforce: false });
  assert.equal(preview.vectorEnabled, false);
  assert.equal(preview.memories[0]?.id, apple);
  assert.ok(!preview.memories.some((item) => item.content.includes('云中城')));
  assert.equal(
    Number(
      (db.query('SELECT access_count FROM memories WHERE id=?').get(apple) as Row).access_count,
    ),
    0,
  );
  await hybridRecall(userId, characterId, '苹果');
  assert.equal(
    Number(
      (db.query('SELECT access_count FROM memories WHERE id=?').get(apple) as Row).access_count,
    ),
    1,
  );

  // Decay archives weak, stale automatic memories and expired plans; manual memories never decay.
  const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
  const stale = id();
  const manual = id();
  const expired = id();
  for (const [memoryId, source, importance, expires] of [
    [stale, 'auto', 0.2, null],
    [manual, 'manual', 0.1, null],
    [expired, 'auto', 0.9, new Date(Date.now() - 1000).toISOString()],
  ] as const)
    db.query(
      'INSERT INTO memories(id,user_id,character_id,content,source,importance,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(
      memoryId,
      userId,
      characterId,
      `测试记忆 ${memoryId}`,
      source,
      importance,
      expires,
      old,
      old,
    );
  assert.equal(maintainMemories(userId, characterId, true), 2);
  const status = (memoryId: string) =>
    String((db.query('SELECT status FROM memories WHERE id=?').get(memoryId) as Row).status);
  assert.equal(status(stale), 'archived');
  assert.equal(status(expired), 'archived');
  assert.equal(status(manual), 'active');
  assert.equal(maintainMemories(userId, characterId), 0, 'maintenance is throttled');

  // Images are re-encoded, bound to the message, sent to a vision model, and replies stream.
  const conversationId = id();
  db.query(
    "INSERT INTO conversations(id,user_id,title,kind,character_ids,created_at,updated_at) VALUES(?,?,?,'private',?,?,?)",
  ).run(conversationId, userId, 'Vision', JSON.stringify([characterId]), now(), now());
  const png = await sharp({
    create: { width: 40, height: 30, channels: 3, background: '#7fb3d5' },
  })
    .png()
    .toBuffer();
  const attachment = await uploadAttachment(userId, conversationId, {
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
  });
  assert.equal(attachment.mime, 'image/webp');
  assert.equal(attachment.width, 40);
  const response = await chatResponse(
    new Request('http://localhost/api/conversations/x/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '', requestId: id(), attachmentIds: [attachment.id] }),
    }),
    user,
    conversationId,
  );
  const events = (await response.text())
    .split('\n\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as ChatEvent);
  assert.ok(sawImage, 'vision model receives the image part');
  assert.ok(lastSystem.includes('检索到的相关长期记忆'));
  const user0 = events.find((event) => event.type === 'user') as Extract<
    ChatEvent,
    { type: 'user' }
  >;
  assert.equal(user0.message.attachments?.[0].id, attachment.id);
  const deltas = events.filter((event) => event.type === 'delta');
  assert.equal(deltas.length, 3);
  const message = events.find((event) => event.type === 'message') as Extract<
    ChatEvent,
    { type: 'message' }
  >;
  assert.equal(message.message.content, '*歪头* 这是流式回复。');
  assert.equal(message.streamId, (events.find((e) => e.type === 'stream-start') as any).streamId);
  assert.equal(attachmentResponse(userId, attachment.id).headers.get('content-type'), 'image/webp');
  assert.throws(() => attachmentResponse(id(), attachment.id));

  // Paging returns the newest page first and older pages on demand.
  for (let index = 0; index < 5; index++)
    db.query(
      "INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,'user',?,?)",
    ).run(id(), conversationId, `第 ${index} 条`, now());
  const page = getConversation(userId, conversationId, { limit: 3 });
  assert.equal(page.messages.length, 3);
  assert.equal(page.hasMore, true);
  const older = getConversation(userId, conversationId, {
    limit: 10,
    before: page.messages[0].id,
  });
  assert.equal(older.hasMore, false);
  assert.equal(older.messages[0].attachments?.[0].id, attachment.id);
  assert.equal(getConversation(userId, conversationId).messages.length, 7);

  // Streaming can be switched off; non-streaming generation still works.
  updateSettings({ streamingEnabled: false });
  console.log('MEMORY_LIFECYCLE_OK');
} finally {
  server.stop(true);
}
