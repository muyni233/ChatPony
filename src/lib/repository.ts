import { z } from 'zod';
import { attachmentsFor } from './attachments';
import { getDb, id, now } from './db';
import { encrypt } from './crypto';
import { AppError } from './errors';
import { rateLimit, revokeSessions, validName, validPassword } from './auth';
import { getQuota } from './quota';
import { annotateMemoryStatus } from './ai/embeddings';
import { normalizeEmailDomains } from './email-policy';
import { assertMailConfigured } from './mail';
import { isOwnedAvatar, removeOwnedAvatar } from './avatars';
import {
  toAnnouncement,
  toCharacter,
  toConversation,
  toMemory,
  toMessage,
  toProvider,
  toPersona,
  toSupplier,
  toUser,
  type Row,
} from './mappers';
import type {
  AdminOverview,
  Announcement,
  Bootstrap,
  Character,
  Conversation,
  ConversationDetail,
  Memory,
  PlatformSettings,
  ProviderConfig,
  SupplierConfig,
  User,
  UserPersona,
} from './types';

const shortText = (max: number) =>
  z.string().trim().min(1, '不可为空').max(max, `最多 ${max} 个字符`);
const integer = (min: number, max: number) => z.number().int().min(min).max(max);
const bool = z.boolean();
const title = shortText(120);
const quotaLimit = integer(0, 1_000_000);
const metadataFieldNames = [
  'date',
  'time',
  'weekday',
  'timezone',
  'lunarDate',
  'solarTermToday',
  'solarTermSeason',
  'festivals',
] as const;
const personaFields = z
  .object({
    enabled: bool,
    name: z.string().trim().max(60),
    species: z.string().trim().max(60),
    pronouns: z.string().trim().max(40),
    appearance: z.string().trim().max(1500),
    personality: z.string().trim().max(1500),
    background: z.string().trim().max(3000),
  })
  .strict();
const timezone = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, '请输入有效的 IANA 时区，例如 Asia/Shanghai');
const avatar = z
  .string()
  .max(2048)
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, '头像应使用 http 或 https 图片地址');
const characterAvatar = z.union([
  avatar,
  z
    .string()
    .max(2048)
    .regex(/^\/api\/avatars\/character-[a-zA-Z0-9_-]+\.webp$/),
]);
const supplierFields = z
  .object({
    name: shortText(60),
    protocol: z.enum(['anthropic', 'openai-completions', 'openai-responses', 'gemini']),
    baseUrl: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            ['http:', 'https:'].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash
          );
        } catch {
          return false;
        }
      }, '服务地址需为有效的 http/https URL，且不包含凭据或查询参数'),
    apiKey: z.string().max(8192).optional(),
    active: bool,
  })
  .strict();
const providerFields = z
  .object({
    supplierId: shortText(100),
    name: shortText(60),
    model: shortText(200),
    kind: z.enum(['language', 'embedding']),
    capabilities: z.array(z.enum(['text', 'image', 'audio', 'file'])).max(4),
    reasoningEffort: z.enum([
      'default',
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]),
    thinkingBudget: integer(128, 32768).nullable(),
    active: bool,
    contextWindow: integer(2048, 2_000_000),
    maxOutput: integer(128, 65_536),
    temperature: z.number().min(0).max(2).nullable(),
  })
  .strict();

function validateModelThinking(
  protocol: string,
  model: string,
  effort: string,
  budget: number | null,
  maxOutput: number,
): void {
  if (budget !== null && effort !== 'default')
    throw new AppError(400, 'VALIDATION_ERROR', '思考等级与 Token 思考预算不能同时设置。');
  if (budget !== null && !['anthropic', 'gemini'].includes(protocol))
    throw new AppError(400, 'VALIDATION_ERROR', '当前供应商协议不支持 Token 思考预算。');
  if (budget !== null && (budget >= maxOutput || (protocol === 'anthropic' && budget < 1024)))
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      '思考预算必须小于最大输出；Anthropic 预算至少为 1024。',
    );
  if (protocol === 'anthropic' && effort === 'minimal')
    throw new AppError(400, 'VALIDATION_ERROR', 'Anthropic 不支持 minimal 思考等级。');
  if (protocol === 'gemini' && ['xhigh', 'max'].includes(effort))
    throw new AppError(400, 'VALIDATION_ERROR', 'Gemini 不支持 xhigh 或 max 思考等级。');
  if (protocol === 'gemini' && /^gemini-3(?:[.-]|$)/i.test(model) && effort === 'none')
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Gemini 3 系列不支持关闭思考，请使用默认或支持的思考等级。',
    );
  if (
    protocol === 'gemini' &&
    /^gemini-2\.5(?:[.-]|$)/i.test(model) &&
    !['default', 'none'].includes(effort)
  )
    throw new AppError(400, 'VALIDATION_ERROR', 'Gemini 2.5 系列请使用 Token 思考预算。');
}
const characterFields = z
  .object({
    name: shortText(60),
    slug: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, '标识仅支持小写字母、数字、下划线与短横线，最多 40 位'),
    description: z.string().trim().max(500),
    avatar: characterAvatar,
    color: z.string().regex(/^#[a-fA-F0-9]{6}$/, '颜色应为六位十六进制值'),
    tags: z.array(shortText(24)).max(10),
    personality: shortText(20_000),
    greeting: z.string().trim().max(4000),
    providerId: z.string().max(100).nullable().optional(),
    active: bool,
  })
  .strict();
const announcementFields = z
  .object({ title: shortText(160), content: shortText(20_000), pinned: bool, published: bool })
  .strict();
const settingsFields = z
  .object({
    registrationOpen: bool,
    defaultLimit5h: quotaLimit,
    defaultLimit7d: quotaLimit,
    defaultCharacterSlots: integer(0, 100),
    maxGroupRounds: integer(1, 12),
    siteDescription: z.string().trim().max(300),
    // Display rules are literal strings. Whitespace is meaningful and must survive a save.
    bubbleDelimiter: z.string().max(32),
    hiddenSymbols: z.array(z.string().min(1, '隐藏符号不可为空字符串').max(20)).max(20),
    requireEmailVerification: bool,
    emailDomainMode: z.enum(['any', 'allowlist', 'blocklist']),
    emailDomains: z.array(z.string().max(255)).max(100),
    auditCaptureContent: bool,
    auditRetentionDays: integer(1, 90),
    compressionTriggerRounds: integer(2, 200),
    compressionKeepRounds: integer(1, 50),
    compressionModelId: z.string().max(100),
    memorySummaryInterval: integer(1, 100),
    memorySummaryModelId: z.string().max(100),
    automaticMemoryEnabled: bool,
    metadataEnabled: bool,
    metadataFields: z.array(z.enum(metadataFieldNames)).max(8),
    metadataTimezone: z.union([z.literal(''), timezone]),
    metadataCustom: z.string().max(2000),
    streamingEnabled: bool,
    imageInputEnabled: bool,
    maxImagesPerMessage: integer(1, 8),
    actionStyleEnabled: bool,
    // Each entry is "open close", e.g. "* *" or "（ ）". Literal text, never a regular expression.
    actionMarkers: z
      .array(
        z
          .string()
          .max(21)
          .regex(/^\S{1,10} \S{1,10}$/, '动作标记格式为「开始符号 空格 结束符号」，例如 * *'),
      )
      .max(10),
    actionHideMarkers: bool,
    memoryStructuredExtraction: bool,
    memoryRecallTopK: integer(1, 20),
    memoryKeywordWeight: z.number().min(0).max(1),
    memoryDecayRate: z.number().min(0).max(0.5),
    memoryArchiveThreshold: z.number().min(0).max(1),
  })
  .strict();

function validated<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `${issue.path.join('.') ? `${issue.path.join('.')}：` : ''}${issue.message}`,
    );
  }
  return parsed.data;
}

function found(row: unknown, message = '记录不存在。'): Row {
  if (!row) throw new AppError(404, 'NOT_FOUND', message);
  return row as Row;
}

export function getSettings(): PlatformSettings {
  const values = Object.fromEntries(
    (getDb().query('SELECT key,value FROM settings').all() as Row[]).map((row) => {
      let value: unknown = row.value;
      try {
        value = JSON.parse(String(row.value));
      } catch {
        /* Older development databases stored descriptions as plain text. */
      }
      return [String(row.key), value];
    }),
  );
  return {
    registrationOpen: Boolean(values.registrationOpen),
    defaultLimit5h: Number(values.defaultLimit5h),
    defaultLimit7d: Number(values.defaultLimit7d),
    defaultCharacterSlots: Number(values.defaultCharacterSlots ?? 3),
    maxGroupRounds: Number(values.maxGroupRounds),
    siteDescription: typeof values.siteDescription === 'string' ? values.siteDescription : '',
    bubbleDelimiter: typeof values.bubbleDelimiter === 'string' ? values.bubbleDelimiter : '',
    hiddenSymbols: Array.isArray(values.hiddenSymbols)
      ? values.hiddenSymbols.filter(
          (value): value is string => typeof value === 'string' && value.length > 0,
        )
      : [],
    requireEmailVerification: values.requireEmailVerification === true,
    emailDomainMode: ['allowlist', 'blocklist'].includes(String(values.emailDomainMode))
      ? (values.emailDomainMode as 'allowlist' | 'blocklist')
      : 'any',
    emailDomains: Array.isArray(values.emailDomains)
      ? values.emailDomains.filter((value): value is string => typeof value === 'string')
      : [],
    auditCaptureContent: values.auditCaptureContent === true,
    auditRetentionDays: Number(values.auditRetentionDays || 7),
    compressionTriggerRounds: Number(values.compressionTriggerRounds ?? 24),
    compressionKeepRounds: Number(values.compressionKeepRounds ?? 8),
    compressionModelId:
      typeof values.compressionModelId === 'string' ? values.compressionModelId : '',
    memorySummaryInterval: Number(values.memorySummaryInterval ?? 8),
    memorySummaryModelId:
      typeof values.memorySummaryModelId === 'string' ? values.memorySummaryModelId : '',
    automaticMemoryEnabled: values.automaticMemoryEnabled !== false,
    metadataEnabled: values.metadataEnabled !== false,
    metadataFields: Array.isArray(values.metadataFields)
      ? values.metadataFields.filter((value): value is (typeof metadataFieldNames)[number] =>
          metadataFieldNames.includes(value as (typeof metadataFieldNames)[number]),
        )
      : [...metadataFieldNames],
    metadataTimezone: typeof values.metadataTimezone === 'string' ? values.metadataTimezone : '',
    metadataCustom: typeof values.metadataCustom === 'string' ? values.metadataCustom : '',
    streamingEnabled: values.streamingEnabled !== false,
    imageInputEnabled: values.imageInputEnabled !== false,
    maxImagesPerMessage: clampNumber(values.maxImagesPerMessage, 1, 8, 4),
    actionStyleEnabled: values.actionStyleEnabled !== false,
    actionMarkers: Array.isArray(values.actionMarkers)
      ? values.actionMarkers.filter(
          (value): value is string =>
            typeof value === 'string' && /^\S{1,10} \S{1,10}$/.test(value),
        )
      : ['* *', '（ ）'],
    actionHideMarkers: values.actionHideMarkers !== false,
    memoryStructuredExtraction: values.memoryStructuredExtraction !== false,
    memoryRecallTopK: clampNumber(values.memoryRecallTopK, 1, 20, 6),
    memoryKeywordWeight: clampNumber(values.memoryKeywordWeight, 0, 1, 0.5),
    memoryDecayRate: clampNumber(values.memoryDecayRate, 0, 0.5, 0.01),
    memoryArchiveThreshold: clampNumber(values.memoryArchiveThreshold, 0, 1, 0.1),
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && value !== null && value !== undefined && value !== ''
    ? Math.min(max, Math.max(min, number))
    : fallback;
}

export function updateSettings(input: Record<string, unknown>): PlatformSettings {
  const changes = validated(settingsFields.partial(), input);
  getDb()
    .transaction(() => {
      if (changes.emailDomains !== undefined)
        changes.emailDomains = normalizeEmailDomains(changes.emailDomains);
      const previous = getSettings();
      const next = { ...previous, ...changes };
      if (next.emailDomainMode === 'allowlist' && next.emailDomains.length === 0)
        throw new AppError(400, 'INVALID_EMAIL_DOMAIN', '允许列表至少需要一个邮箱域名。');
      if (changes.requireEmailVerification === true) assertMailConfigured();
      if (next.compressionKeepRounds >= next.compressionTriggerRounds)
        throw new AppError(400, 'VALIDATION_ERROR', '压缩后保留的轮数必须小于触发压缩的轮数。');
      if (changes.metadataFields) changes.metadataFields = [...new Set(changes.metadataFields)];
      for (const key of ['compressionModelId', 'memorySummaryModelId'] as const) {
        const modelId = changes[key];
        if (
          modelId &&
          !getDb()
            .query(
              "SELECT p.id FROM providers p JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=? AND p.kind='language' AND p.active=1 AND p.deleted_at IS NULL AND s.active=1 AND s.deleted_at IS NULL",
            )
            .get(modelId)
        )
          throw new AppError(
            400,
            'MAINTENANCE_MODEL_UNAVAILABLE',
            '所选压缩或记忆总结模型当前不可用，请选择已启用的供应商与模型，或使用本地摘录。',
          );
      }
      for (const [key, value] of Object.entries(changes))
        getDb()
          .query(
            'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
          )
          .run(key, JSON.stringify(value));
      // Changing a global quota intentionally replaces per-account overrides on
      // that axis. Same-value saves leave overrides and usage accounting intact.
      if (
        changes.defaultLimit5h !== undefined &&
        changes.defaultLimit5h !== previous.defaultLimit5h
      )
        getDb().query('UPDATE users SET limit_5h=?').run(changes.defaultLimit5h);
      if (
        changes.defaultLimit7d !== undefined &&
        changes.defaultLimit7d !== previous.defaultLimit7d
      )
        getDb().query('UPDATE users SET limit_7d=?').run(changes.defaultLimit7d);
      if (
        changes.defaultCharacterSlots !== undefined &&
        changes.defaultCharacterSlots !== previous.defaultCharacterSlots
      )
        getDb().query('UPDATE users SET character_slots=?').run(changes.defaultCharacterSlots);
    })
    .immediate();
  return getSettings();
}

export function listCharacters(admin = false, userId: string | null = null): Character[] {
  const query = admin
    ? 'SELECT c.* FROM characters c WHERE c.owner_id IS NULL AND c.deleted_at IS NULL ORDER BY c.created_at DESC, c.rowid DESC'
    : "SELECT c.* FROM characters c JOIN providers p ON p.id=c.provider_id JOIN suppliers s ON s.id=p.supplier_id WHERE (c.owner_id IS NULL OR c.owner_id=?) AND c.active=1 AND c.deleted_at IS NULL AND p.kind='language' AND p.active=1 AND p.deleted_at IS NULL AND s.active=1 AND s.deleted_at IS NULL ORDER BY c.created_at DESC, c.rowid DESC";
  const rows = (admin ? getDb().query(query).all() : getDb().query(query).all(userId)) as Row[];
  return rows.map((row) => toCharacter(row, admin));
}

export function listConversations(userId: string): Conversation[] {
  return (
    getDb()
      .query(
        'SELECT c.*, (SELECT content FROM messages WHERE conversation_id=c.id ORDER BY rowid DESC LIMIT 1) AS last_message FROM conversations c WHERE c.user_id=? AND NOT EXISTS(SELECT 1 FROM json_each(c.character_ids) j JOIN characters r ON r.id=j.value WHERE r.owner_id IS NOT NULL AND r.owner_id!=c.user_id) ORDER BY c.updated_at DESC,c.rowid DESC',
      )
      .all(userId) as Row[]
  ).map(toConversation);
}

export function ownConversation(userId: string, conversationId: string): Row {
  const row = found(
    getDb()
      .query('SELECT * FROM conversations WHERE id=? AND user_id=?')
      .get(conversationId, userId),
    '会话不存在。',
  );
  // Fail closed if stale or tampered membership references somebody else's private role.
  for (const characterId of toConversation(row).characterIds) {
    if (
      getDb()
        .query('SELECT id FROM characters WHERE id=? AND owner_id IS NOT NULL AND owner_id!=?')
        .get(characterId, userId)
    )
      throw new AppError(404, 'NOT_FOUND', '会话不存在。');
  }
  return row;
}

/**
 * Without `limit` every message is returned (exports, tests). The chat view
 * asks for the newest page and loads older pages with `before` on demand.
 */
export function getConversation(
  userId: string,
  conversationId: string,
  page: { limit?: number; before?: string } = {},
): ConversationDetail {
  const row = ownConversation(userId, conversationId);
  const conversation = toConversation(row);
  const characters = conversation.characterIds.flatMap((characterId) => {
    const character = getDb()
      .query(
        'SELECT c.*,p.capabilities AS model_capabilities FROM characters c LEFT JOIN providers p ON p.id=c.provider_id WHERE c.id=? AND (c.owner_id IS NULL OR c.owner_id=?)',
      )
      .get(characterId, userId) as Row | null;
    if (!character) return [];
    let capabilities: unknown = [];
    try {
      capabilities = JSON.parse(String(character.model_capabilities || '[]'));
    } catch {
      /* Treat malformed legacy values as text-only. */
    }
    return [
      {
        ...toCharacter(character),
        imageInput: Array.isArray(capabilities) && capabilities.includes('image'),
      },
    ];
  });
  const limit =
    page.limit && Number.isInteger(page.limit) ? Math.max(1, Math.min(500, page.limit)) : 0;
  let rows: Row[];
  let hasMore = false;
  if (limit) {
    const anchor = page.before
      ? (getDb()
          .query('SELECT rowid AS seq FROM messages WHERE id=? AND conversation_id=?')
          .get(page.before, conversationId) as Row | null)
      : null;
    if (page.before && !anchor) throw new AppError(404, 'NOT_FOUND', '消息不存在。');
    rows = (
      getDb()
        .query(
          'SELECT * FROM messages WHERE conversation_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?',
        )
        .all(
          conversationId,
          anchor ? Number(anchor.seq) : Number.MAX_SAFE_INTEGER,
          limit + 1,
        ) as Row[]
    ).reverse();
    hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(1);
  } else
    rows = getDb()
      .query('SELECT * FROM messages WHERE conversation_id=? ORDER BY rowid ASC')
      .all(conversationId) as Row[];
  const attachments = attachmentsFor(
    rows.filter((item) => item.role === 'user').map((item) => String(item.id)),
  );
  const messages = rows.map((item) => {
    const message = toMessage(item);
    const files = attachments.get(message.id);
    return files?.length ? { ...message, attachments: files } : message;
  });
  const last = page.before
    ? (getDb()
        .query('SELECT content FROM messages WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1')
        .get(conversationId) as Row | null)
    : null;
  return {
    conversation: {
      ...conversation,
      lastMessage: page.before ? String(last?.content ?? '') : (messages.at(-1)?.content ?? ''),
    },
    characters,
    messages,
    ...(limit ? { hasMore } : {}),
  };
}

export function createConversation(userId: string, input: Record<string, unknown>): Conversation {
  const data = validated(
    z
      .object({
        kind: z.enum(['private', 'group']),
        title: title.optional(),
        characterIds: z.array(shortText(100)).min(1).max(12),
        maxRounds: integer(1, 12).optional(),
      })
      .strict(),
    input,
  );
  const characterIds = [...new Set(data.characterIds)];
  if (data.kind === 'private' && characterIds.length !== 1)
    throw new AppError(400, 'VALIDATION_ERROR', '私聊只能选择一个角色。');
  const settings = getSettings();
  if (data.maxRounds && data.maxRounds > settings.maxGroupRounds)
    throw new AppError(400, 'VALIDATION_ERROR', `群聊最多支持 ${settings.maxGroupRounds} 轮回复。`);
  return getDb()
    .transaction(() => {
      const characters = characterIds.map((characterId) =>
        found(
          getDb()
            .query(
              "SELECT c.* FROM characters c JOIN providers p ON p.id=c.provider_id JOIN suppliers s ON s.id=p.supplier_id WHERE c.id=? AND (c.owner_id IS NULL OR c.owner_id=?) AND c.active=1 AND c.deleted_at IS NULL AND p.kind='language' AND p.active=1 AND p.deleted_at IS NULL AND s.active=1 AND s.deleted_at IS NULL",
            )
            .get(characterId, userId),
          '选择的角色当前不可用。',
        ),
      );
      const conversationId = id();
      const timestamp = now();
      const name =
        data.title ||
        (data.kind === 'private'
          ? String(characters[0].name)
          : characters
              .map((character) => String(character.name))
              .join('、')
              .slice(0, 110) + ' 的群聊');
      getDb()
        .query(
          'INSERT INTO conversations(id,user_id,title,kind,character_ids,max_rounds,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          conversationId,
          userId,
          name,
          data.kind,
          JSON.stringify(characterIds),
          data.kind === 'private' ? 1 : (data.maxRounds ?? Math.min(4, settings.maxGroupRounds)),
          timestamp,
          timestamp,
        );
      if (data.kind === 'private' && characters[0].greeting)
        getDb()
          .query(
            "INSERT INTO messages(id,conversation_id,role,character_id,content,created_at) VALUES(?,?,'assistant',?,?,?)",
          )
          .run(
            id(),
            conversationId,
            String(characters[0].id),
            String(characters[0].greeting),
            timestamp,
          );
      return getConversation(userId, conversationId).conversation;
    })
    .immediate();
}

export function updateConversation(
  userId: string,
  conversationId: string,
  input: Record<string, unknown>,
): Conversation {
  const data = validated(
    z.object({ title: title.optional(), maxRounds: integer(1, 12).optional() }).strict(),
    input,
  );
  const row = ownConversation(userId, conversationId);
  if (data.maxRounds && data.maxRounds > getSettings().maxGroupRounds)
    throw new AppError(400, 'VALIDATION_ERROR', '轮数超过平台允许的上限。');
  if (row.kind === 'private' && data.maxRounds && data.maxRounds !== 1)
    throw new AppError(400, 'VALIDATION_ERROR', '私聊每次仅回复一轮。');
  getDb()
    .query('UPDATE conversations SET title=?,max_rounds=?,updated_at=? WHERE id=? AND user_id=?')
    .run(
      data.title ?? String(row.title),
      data.maxRounds ?? Number(row.max_rounds),
      now(),
      conversationId,
      userId,
    );
  return getConversation(userId, conversationId).conversation;
}

export function deleteConversation(userId: string, conversationId: string): void {
  const db = getDb();
  db.transaction(() => {
    const row = ownConversation(userId, conversationId);
    if (row.lock_token && String(row.lock_expires_at) > now())
      throw new AppError(409, 'CONVERSATION_BUSY', '角色正在回复，请等待回复完成后删除会话。');
    db.query('DELETE FROM conversations WHERE id=? AND user_id=?').run(conversationId, userId);
  }).immediate();
}

const memoryKind = z.enum([
  'note',
  'fact',
  'preference',
  'relationship',
  'event',
  'plan',
  'summary',
]);

export function listMemories(userId: string): Memory[] {
  return (
    getDb()
      .query(
        'SELECT m.*,c.name AS character_name,c.avatar AS character_avatar,c.color AS character_color FROM memories m JOIN characters c ON c.id=m.character_id WHERE m.user_id=? AND (c.owner_id IS NULL OR c.owner_id=?) ORDER BY m.updated_at DESC,m.rowid DESC',
      )
      .all(userId, userId) as Row[]
  ).map((row) => annotateMemoryStatus(toMemory(row)));
}

export function createMemory(userId: string, input: Record<string, unknown>): Memory {
  const data = validated(
    z
      .object({
        characterId: shortText(100),
        content: shortText(2000),
        kind: memoryKind.default('note'),
        importance: z.number().min(0).max(1).default(0.75),
      })
      .strict(),
    input,
  );
  found(
    getDb()
      .query(
        'SELECT id FROM characters WHERE id=? AND (owner_id IS NULL OR owner_id=?) AND deleted_at IS NULL AND active=1',
      )
      .get(data.characterId, userId),
    '角色不存在或暂不可用。',
  );
  const count = getDb()
    .query(
      "SELECT COUNT(*) AS count FROM memories WHERE user_id=? AND character_id=? AND source='manual'",
    )
    .get(userId, data.characterId) as Row;
  if (Number(count.count) >= 200)
    throw new AppError(400, 'MEMORY_LIMIT', '每个角色最多保存 200 条手动记忆，请先整理已有记忆。');
  const memoryId = id();
  const timestamp = now();
  getDb()
    .query(
      "INSERT INTO memories(id,user_id,character_id,content,source,kind,importance,created_at,updated_at) VALUES(?,?,?,?,'manual',?,?,?,?)",
    )
    .run(
      memoryId,
      userId,
      data.characterId,
      data.content,
      data.kind,
      data.importance,
      timestamp,
      timestamp,
    );
  return annotateMemoryStatus(
    toMemory(found(getDb().query('SELECT * FROM memories WHERE id=?').get(memoryId))),
  );
}

export function updateMemory(
  userId: string,
  memoryId: string,
  input: Record<string, unknown>,
): Memory {
  const data = validated(
    z
      .object({
        content: shortText(2000).optional(),
        kind: memoryKind.optional(),
        importance: z.number().min(0).max(1).optional(),
        status: z.enum(['active', 'archived']).optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0, '没有需要更新的内容'),
    input,
  );
  found(
    getDb()
      .query(
        'SELECT m.id FROM memories m JOIN characters c ON c.id=m.character_id WHERE m.id=? AND m.user_id=? AND (c.owner_id IS NULL OR c.owner_id=?)',
      )
      .get(memoryId, userId, userId),
    '记忆不存在。',
  );
  const db = getDb();
  db.transaction(() => {
    // Editing the wording makes it the user's own memory; status or weight changes do not.
    if (data.content !== undefined)
      db.query(
        "UPDATE memories SET content=?,source='manual',updated_at=? WHERE id=? AND user_id=?",
      ).run(data.content, now(), memoryId, userId);
    if (data.kind !== undefined)
      db.query('UPDATE memories SET kind=? WHERE id=? AND user_id=?').run(
        data.kind,
        memoryId,
        userId,
      );
    if (data.importance !== undefined)
      db.query('UPDATE memories SET importance=? WHERE id=? AND user_id=?').run(
        data.importance,
        memoryId,
        userId,
      );
    if (data.status !== undefined)
      db.query(
        "UPDATE memories SET status=?,expires_at=CASE WHEN ?='active' AND expires_at<=? THEN NULL ELSE expires_at END,last_accessed_at=CASE WHEN ?='active' THEN ? ELSE last_accessed_at END WHERE id=? AND user_id=?",
      ).run(data.status, data.status, now(), data.status, now(), memoryId, userId);
  })();
  return annotateMemoryStatus(
    toMemory(
      found(getDb().query('SELECT * FROM memories WHERE id=? AND user_id=?').get(memoryId, userId)),
    ),
  );
}

export function deleteMemory(userId: string, memoryId: string): void {
  const result = getDb()
    .query(
      'DELETE FROM memories WHERE id=? AND user_id=? AND character_id IN (SELECT id FROM characters WHERE owner_id IS NULL OR owner_id=?)',
    )
    .run(memoryId, userId, userId);
  if (!result.changes) throw new AppError(404, 'NOT_FOUND', '记忆不存在。');
}

export function listAnnouncements(admin = false): Announcement[] {
  return (
    getDb()
      .query(
        `SELECT * FROM announcements ${admin ? '' : 'WHERE published=1'} ORDER BY pinned DESC,created_at DESC,rowid DESC`,
      )
      .all() as Row[]
  ).map(toAnnouncement);
}

export function saveAnnouncement(
  announcementId: string | null,
  input: Record<string, unknown>,
): Announcement {
  const existing = announcementId
    ? toAnnouncement(
        found(
          getDb().query('SELECT * FROM announcements WHERE id=?').get(announcementId),
          '公告不存在。',
        ),
      )
    : null;
  const patch = validated(
    announcementId
      ? announcementFields.partial()
      : announcementFields.extend({ pinned: bool.default(false), published: bool.default(false) }),
    input,
  );
  const data = validated(announcementFields, {
    title: existing?.title,
    content: existing?.content,
    pinned: existing?.pinned,
    published: existing?.published,
    ...patch,
  });
  const target = announcementId ?? id();
  const timestamp = now();
  if (announcementId)
    getDb()
      .query(
        'UPDATE announcements SET title=?,content=?,pinned=?,published=?,updated_at=? WHERE id=?',
      )
      .run(
        data.title,
        data.content,
        Number(data.pinned),
        Number(data.published),
        timestamp,
        target,
      );
  else
    getDb()
      .query(
        'INSERT INTO announcements(id,title,content,pinned,published,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        target,
        data.title,
        data.content,
        Number(data.pinned),
        Number(data.published),
        timestamp,
        timestamp,
      );
  return toAnnouncement(found(getDb().query('SELECT * FROM announcements WHERE id=?').get(target)));
}

export function deleteAnnouncement(announcementId: string): void {
  if (!getDb().query('DELETE FROM announcements WHERE id=?').run(announcementId).changes)
    throw new AppError(404, 'NOT_FOUND', '公告不存在。');
}

export function listSuppliers(): SupplierConfig[] {
  return (
    getDb()
      .query('SELECT * FROM suppliers WHERE deleted_at IS NULL ORDER BY created_at DESC,rowid DESC')
      .all() as Row[]
  ).map(toSupplier);
}

export function saveSupplier(
  supplierId: string | null,
  input: Record<string, unknown>,
): SupplierConfig {
  return getDb()
    .transaction(() => {
      const existing = supplierId
        ? found(
            getDb()
              .query('SELECT * FROM suppliers WHERE id=? AND deleted_at IS NULL')
              .get(supplierId),
            '供应商不存在。',
          )
        : null;
      const patch = validated(
        supplierId
          ? supplierFields.partial()
          : supplierFields.extend({
              active: bool.default(true),
              protocol: z
                .enum(['anthropic', 'openai-completions', 'openai-responses', 'gemini'])
                .default('openai-completions'),
            }),
        input,
      );
      const data = validated(supplierFields, {
        name: existing?.name,
        protocol: existing?.protocol,
        baseUrl: existing?.base_url,
        active: existing ? Boolean(existing.active) : undefined,
        ...patch,
      });
      const target = supplierId ?? id();
      const apiKey =
        data.apiKey === undefined ? String(existing?.api_key ?? '') : encrypt(data.apiKey.trim());
      const baseUrl = data.baseUrl.replace(/\/+$/, '');
      if (supplierId) {
        const models = getDb()
          .query('SELECT * FROM providers WHERE supplier_id=? AND deleted_at IS NULL')
          .all(supplierId) as Row[];
        for (const model of models) {
          if (model.kind === 'embedding') {
            if (data.protocol === 'anthropic' && model.active)
              throw new AppError(
                400,
                'EMBEDDING_PROTOCOL_UNSUPPORTED',
                '此供应商包含已启用的向量模型，不能切换为 Anthropic。',
              );
          } else
            validateModelThinking(
              data.protocol,
              String(model.model),
              String(model.reasoning_effort || 'default'),
              model.thinking_budget == null ? null : Number(model.thinking_budget),
              Number(model.max_output),
            );
        }
      }
      if (
        supplierId &&
        data.protocol === 'anthropic' &&
        getDb()
          .query(
            'SELECT id FROM providers WHERE supplier_id=? AND deleted_at IS NULL AND temperature>1 LIMIT 1',
          )
          .get(supplierId)
      )
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          'Anthropic 要求 Temperature 不超过 1，请先调整该供应商下的模型参数。',
        );
      if (supplierId)
        getDb()
          .query('UPDATE suppliers SET name=?,protocol=?,base_url=?,api_key=?,active=? WHERE id=?')
          .run(data.name, data.protocol, baseUrl, apiKey, Number(data.active), target);
      else
        getDb()
          .query(
            'INSERT INTO suppliers(id,name,protocol,base_url,api_key,active,created_at) VALUES(?,?,?,?,?,?,?)',
          )
          .run(target, data.name, data.protocol, baseUrl, apiKey, Number(data.active), now());
      getDb()
        .query('UPDATE providers SET protocol=? WHERE supplier_id=?')
        .run(data.protocol, target);
      return toSupplier(found(getDb().query('SELECT * FROM suppliers WHERE id=?').get(target)));
    })
    .immediate();
}

export function deleteSupplier(supplierId: string): void {
  getDb()
    .transaction(() => {
      found(
        getDb().query('SELECT id FROM suppliers WHERE id=? AND deleted_at IS NULL').get(supplierId),
        '供应商不存在。',
      );
      const timestamp = now();
      getDb()
        .query(
          "UPDATE settings SET value='\"\"' WHERE key IN ('compressionModelId','memorySummaryModelId') AND value IN (SELECT json_quote(id) FROM providers WHERE supplier_id=?)",
        )
        .run(supplierId);
      getDb()
        .query(
          'UPDATE characters SET active=0 WHERE provider_id IN (SELECT id FROM providers WHERE supplier_id=?)',
        )
        .run(supplierId);
      getDb()
        .query(
          "UPDATE providers SET active=0,api_key='',base_url='',deleted_at=? WHERE supplier_id=? AND deleted_at IS NULL",
        )
        .run(timestamp, supplierId);
      getDb()
        .query("UPDATE suppliers SET active=0,api_key='',deleted_at=? WHERE id=?")
        .run(timestamp, supplierId);
    })
    .immediate();
}

const modelJoin =
  'SELECT p.*,s.name AS supplier_name,s.protocol AS supplier_protocol,s.base_url AS supplier_base_url,s.api_key AS supplier_api_key,s.active AS supplier_active,s.deleted_at AS supplier_deleted_at FROM providers p JOIN suppliers s ON s.id=p.supplier_id';

export function listProviders(): ProviderConfig[] {
  return (
    getDb()
      .query(
        `${modelJoin} WHERE p.deleted_at IS NULL AND s.deleted_at IS NULL ORDER BY p.created_at DESC,p.rowid DESC`,
      )
      .all() as Row[]
  ).map(toProvider);
}

export function saveProvider(
  providerId: string | null,
  input: Record<string, unknown>,
): ProviderConfig {
  return getDb()
    .transaction(() => {
      const existingRow = providerId
        ? found(
            getDb()
              .query(`${modelJoin} WHERE p.id=? AND p.deleted_at IS NULL AND s.deleted_at IS NULL`)
              .get(providerId),
            '模型不存在。',
          )
        : null;
      const existing = existingRow ? toProvider(existingRow) : null;
      const patch = validated(
        providerId
          ? providerFields.partial()
          : providerFields.extend({
              kind: z.enum(['language', 'embedding']).default('language'),
              capabilities: z
                .array(z.enum(['text', 'image', 'audio', 'file']))
                .max(4)
                .default(['text']),
              reasoningEffort: z
                .enum(['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
                .default('default'),
              thinkingBudget: integer(128, 32768).nullable().default(null),
              active: bool.default(true),
              contextWindow: integer(2048, 2_000_000).default(32768),
              maxOutput: integer(128, 65_536).default(2048),
              temperature: z.number().min(0).max(2).nullable().default(null),
            }),
        input,
      );
      const data = validated(providerFields, {
        supplierId: existing?.supplierId,
        name: existing?.name,
        model: existing?.model,
        kind: existing?.kind,
        capabilities: existing?.capabilities,
        reasoningEffort: existing?.reasoningEffort,
        thinkingBudget: existing?.thinkingBudget,
        active: existing?.active,
        contextWindow: existing?.contextWindow,
        maxOutput: existing?.maxOutput,
        temperature: existing?.temperature,
        ...patch,
      });
      if (data.maxOutput > data.contextWindow / 2)
        throw new AppError(400, 'VALIDATION_ERROR', '最大输出长度不可超过上下文窗口的一半。');
      const supplier = found(
        getDb()
          .query('SELECT id,protocol FROM suppliers WHERE id=? AND deleted_at IS NULL')
          .get(data.supplierId),
        '选择的供应商不存在。',
      );
      if (data.kind === 'embedding') {
        if (supplier.protocol === 'anthropic' && data.active)
          throw new AppError(
            400,
            'EMBEDDING_PROTOCOL_UNSUPPORTED',
            'Anthropic 供应商不支持启用向量模型。',
          );
        data.capabilities = [];
        data.reasoningEffort = 'default';
        data.thinkingBudget = null;
      } else {
        data.capabilities = [...new Set(['text' as const, ...data.capabilities])];
        validateModelThinking(
          String(supplier.protocol),
          data.model,
          data.reasoningEffort,
          data.thinkingBudget,
          data.maxOutput,
        );
      }
      if (
        data.kind === 'language' &&
        supplier.protocol === 'anthropic' &&
        data.temperature !== null &&
        data.temperature > 1
      )
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          'Anthropic 的 Temperature 应为 0–1，或留空使用默认值。',
        );
      const target = providerId ?? id();
      if (providerId)
        getDb()
          .query(
            "UPDATE providers SET supplier_id=?,name=?,protocol=?,model=?,active=?,context_window=?,max_output=?,temperature=?,base_url='',api_key='' WHERE id=?",
          )
          .run(
            data.supplierId,
            data.name,
            String(supplier.protocol),
            data.model,
            Number(data.active),
            data.contextWindow,
            data.maxOutput,
            data.temperature,
            target,
          );
      else
        getDb()
          .query(
            "INSERT INTO providers(id,supplier_id,name,protocol,base_url,model,api_key,active,context_window,max_output,temperature,created_at) VALUES(?,?,?,?,'',?,'',?,?,?,?,?)",
          )
          .run(
            target,
            data.supplierId,
            data.name,
            String(supplier.protocol),
            data.model,
            Number(data.active),
            data.contextWindow,
            data.maxOutput,
            data.temperature,
            now(),
          );
      getDb()
        .query(
          'UPDATE providers SET kind=?,capabilities=?,reasoning_effort=?,thinking_budget=? WHERE id=?',
        )
        .run(
          data.kind,
          JSON.stringify(data.capabilities),
          data.reasoningEffort,
          data.thinkingBudget,
          target,
        );
      if (data.kind === 'embedding') {
        getDb().query('UPDATE characters SET active=0 WHERE provider_id=?').run(target);
        getDb()
          .query(
            "UPDATE settings SET value='\"\"' WHERE key IN ('compressionModelId','memorySummaryModelId') AND value=json_quote(?)",
          )
          .run(target);
      }
      if (data.kind === 'language') {
        const setting = getDb()
          .query("SELECT value FROM settings WHERE key='embeddingConfig'")
          .get() as Row | null;
        if (setting) {
          const config = JSON.parse(String(setting.value)) as Record<string, unknown>;
          if (config.modelId === target)
            getDb()
              .query("UPDATE settings SET value=? WHERE key='embeddingConfig'")
              .run(JSON.stringify({ ...config, enabled: false, modelId: '' }));
        }
      }
      return toProvider(found(getDb().query(`${modelJoin} WHERE p.id=?`).get(target)));
    })
    .immediate();
}

export function deleteProvider(providerId: string): void {
  getDb()
    .transaction(() => {
      found(
        getDb().query('SELECT id FROM providers WHERE id=? AND deleted_at IS NULL').get(providerId),
        '模型服务不存在。',
      );
      getDb()
        .query(
          "UPDATE settings SET value='\"\"' WHERE key IN ('compressionModelId','memorySummaryModelId') AND value=json_quote(?)",
        )
        .run(providerId);
      getDb()
        .query("UPDATE providers SET active=0,api_key='',deleted_at=? WHERE id=?")
        .run(now(), providerId);
      getDb().query('UPDATE characters SET active=0 WHERE provider_id=?').run(providerId);
    })
    .immediate();
}

export function saveCharacter(
  characterId: string | null,
  input: Record<string, unknown>,
  ownerId: string | null = null,
): Character {
  return getDb()
    .transaction(() => saveCharacterRecord(characterId, input, ownerId))
    .immediate();
}

function saveCharacterRecord(
  characterId: string | null,
  input: Record<string, unknown>,
  ownerId: string | null,
): Character {
  if (ownerId) {
    const user = found(
      getDb().query('SELECT character_slots FROM users WHERE id=? AND disabled=0').get(ownerId),
      '账号不可用。',
    );
    if (!characterId) {
      const count = getDb()
        .query('SELECT COUNT(*) AS count FROM characters WHERE owner_id=? AND deleted_at IS NULL')
        .get(ownerId) as Row;
      if (Number(count.count) >= Number(user.character_slots))
        throw new AppError(
          409,
          'CHARACTER_SLOTS_FULL',
          '角色槽位已用完，请先删除不再需要的角色，或联系管理员调整槽位。',
        );
    }
  }
  const existingRow = characterId
    ? found(
        getDb()
          .query('SELECT * FROM characters WHERE id=? AND owner_id IS ? AND deleted_at IS NULL')
          .get(characterId, ownerId),
        '角色不存在。',
      )
    : null;
  const existing = existingRow ? toCharacter(existingRow, true) : null;
  const patch = validated(
    characterId
      ? characterFields.partial()
      : characterFields.extend({
          description: z.string().trim().max(500).default(''),
          avatar: characterAvatar.default(''),
          color: z
            .string()
            .regex(/^#[a-fA-F0-9]{6}$/)
            .default('#A58BBE'),
          tags: z.array(shortText(24)).max(10).default([]),
          greeting: z.string().trim().max(4000).default(''),
          active: bool.default(false),
        }),
    input,
  );
  const data = validated(characterFields, {
    name: existing?.name,
    slug: existing?.slug,
    description: existing?.description,
    avatar: existing?.avatar,
    color: existing?.color,
    tags: existing?.tags,
    personality: existing?.personality,
    greeting: existing?.greeting,
    providerId: existing?.providerId,
    active: existing?.active,
    ...patch,
  });
  if (
    data.avatar.startsWith('/api/avatars/') &&
    (!characterId ||
      data.avatar !== existing?.avatar ||
      !isOwnedAvatar(`character-${characterId}`, data.avatar))
  )
    throw new AppError(
      400,
      'INVALID_AVATAR',
      '请上传角色头像，或使用有效的 HTTP / HTTPS 图片地址。',
    );
  const providerId = data.providerId || null;
  const provider = providerId
    ? found(
        getDb()
          .query(`${modelJoin} WHERE p.id=? AND p.deleted_at IS NULL AND s.deleted_at IS NULL`)
          .get(providerId),
        '选择的模型不存在。',
      )
    : null;
  if (provider && provider.kind !== 'language')
    throw new AppError(400, 'LANGUAGE_MODEL_REQUIRED', '角色只能关联语言模型。');
  if (
    ownerId &&
    provider &&
    providerId !== existing?.providerId &&
    (!provider.active || !provider.supplier_active)
  )
    throw new AppError(
      400,
      'MODEL_UNAVAILABLE',
      '所选语言模型当前不可用，请选择已启用的模型，或留空保存停用草稿。',
    );
  if (data.active && (!provider || !provider.active || !provider.supplier_active))
    throw new AppError(400, 'PROVIDER_REQUIRED', '启用角色前，请先配置并启用供应商及模型。');
  const duplicate = getDb()
    .query('SELECT id FROM characters WHERE slug=? AND id!=?')
    .get(data.slug, characterId || '');
  if (duplicate) throw new AppError(409, 'SLUG_EXISTS', '此角色标识已被使用，请换一个标识。');
  const target = characterId ?? id();
  if (characterId)
    getDb()
      .query(
        'UPDATE characters SET name=?,slug=?,description=?,avatar=?,color=?,tags=?,personality=?,greeting=?,provider_id=?,active=? WHERE id=?',
      )
      .run(
        data.name,
        data.slug,
        data.description,
        data.avatar,
        data.color,
        JSON.stringify([...new Set(data.tags)]),
        data.personality,
        data.greeting,
        providerId,
        Number(data.active),
        target,
      );
  else
    getDb()
      .query(
        'INSERT INTO characters(id,name,slug,description,avatar,color,tags,personality,greeting,provider_id,active,created_at,owner_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        target,
        data.name,
        data.slug,
        data.description,
        data.avatar,
        data.color,
        JSON.stringify([...new Set(data.tags)]),
        data.personality,
        data.greeting,
        providerId,
        Number(data.active),
        now(),
        ownerId,
      );
  return toCharacter(found(getDb().query('SELECT * FROM characters WHERE id=?').get(target)), true);
}

export function deleteCharacter(characterId: string, ownerId: string | null = null): void {
  if (
    !getDb()
      .query(
        'UPDATE characters SET active=0,deleted_at=? WHERE id=? AND owner_id IS ? AND deleted_at IS NULL',
      )
      .run(now(), characterId, ownerId).changes
  )
    throw new AppError(404, 'NOT_FOUND', '角色不存在。');
}

export function listUsers(): User[] {
  return (
    getDb().query('SELECT * FROM users ORDER BY created_at DESC,rowid DESC').all() as Row[]
  ).map(toAdminUser);
}

function toAdminUser(row: Row): User {
  const user = toUser(row);
  delete user.persona;
  return user;
}

export function updateUser(userId: string, input: Record<string, unknown>): User {
  const changes = validated(
    z
      .object({
        limit5h: quotaLimit.optional(),
        limit7d: quotaLimit.optional(),
        characterSlots: integer(0, 100).optional(),
        disabled: bool.optional(),
        role: z.enum(['user', 'admin']).optional(),
      })
      .strict(),
    input,
  );
  return getDb()
    .transaction(() => {
      const existing = toUser(
        found(getDb().query('SELECT * FROM users WHERE id=?').get(userId), '用户不存在。'),
      );
      const user = { ...existing, ...changes };
      if (
        existing.role === 'admin' &&
        !existing.disabled &&
        (user.disabled || user.role !== 'admin')
      ) {
        const count = getDb()
          .query("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND disabled=0")
          .get() as Row;
        if (Number(count.count) < 2)
          throw new AppError(409, 'LAST_ADMIN', '平台须保留至少一位可用的管理员。');
      }
      getDb()
        .query(
          'UPDATE users SET limit_5h=?,limit_7d=?,character_slots=?,disabled=?,role=? WHERE id=?',
        )
        .run(
          user.limit5h,
          user.limit7d,
          user.characterSlots,
          Number(user.disabled),
          user.role,
          userId,
        );
      if (user.disabled || existing.role !== user.role) revokeSessions(userId);
      return toAdminUser(found(getDb().query('SELECT * FROM users WHERE id=?').get(userId)));
    })
    .immediate();
}

export function getPersona(userId: string): UserPersona {
  const row = found(
    getDb().query('SELECT persona FROM users WHERE id=? AND disabled=0').get(userId),
    '账号不可用。',
  );
  return toPersona(row.persona);
}

export function updatePersona(userId: string, input: Record<string, unknown>): UserPersona {
  const patch = validated(personaFields.partial(), input);
  return getDb()
    .transaction(() => {
      const persona = validated(personaFields, { ...getPersona(userId), ...patch });
      const total = Object.values(persona).reduce(
        (count, value) => count + (typeof value === 'string' ? value.length : 0),
        0,
      );
      if (total > 6000)
        throw new AppError(400, 'PERSONA_TOO_LONG', '自设卡文字合计不能超过 6000 个字符。');
      getDb().query('UPDATE users SET persona=? WHERE id=?').run(JSON.stringify(persona), userId);
      return persona;
    })
    .immediate();
}

export async function updateAccount(
  request: Request,
  user: User,
  input: Record<string, unknown>,
): Promise<User> {
  const data = validated(
    z
      .object({
        name: z.string().optional(),
        timezone: timezone.optional(),
        currentPassword: z.string().max(128).optional(),
        password: z.string().optional(),
        avatar: avatar.optional(),
      })
      .strict(),
    input,
  );
  const name = data.name === undefined ? user.name : validName(data.name);
  let passwordHash: string | null = null;
  let expectedPasswordHash: string | null = null;
  if (data.password !== undefined) {
    rateLimit(request, 'password-change', 6, 15 * 60 * 1000, user.id);
    const password = validPassword(data.password);
    const existing = found(
      getDb().query('SELECT * FROM users WHERE id=? AND disabled=0').get(user.id),
      '账号不可用。',
    );
    expectedPasswordHash = String(existing.password_hash);
    if (
      !data.currentPassword ||
      !(await Bun.password.verify(data.currentPassword, expectedPasswordHash))
    )
      throw new AppError(400, 'INVALID_PASSWORD', '当前密码不正确。');
    passwordHash = await Bun.password.hash(password, {
      algorithm: 'argon2id',
      memoryCost: 19456,
      timeCost: 2,
    });
  }
  let previousAvatar = '';
  const updated = getDb()
    .transaction(() => {
      const current = found(
        getDb()
          .query('SELECT id,password_hash,avatar FROM users WHERE id=? AND disabled=0')
          .get(user.id),
        '账号不可用。',
      );
      if (passwordHash && current.password_hash !== expectedPasswordHash)
        throw new AppError(409, 'PASSWORD_CHANGED', '密码已在其他操作中更新，请重新登录后再试。');
      getDb()
        .query('UPDATE users SET name=?,timezone=?,avatar=? WHERE id=?')
        .run(
          name,
          data.timezone ?? user.timezone,
          data.avatar ?? String(current.avatar || ''),
          user.id,
        );
      previousAvatar = String(current.avatar || '');
      if (passwordHash) {
        getDb().query('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash, user.id);
        revokeSessions(user.id);
      }
      return toUser(found(getDb().query('SELECT * FROM users WHERE id=?').get(user.id)));
    })
    .immediate();
  if (data.avatar !== undefined && data.avatar !== previousAvatar)
    await removeOwnedAvatar(user.id, previousAvatar);
  return updated;
}

export function getOverview(): AdminOverview {
  const count = (sql: string) => Number((getDb().query(sql).get() as Row).count);
  return {
    users: count('SELECT COUNT(*) AS count FROM users'),
    characters: count(
      'SELECT COUNT(*) AS count FROM characters WHERE owner_id IS NULL AND deleted_at IS NULL',
    ),
    conversations: count('SELECT COUNT(*) AS count FROM conversations'),
    calls: count("SELECT COUNT(*) AS count FROM api_calls WHERE status='success'"),
  };
}

export function getBootstrap(user: User | null): Bootstrap {
  const count = (table: 'conversations' | 'messages' | 'memories') =>
    !user
      ? 0
      : Number(
          (
            getDb()
              .query(
                table === 'messages'
                  ? 'SELECT COUNT(*) AS count FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.user_id=?'
                  : `SELECT COUNT(*) AS count FROM ${table} WHERE user_id=?`,
              )
              .get(user.id) as Row
          ).count,
        );
  return {
    user,
    characters: listCharacters(false, user?.id),
    conversations: user ? listConversations(user.id) : [],
    announcements: listAnnouncements(),
    quota: user ? getQuota(user.id) : null,
    settings: getSettings(),
    stats: {
      conversations: count('conversations'),
      messages: count('messages'),
      memories: count('memories'),
    },
  };
}
