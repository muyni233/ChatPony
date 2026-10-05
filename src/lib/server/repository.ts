import { randomUUID } from 'node:crypto';
import type { Character, Conversation, Memory, Message, Provider, User } from '@/lib/types';
import { getDb, now, transaction } from './db';
import { HttpError, json, readBody, textField } from './http';
import { decryptSecret } from './secrets';
import { getSettings } from './settings';
import { hasAmbiguousCharacterNames } from './mentions';

export type CharacterRow = {
  id: string;
  name: string;
  english_name: string;
  subtitle: string;
  description: string;
  personality: string;
  greeting: string;
  color: string;
  avatar: string;
  tags: string;
  published: number;
  sort_order: number;
};
export type ProviderRow = {
  id: string;
  name: string;
  protocol: Provider['protocol'];
  base_url: string;
  model: string;
  context_window: number;
  max_output_tokens: number;
  temperature: number;
  enabled: number;
  is_default: number;
  api_key_cipher: string;
};
export type ConversationRow = {
  id: string;
  user_id: string;
  title: string;
  kind: 'direct' | 'group';
  character_ids: string;
  scene: string;
  provider_id: string | null;
  summary: string;
  summary_message_id: string | null;
  created_at: string;
  updated_at: string;
  last_message?: string | null;
  last_message_role?: 'user' | 'assistant' | null;
};
export type MessageRow = {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  character_id: string | null;
  content: string;
  created_at: string;
};
type MemoryRow = {
  id: string;
  character_id: string;
  content: string;
  created_at: string;
  updated_at: string;
};

export function toCharacter(row: CharacterRow): Character {
  return {
    id: row.id,
    name: row.name,
    englishName: row.english_name,
    subtitle: row.subtitle,
    description: row.description,
    personality: row.personality,
    greeting: row.greeting,
    color: row.color,
    avatar: row.avatar,
    tags: JSON.parse(row.tags),
    published: !!row.published,
    order: row.sort_order,
  };
}
export function toProvider(row: ProviderRow, publicView = false): Provider {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    baseUrl: publicView ? '' : row.base_url,
    model: row.model,
    contextWindow: row.context_window,
    maxOutputTokens: row.max_output_tokens,
    temperature: row.temperature,
    enabled: !!row.enabled,
    isDefault: !!row.is_default,
    hasApiKey: publicView ? false : !!row.api_key_cipher,
  };
}
export function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    characterIds: JSON.parse(row.character_ids),
    scene: row.scene,
    providerId: row.provider_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessage: row.last_message ?? undefined,
    lastMessageRole: row.last_message_role ?? undefined,
    summary: row.summary,
  };
}
export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    characterId: row.character_id,
    content: row.content,
    createdAt: row.created_at,
  };
}
export function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    characterId: row.character_id,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function characters(all = false) {
  return (
    getDb()
      .prepare(
        `SELECT * FROM characters ${all ? '' : 'WHERE published=1'} ORDER BY sort_order, name`,
      )
      .all() as CharacterRow[]
  ).map(toCharacter);
}

export function requireCharacter(id: string, published = true): Character {
  const row = getDb()
    .prepare(`SELECT * FROM characters WHERE id=? ${published ? 'AND published=1' : ''}`)
    .get(id) as CharacterRow | undefined;
  if (!row) throw new HttpError(404, '该角色暂未发布或已经移除。', 'CHARACTER_NOT_FOUND');
  return toCharacter(row);
}

export function providers(publicView = true): Provider[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM providers ${publicView ? 'WHERE enabled=1' : ''} ORDER BY is_default DESC, name`,
      )
      .all() as ProviderRow[]
  ).map((row) => toProvider(row, publicView));
}

export function selectProvider(id: string | null) {
  const row = (
    id
      ? getDb().prepare('SELECT * FROM providers WHERE id=? AND enabled=1').get(id)
      : getDb()
          .prepare(
            'SELECT * FROM providers WHERE enabled=1 ORDER BY is_default DESC, rowid LIMIT 1',
          )
          .get()
  ) as ProviderRow | undefined;
  if (!row) return null;
  return {
    ...toProvider(row),
    apiKey: decryptSecret(row.api_key_cipher),
    allowPrivateUrls: getSettings().allowPrivateApiUrls,
  };
}

export function ownedConversation(userId: string, id: string): ConversationRow {
  const row = getDb()
    .prepare('SELECT * FROM conversations WHERE id=? AND user_id=?')
    .get(id, userId) as ConversationRow | undefined;
  if (!row) throw new HttpError(404, '会话不存在。', 'CONVERSATION_NOT_FOUND');
  return row;
}

export function conversationMessages(id: string): Message[] {
  return (
    getDb()
      .prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY rowid')
      .all(id) as MessageRow[]
  ).map(toMessage);
}

function validProvider(value: unknown, fallback: string | null = null) {
  const id = value === undefined ? fallback : value === null || value === '' ? null : value;
  if (
    id !== null &&
    (typeof id !== 'string' ||
      !getDb().prepare('SELECT id FROM providers WHERE id=? AND enabled=1').get(id))
  )
    throw new HttpError(400, '请选择可用的模型服务。', 'INVALID_PROVIDER');
  return id as string | null;
}

export function listConversations(user: User) {
  const rows = getDb()
    .prepare(
      `SELECT c.*, (SELECT content FROM messages WHERE conversation_id=c.id ORDER BY rowid DESC LIMIT 1) AS last_message,
    (SELECT role FROM messages WHERE conversation_id=c.id ORDER BY rowid DESC LIMIT 1) AS last_message_role
    FROM conversations c WHERE user_id=? ORDER BY updated_at DESC LIMIT 1000`,
    )
    .all(user.id) as ConversationRow[];
  return json({ conversations: rows.map(toConversation) });
}

export async function createConversation(request: Request, user: User) {
  const body = await readBody(request);
  const kind = body.kind === undefined ? 'direct' : body.kind;
  if (kind !== 'direct' && kind !== 'group')
    throw new HttpError(400, '请选择私聊或群聊。', 'INVALID_KIND');
  const ids = body.characterIds;
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== 'string') ||
    new Set(ids).size !== ids.length ||
    (kind === 'direct' ? ids.length !== 1 : ids.length < 2 || ids.length > 6)
  )
    throw new HttpError(
      400,
      kind === 'direct' ? '私聊需要选择一个角色。' : '群聊需要选择 2–6 个不同角色。',
      'INVALID_CHARACTERS',
    );
  const selected = ids.map((id) => requireCharacter(id));
  if (kind === 'group' && hasAmbiguousCharacterNames(selected))
    throw new HttpError(
      400,
      '群聊中的角色名称需要互不相同，请联系管理员调整名称后重试。',
      'AMBIGUOUS_CHARACTER_NAMES',
    );
  const total = getDb()
    .prepare('SELECT COUNT(*) AS n FROM conversations WHERE user_id=?')
    .get(user.id) as { n: number };
  if (total.n >= getSettings().maxConversationsPerUser)
    throw new HttpError(409, '会话数量已达上限，请删除不再需要的会话。', 'RESOURCE_LIMIT');
  const id = randomUUID();
  const title = textField(
    body,
    'title',
    80,
    1,
    kind === 'direct'
      ? selected[0].name
      : selected
          .map((character) => character.name)
          .join('、')
          .slice(0, 70),
  );
  const scene = textField(body, 'scene', 4000, 0, '');
  const providerId = validProvider(body.providerId);
  const timestamp = now();
  const greeting = kind === 'direct' && selected[0].greeting.trim() ? selected[0].greeting : '';
  transaction(() => {
    getDb()
      .prepare(
        'INSERT INTO conversations(id,user_id,title,kind,character_ids,scene,provider_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(id, user.id, title, kind, JSON.stringify(ids), scene, providerId, timestamp, timestamp);
    if (greeting)
      getDb()
        .prepare(
          'INSERT INTO messages(id,conversation_id,role,character_id,content,created_at) VALUES (?,?,?,?,?,?)',
        )
        .run(randomUUID(), id, 'assistant', selected[0].id, greeting, timestamp);
  });
  return json(
    {
      conversation: toConversation({
        ...ownedConversation(user.id, id),
        last_message: greeting || undefined,
        last_message_role: greeting ? 'assistant' : undefined,
      }),
    },
    201,
  );
}

export function getConversation(user: User, id: string) {
  const row = ownedConversation(user.id, id);
  const all = characters(true);
  const ids = JSON.parse(row.character_ids) as string[];
  return json({
    conversation: toConversation(row),
    messages: conversationMessages(id),
    characters: all.filter((character) => ids.includes(character.id)),
  });
}

export function assertNotGenerating(id: string) {
  if (
    getDb()
      .prepare(
        'SELECT conversation_id FROM generation_locks WHERE conversation_id=? AND expires_at>?',
      )
      .get(id, Date.now())
  )
    throw new HttpError(409, '此会话正在回复，请等待完成或停止生成。', 'GENERATION_IN_PROGRESS');
}

export async function updateConversation(request: Request, user: User, id: string) {
  const body = await readBody(request);
  const row = ownedConversation(user.id, id);
  assertNotGenerating(id);
  const title = textField(body, 'title', 80, 1, row.title);
  const scene = textField(body, 'scene', 4000, 0, row.scene);
  const providerId = validProvider(body.providerId, row.provider_id);
  getDb()
    .prepare(
      'UPDATE conversations SET title=?,scene=?,provider_id=?,updated_at=? WHERE id=? AND user_id=?',
    )
    .run(title, scene, providerId, now(), id, user.id);
  return json({ conversation: toConversation(ownedConversation(user.id, id)) });
}

export function deleteConversation(user: User, id: string) {
  ownedConversation(user.id, id);
  assertNotGenerating(id);
  getDb().prepare('DELETE FROM conversations WHERE id=? AND user_id=?').run(id, user.id);
  return json({ ok: true });
}

export function listMemories(user: User, characterId?: string | null) {
  const rows = (
    characterId
      ? getDb()
          .prepare(
            'SELECT * FROM memories WHERE user_id=? AND character_id=? ORDER BY created_at DESC',
          )
          .all(user.id, characterId)
      : getDb()
          .prepare('SELECT * FROM memories WHERE user_id=? ORDER BY created_at DESC LIMIT 2000')
          .all(user.id)
  ) as MemoryRow[];
  return json({ memories: rows.map(toMemory) });
}

export function memoryText(userId: string, characterId: string) {
  // New and recently edited memories take precedence when the model's context
  // budget can include only part of a large memory collection.
  const rows = getDb()
    .prepare(
      'SELECT content FROM memories WHERE user_id=? AND character_id=? ORDER BY updated_at DESC,rowid DESC',
    )
    .all(userId, characterId) as { content: string }[];
  return rows.map((row, index) => `${index + 1}. ${row.content}`).join('\n');
}

export async function createMemory(request: Request, user: User) {
  const body = await readBody(request);
  const characterId = textField(body, 'characterId', 100, 1);
  requireCharacter(characterId);
  const content = textField(body, 'content', 2000, 1);
  const total = getDb()
    .prepare('SELECT COUNT(*) AS n FROM memories WHERE user_id=? AND character_id=?')
    .get(user.id, characterId) as { n: number };
  if (total.n >= 50)
    throw new HttpError(409, '此角色最多保存 50 条记忆，请整理后再添加。', 'RESOURCE_LIMIT');
  const id = randomUUID(),
    timestamp = now();
  getDb()
    .prepare(
      'INSERT INTO memories(id,user_id,character_id,content,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    )
    .run(id, user.id, characterId, content, timestamp, timestamp);
  return json(
    { memory: { id, characterId, content, createdAt: timestamp, updatedAt: timestamp } },
    201,
  );
}

export async function changeMemory(request: Request, user: User, id: string) {
  const row = getDb()
    .prepare('SELECT * FROM memories WHERE id=? AND user_id=?')
    .get(id, user.id) as MemoryRow | undefined;
  if (!row) throw new HttpError(404, '记忆不存在。', 'MEMORY_NOT_FOUND');
  if (request.method === 'DELETE') {
    getDb().prepare('DELETE FROM memories WHERE id=? AND user_id=?').run(id, user.id);
    return json({ ok: true });
  }
  const body = await readBody(request),
    content = textField(body, 'content', 2000, 1),
    timestamp = now();
  getDb()
    .prepare('UPDATE memories SET content=?,updated_at=? WHERE id=? AND user_id=?')
    .run(content, timestamp, id, user.id);
  return json({ memory: { ...toMemory(row), content, updatedAt: timestamp } });
}

export async function favorites(request: Request, user: User, id?: string) {
  if (request.method === 'GET') {
    const rows = getDb()
      .prepare(
        'SELECT f.character_id FROM favorites f JOIN characters c ON c.id=f.character_id WHERE user_id=? AND c.published=1',
      )
      .all(user.id) as { character_id: string }[];
    return json({ characterIds: rows.map((row) => row.character_id) });
  }
  const characterId = id || textField(await readBody(request), 'characterId', 100, 1);
  if (request.method === 'DELETE')
    getDb()
      .prepare('DELETE FROM favorites WHERE user_id=? AND character_id=?')
      .run(user.id, characterId);
  else {
    requireCharacter(characterId);
    getDb()
      .prepare('INSERT OR IGNORE INTO favorites(user_id,character_id) VALUES (?,?)')
      .run(user.id, characterId);
  }
  return json({ ok: true });
}
