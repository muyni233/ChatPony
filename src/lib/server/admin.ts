import { randomUUID } from 'node:crypto';
import type { Character, Provider, User } from '@/lib/types';
import { completeText, validateProviderUrl } from '@/lib/ai';
import { getDb, transaction } from './db';
import { booleanField, HttpError, json, numberField, rateLimit, readBody, textField } from './http';
import { encryptSecret } from './secrets';
import { getSettings } from './settings';
import { requireAdmin } from './auth';
import {
  characters,
  type CharacterRow,
  type ProviderRow,
  providers,
  selectProvider,
  toCharacter,
  toProvider,
} from './repository';

function characterData(body: Record<string, unknown>, existing?: Character) {
  const tags = body.tags === undefined ? existing?.tags || [] : body.tags;
  if (
    !Array.isArray(tags) ||
    tags.length > 8 ||
    tags.some((tag) => typeof tag !== 'string' || tag.length > 24 || !tag.trim())
  )
    throw new HttpError(400, '最多添加 8 个标签，每个不超过 24 字符。', 'INVALID_TAGS');
  const color = textField(body, 'color', 7, 4, existing?.color || '#84749a');
  if (!/^#[0-9a-f]{6}$/i.test(color))
    throw new HttpError(400, '主题颜色需要使用六位十六进制色值。', 'INVALID_COLOR');
  const avatar = textField(body, 'avatar', 500, 0, existing?.avatar || '');
  if (avatar && (!/^\/(?!\/)[a-zA-Z0-9/_.,%-]+$/.test(avatar) || avatar.includes('..')))
    throw new HttpError(
      400,
      '头像请使用站内静态资源路径，如 /avatars/character.png；也可留空。',
      'INVALID_AVATAR',
    );
  const name = textField(body, 'name', 60, 1, existing?.name);
  if (/[@\u0000-\u001f\u007f]/.test(name))
    throw new HttpError(
      400,
      '角色名称不能包含 @ 或控制字符，以便在群聊中明确提及角色。',
      'INVALID_CHARACTER_NAME',
    );
  return {
    name,
    englishName: textField(body, 'englishName', 80, 0, existing?.englishName || ''),
    subtitle: textField(body, 'subtitle', 120, 0, existing?.subtitle || ''),
    description: textField(body, 'description', 3000, 0, existing?.description || ''),
    personality: textField(body, 'personality', 16000, 1, existing?.personality),
    greeting: textField(body, 'greeting', 3000, 0, existing?.greeting || ''),
    color,
    avatar,
    tags: tags.map((tag) => (tag as string).trim()),
    published: booleanField(body, 'published', existing?.published || false),
    order: numberField(body, 'order', -10000, 10000, existing?.order || 0, true),
  };
}

export async function adminCharacters(request: Request, id?: string) {
  if (request.method === 'GET') return json({ characters: characters(true) });
  const body = request.method === 'DELETE' ? {} : await readBody(request);
  requireAdmin(request);
  const db = getDb();
  const row = id
    ? (db.prepare('SELECT * FROM characters WHERE id=?').get(id) as CharacterRow | undefined)
    : undefined;
  if (id && !row) throw new HttpError(404, '角色不存在。', 'CHARACTER_NOT_FOUND');
  if (request.method === 'DELETE') {
    // Preserve conversation integrity. A character can be unpublished when it has history.
    const inUse = db
      .prepare(
        'SELECT c.id FROM conversations c, json_each(c.character_ids) j WHERE j.value=? LIMIT 1',
      )
      .get(id!);
    if (inUse)
      throw new HttpError(
        409,
        '此角色已有会话，请改为取消发布以保留历史记录。',
        'CHARACTER_IN_USE',
      );
    db.prepare('DELETE FROM characters WHERE id=?').run(id!);
    return json({ ok: true });
  }
  if (!id && (db.prepare('SELECT COUNT(*) AS n FROM characters').get() as { n: number }).n >= 500)
    throw new HttpError(409, '角色数量已达上限。', 'RESOURCE_LIMIT');
  const data = characterData(body, row ? toCharacter(row) : undefined);
  const characterId = id || randomUUID();
  if (id)
    db.prepare(
      'UPDATE characters SET name=?,english_name=?,subtitle=?,description=?,personality=?,greeting=?,color=?,avatar=?,tags=?,published=?,sort_order=? WHERE id=?',
    ).run(
      data.name,
      data.englishName,
      data.subtitle,
      data.description,
      data.personality,
      data.greeting,
      data.color,
      data.avatar,
      JSON.stringify(data.tags),
      Number(data.published),
      data.order,
      characterId,
    );
  else
    db.prepare(
      'INSERT INTO characters(id,name,english_name,subtitle,description,personality,greeting,color,avatar,tags,published,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      characterId,
      data.name,
      data.englishName,
      data.subtitle,
      data.description,
      data.personality,
      data.greeting,
      data.color,
      data.avatar,
      JSON.stringify(data.tags),
      Number(data.published),
      data.order,
    );
  return json({ character: { id: characterId, ...data } }, id ? 200 : 201);
}

export async function adminProviders(request: Request, id?: string) {
  if (request.method === 'GET') return json({ providers: providers(false) });
  const body = request.method === 'DELETE' ? {} : await readBody(request);
  requireAdmin(request);
  const db = getDb();
  const row = id
    ? (db.prepare('SELECT * FROM providers WHERE id=?').get(id) as ProviderRow | undefined)
    : undefined;
  if (id && !row) throw new HttpError(404, '模型服务不存在。', 'PROVIDER_NOT_FOUND');
  if (request.method === 'DELETE') {
    db.prepare('DELETE FROM providers WHERE id=?').run(id!);
    return json({ ok: true });
  }
  if (!id && (db.prepare('SELECT COUNT(*) AS n FROM providers').get() as { n: number }).n >= 30)
    throw new HttpError(409, '最多配置 30 个模型服务。', 'RESOURCE_LIMIT');
  const previous = row ? toProvider(row) : undefined;
  const protocol = body.protocol === undefined ? previous?.protocol : body.protocol;
  if (!['anthropic', 'openai-chat', 'openai-responses', 'gemini'].includes(protocol as string))
    throw new HttpError(400, '请选择支持的 API 协议。', 'INVALID_PROTOCOL');
  const baseUrl = textField(body, 'baseUrl', 1000, 1, previous?.baseUrl);
  try {
    validateProviderUrl(baseUrl, { allowPrivateUrls: getSettings().allowPrivateApiUrls });
  } catch {
    throw new HttpError(
      400,
      'API 地址无效；如需内网服务，请先在站点设置中允许私网 API 地址。',
      'INVALID_PROVIDER_URL',
    );
  }
  const data = {
    name: textField(body, 'name', 80, 1, previous?.name),
    protocol: protocol as Provider['protocol'],
    baseUrl,
    model: textField(body, 'model', 160, 1, previous?.model),
    contextWindow: numberField(
      body,
      'contextWindow',
      2048,
      2000000,
      previous?.contextWindow || 32768,
      true,
    ),
    maxOutputTokens: numberField(
      body,
      'maxOutputTokens',
      64,
      65536,
      previous?.maxOutputTokens || 2048,
      true,
    ),
    temperature: numberField(body, 'temperature', 0, 2, previous?.temperature ?? 0.8),
    enabled: booleanField(body, 'enabled', previous?.enabled ?? true),
    isDefault: booleanField(body, 'isDefault', previous?.isDefault ?? false),
  };
  if (data.maxOutputTokens >= data.contextWindow / 2)
    throw new HttpError(
      400,
      '回复长度应小于上下文窗口的一半，以保留足够的对话空间。',
      'INVALID_TOKEN_BUDGET',
    );
  if (data.isDefault && !data.enabled)
    throw new HttpError(400, '默认模型服务必须启用。', 'INVALID_DEFAULT_PROVIDER');
  const apiKey =
    body.apiKey === undefined || body.apiKey === ''
      ? row?.api_key_cipher || ''
      : encryptSecret(textField(body, 'apiKey', 4096, 1));
  const providerId = id || randomUUID();
  transaction(() => {
    if (data.isDefault) db.prepare('UPDATE providers SET is_default=0').run();
    if (id)
      db.prepare(
        'UPDATE providers SET name=?,protocol=?,base_url=?,model=?,context_window=?,max_output_tokens=?,temperature=?,enabled=?,is_default=?,api_key_cipher=? WHERE id=?',
      ).run(
        data.name,
        data.protocol,
        data.baseUrl,
        data.model,
        data.contextWindow,
        data.maxOutputTokens,
        data.temperature,
        Number(data.enabled),
        Number(data.isDefault),
        apiKey,
        providerId,
      );
    else
      db.prepare(
        'INSERT INTO providers(id,name,protocol,base_url,model,context_window,max_output_tokens,temperature,enabled,is_default,api_key_cipher) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        providerId,
        data.name,
        data.protocol,
        data.baseUrl,
        data.model,
        data.contextWindow,
        data.maxOutputTokens,
        data.temperature,
        Number(data.enabled),
        Number(data.isDefault),
        apiKey,
      );
  });
  return json({ provider: { id: providerId, ...data, hasApiKey: !!apiKey } }, id ? 200 : 201);
}

export async function testProvider(request: Request, user: User, id: string) {
  rateLimit(`provider-test:${user.id}`, 10, 60000);
  const provider = selectProvider(id);
  if (!provider) throw new HttpError(404, '请先启用并保存此模型服务。', 'PROVIDER_NOT_FOUND');
  try {
    const output = await completeText(
      provider,
      {
        system: 'You are a connection test. Reply only OK.',
        messages: [{ role: 'user', content: 'Reply OK.' }],
        maxTokens: Math.min(provider.maxOutputTokens, 1024),
      },
      AbortSignal.any([request.signal, AbortSignal.timeout(45000)]),
    );
    if (!output.trim()) throw new Error();
    return json({ ok: true, message: '连接成功，模型已返回有效内容。' });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && 'message' in error)
      throw new HttpError(502, String(error.message), String(error.code));
    throw new HttpError(502, '连接测试失败，请检查地址、模型名称及密钥。', 'PROVIDER_TEST_FAILED');
  }
}

export async function adminUsers(request: Request, user: User, id?: string) {
  const db = getDb();
  const columns =
    'id,username,email,role,disabled,email_verified,quota_5h,quota_1d,quota_7d,quota_5h_enabled,quota_1d_enabled,quota_7d_enabled,created_at';
  const transform = (row: Record<string, unknown>) => ({
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    disabled: !!row.disabled,
    emailVerified: !!row.email_verified,
    quota5h: row.quota_5h,
    quota1d: row.quota_1d,
    quota7d: row.quota_7d,
    quota5hEnabled: nullableBoolean(row.quota_5h_enabled),
    quota1dEnabled: nullableBoolean(row.quota_1d_enabled),
    quota7dEnabled: nullableBoolean(row.quota_7d_enabled),
    createdAt: row.created_at,
  });
  if (request.method === 'GET') {
    const params = new URL(request.url).searchParams;
    const query = (params.get('query') || '').trim();
    if (query.length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(query))
      throw new HttpError(400, '用户检索最多 100 个普通字符。', 'INVALID_USER_FILTER');
    const integer = (field: string, fallback: number, maximum: number) => {
      const value = params.get(field);
      if (value === null || value === '') return fallback;
      if (
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) < 1 ||
        Number(value) > maximum
      )
        throw new HttpError(
          400,
          `用户分页 ${field} 必须是 1–${maximum} 之间的整数。`,
          'INVALID_USER_FILTER',
        );
      return Number(value);
    };
    const requestedPage = integer('page', 1, 1000000),
      pageSize = integer('pageSize', 50, 100);
    const where = query
      ? " WHERE username LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\'"
      : '';
    const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`,
      bindings = query ? [pattern, pattern, pattern] : [];
    return transaction(() => {
      requireAdmin(request);
      const total = (
        db.prepare(`SELECT COUNT(*) AS n FROM users${where}`).get(...bindings) as { n: number }
      ).n;
      const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
      const users = db
        .prepare(
          `SELECT ${columns} FROM users${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,
        )
        .all(...bindings, pageSize, (page - 1) * pageSize)
        .map(transform);
      return json({ users, total, page, pageSize });
    });
  }
  const body = await readBody(request);
  requireAdmin(request);
  const updated = transaction(() => {
    if (!db.prepare("SELECT id FROM users WHERE id=? AND role='admin' AND disabled=0").get(user.id))
      throw new HttpError(403, '管理员权限已经变更，请刷新后重试。', 'FORBIDDEN');
    const row = db.prepare(`SELECT ${columns} FROM users WHERE id=?`).get(id!) as
      Record<string, unknown> | undefined;
    if (!row) throw new HttpError(404, '用户不存在。', 'USER_NOT_FOUND');
    const disabled = booleanField(body, 'disabled', !!row.disabled),
      role = body.role === undefined ? row.role : body.role;
    const quota5h = quotaOverride(body, 'quota5h', row.quota_5h as number | null),
      quota1d = quotaOverride(body, 'quota1d', row.quota_1d as number | null),
      quota7d = quotaOverride(body, 'quota7d', row.quota_7d as number | null);
    const quota5hEnabled = quotaEnabledOverride(body, 'quota5hEnabled', row.quota_5h_enabled),
      quota1dEnabled = quotaEnabledOverride(body, 'quota1dEnabled', row.quota_1d_enabled),
      quota7dEnabled = quotaEnabledOverride(body, 'quota7dEnabled', row.quota_7d_enabled);
    if (role !== 'user' && role !== 'admin')
      throw new HttpError(400, '用户权限无效。', 'INVALID_ROLE');
    if (id === user.id && (disabled || role !== 'admin'))
      throw new HttpError(409, '不能停用自己或移除自己的管理员权限。', 'SELF_DEMOTION');
    if (row.role === 'admin' && (disabled || role !== 'admin')) {
      const active = db
        .prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0")
        .get() as { n: number };
      if (active.n <= 1) throw new HttpError(409, '至少需要保留一位可用的管理员。', 'LAST_ADMIN');
    }
    db.prepare(
      'UPDATE users SET disabled=?,role=?,quota_5h=?,quota_1d=?,quota_7d=?,quota_5h_enabled=?,quota_1d_enabled=?,quota_7d_enabled=? WHERE id=?',
    ).run(
      Number(disabled),
      role,
      quota5h,
      quota1d,
      quota7d,
      quota5hEnabled,
      quota1dEnabled,
      quota7dEnabled,
      id!,
    );
    if (disabled || role !== row.role) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id!);
    return transform({
      ...row,
      disabled,
      role,
      quota_5h: quota5h,
      quota_1d: quota1d,
      quota_7d: quota7d,
      quota_5h_enabled: quota5hEnabled,
      quota_1d_enabled: quota1dEnabled,
      quota_7d_enabled: quota7dEnabled,
    });
  });
  return json({ user: updated });
}

function quotaOverride(body: Record<string, unknown>, field: string, fallback: number | null) {
  if (body[field] === undefined) return fallback;
  if (body[field] === null) return null;
  return numberField(body, field, 0, 1000000, 0, true);
}

function nullableBoolean(value: unknown) {
  return value === null ? null : !!value;
}

function quotaEnabledOverride(
  body: Record<string, unknown>,
  field: string,
  fallback: unknown,
): number | null {
  if (body[field] === undefined) return fallback as number | null;
  if (body[field] === null) return null;
  return Number(booleanField(body, field, false));
}

export async function adminResetQuotas(request: Request) {
  const body = await readBody(request);
  const scope = body.scope,
    window = body.window;
  if (scope !== 'all' && scope !== 'user')
    throw new HttpError(400, '请选择重置全部用户或指定用户。', 'INVALID_QUOTA_RESET');
  if (window !== 'all' && window !== '5h' && window !== '1d' && window !== '7d')
    throw new HttpError(400, '请选择 5 小时、1 天、7 天或全部额度窗口。', 'INVALID_QUOTA_RESET');
  const userId = scope === 'user' ? textField(body, 'userId', 100, 1) : null;
  if (scope === 'all' && body.userId !== undefined && body.userId !== null && body.userId !== '')
    throw new HttpError(400, '重置所有用户时无需指定用户 ID。', 'INVALID_QUOTA_RESET');
  const windows = window === 'all' ? (['5h', '1d', '7d'] as const) : [window];
  return transaction(() => {
    requireAdmin(request);
    const assignments = windows
      .map((value) => `quota_${value}_epoch=quota_${value}_epoch+1`)
      .join(',');
    const statement = getDb().prepare(
      `UPDATE users SET ${assignments}${scope === 'user' ? ' WHERE id=?' : ''}`,
    );
    const resetUsers = Number((userId ? statement.run(userId) : statement.run()).changes);
    if (scope === 'user' && resetUsers === 0)
      throw new HttpError(404, '用户不存在。', 'USER_NOT_FOUND');
    return json({ resetUsers, windows, resetAt: new Date().toISOString() });
  });
}

export function adminStats() {
  const count = (table: 'users' | 'characters' | 'conversations' | 'messages' | 'providers') =>
    (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return json({
    users: count('users'),
    characters: count('characters'),
    conversations: count('conversations'),
    messages: count('messages'),
    providers: count('providers'),
  });
}
