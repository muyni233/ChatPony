import type {
  Announcement,
  Character,
  Conversation,
  Memory,
  Message,
  ProviderConfig,
  SupplierConfig,
  User,
  UserPersona,
} from './types';

export type Row = Record<string, unknown>;
export function toPersona(value: unknown): UserPersona {
  let record: Record<string, unknown> = {};
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      record = parsed as Record<string, unknown>;
  } catch {
    /* Defaults cover older or malformed data. */
  }
  const text = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : '');
  return {
    enabled: record.enabled === true,
    name: text('name'),
    species: text('species'),
    pronouns: text('pronouns'),
    appearance: text('appearance'),
    personality: text('personality'),
    background: text('background'),
  };
}
function list(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}
export function toUser(row: Row): User {
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    role: row.role === 'admin' ? 'admin' : 'user',
    disabled: Boolean(row.disabled),
    timezone: String(row.timezone),
    createdAt: String(row.created_at),
    emailVerifiedAt: row.email_verified_at ? String(row.email_verified_at) : null,
    avatar: String(row.avatar || ''),
    persona: toPersona(row.persona),
    limit5h: Number(row.limit_5h),
    limit7d: Number(row.limit_7d),
    characterSlots: Number(row.character_slots ?? 3),
  };
}
export function toCharacter(row: Row, admin = false): Character {
  return {
    id: String(row.id),
    ownerId: row.owner_id ? String(row.owner_id) : null,
    name: String(row.name),
    slug: String(row.slug),
    description: String(row.description),
    avatar: String(row.avatar),
    color: String(row.color),
    tags: list(row.tags),
    greeting: String(row.greeting),
    active: Boolean(row.active),
    createdAt: String(row.created_at),
    ...(admin
      ? {
          personality: String(row.personality),
          providerId: row.provider_id ? String(row.provider_id) : undefined,
        }
      : {}),
  };
}
export function toConversation(row: Row): Conversation {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    title: String(row.title),
    kind: row.kind === 'group' ? 'group' : 'private',
    characterIds: list(row.character_ids),
    summary: String(row.summary ?? ''),
    maxRounds: Number(row.max_rounds),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastMessage: String(row.last_message ?? ''),
  };
}
export function toMessage(row: Row): Message {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    role: row.role as Message['role'],
    characterId: row.character_id ? String(row.character_id) : null,
    content: String(row.content),
    createdAt: String(row.created_at),
  };
}
export function toMemory(row: Row): Memory {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    characterId: String(row.character_id),
    ...(typeof row.character_name === 'string'
      ? {
          characterName: row.character_name,
          characterAvatar: String(row.character_avatar || ''),
          characterColor: String(row.character_color || '#A58BBE'),
        }
      : {}),
    content: String(row.content),
    source: row.source === 'auto' ? 'auto' : 'manual',
    kind: (['note', 'fact', 'preference', 'relationship', 'event', 'plan', 'summary'].includes(
      String(row.kind),
    )
      ? String(row.kind)
      : 'note') as Memory['kind'],
    importance: row.importance == null ? 0.5 : Number(row.importance),
    status: row.status === 'archived' ? 'archived' : 'active',
    accessCount: Number(row.access_count || 0),
    lastAccessedAt: row.last_accessed_at ? String(row.last_accessed_at) : null,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    tags: list(row.tags),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
export function toProvider(row: Row): ProviderConfig {
  return {
    id: String(row.id),
    supplierId: String(row.supplier_id),
    supplierName: row.supplier_name ? String(row.supplier_name) : undefined,
    supplierActive: Boolean(row.supplier_active) && !row.supplier_deleted_at,
    name: String(row.name),
    protocol: row.supplier_protocol as ProviderConfig['protocol'],
    baseUrl: String(row.supplier_base_url ?? ''),
    model: String(row.model),
    kind: row.kind === 'embedding' ? 'embedding' : 'language',
    capabilities: list(row.capabilities).filter(
      (value): value is ProviderConfig['capabilities'][number] =>
        ['text', 'image', 'audio', 'file'].includes(value),
    ),
    reasoningEffort: (row.reasoning_effort || 'default') as ProviderConfig['reasoningEffort'],
    thinkingBudget: row.thinking_budget == null ? null : Number(row.thinking_budget),
    hasKey: Boolean(row.supplier_api_key),
    active: Boolean(row.active),
    contextWindow: Number(row.context_window),
    maxOutput: Number(row.max_output),
    temperature: row.temperature == null ? null : Number(row.temperature),
    createdAt: String(row.created_at),
  };
}
export function toSupplier(row: Row): SupplierConfig {
  return {
    id: String(row.id),
    name: String(row.name),
    protocol: row.protocol as SupplierConfig['protocol'],
    baseUrl: String(row.base_url),
    hasKey: Boolean(row.api_key),
    active: Boolean(row.active),
    createdAt: String(row.created_at),
  };
}
export function toAnnouncement(row: Row): Announcement {
  return {
    id: String(row.id),
    title: String(row.title),
    content: String(row.content),
    pinned: Boolean(row.pinned),
    published: Boolean(row.published),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
