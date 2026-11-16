import type {
  AdminOverview,
  Announcement,
  Attachment,
  Bootstrap,
  Character,
  ChatEvent,
  Conversation,
  ConversationDetail,
  EmbeddingConfig,
  MailConfig,
  MailDeliveryList,
  Memory,
  MemoryKind,
  MemoryRecallResult,
  PlatformSettings,
  ProviderConfig,
  QuotaSnapshot,
  RequestAuditDetail,
  RequestAuditList,
  RequestAuditStats,
  SupplierConfig,
  User,
  UserCharacters,
  UserPersona,
} from './types';

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    buf[6] = (buf[6]! & 0x0f) | 0x40;
    buf[8] = (buf[8]! & 0x3f) | 0x80;
    const hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `req-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback for non-HTTPS LAN access
    }
  }
  if (typeof document === 'undefined') return false;
  const el = document.createElement('textarea');
  el.value = text;
  el.style.position = 'fixed';
  el.style.left = '-9999px';
  document.body.appendChild(el);
  el.focus();
  el.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(el);
  return ok;
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const resp = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers,
  });
  let parsed: { data?: T; error?: { code?: string; message?: string } } | null = null;
  try {
    parsed = await resp.json();
  } catch {
    parsed = null;
  }
  if (!resp.ok) {
    throw new ApiError(
      resp.status,
      parsed?.error?.code ?? `HTTP_${resp.status}`,
      parsed?.error?.message ?? `请求失败（HTTP ${resp.status}）`
    );
  }
  if (parsed && 'data' in parsed) {
    return parsed.data as T;
  }
  return parsed as unknown as T;
}

export const api = {
  bootstrap: () => requestJson<Bootstrap>('/api/bootstrap'),

  registrationPolicy: () =>
    requestJson<{
      registrationOpen: boolean;
      requireEmailVerification: boolean;
      emailDomainMode: string;
      emailDomains: string[];
    }>('/api/registration-policy'),

  sendCode: (email: string) =>
    requestJson<{ ok: boolean }>('/api/auth/send-code', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  register: (payload: {
    email: string;
    password: string;
    name: string;
    timezone?: string;
    verificationCode?: string;
  }) =>
    requestJson<{ user: User }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  login: (email: string, password: string) =>
    requestJson<{ user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  logout: () => requestJson<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  // Account & Persona
  getAccount: () => requestJson<{ user: User; quota: QuotaSnapshot }>('/api/account'),

  updateAccount: (payload: { name?: string; timezone?: string }) =>
    requestJson<{ user: User }>('/api/account', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  changePassword: (currentPassword: string, newPassword: string) =>
    requestJson<{ ok: boolean }>('/api/account/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  updatePersona: (persona: UserPersona) =>
    requestJson<{ user: User }>('/api/account/persona', {
      method: 'PUT',
      body: JSON.stringify(persona),
    }),

  uploadUserAvatar: (file: File) => {
    const fd = new FormData();
    fd.append('avatar', file);
    return requestJson<{ user: User }>('/api/account/avatar', { method: 'POST', body: fd });
  },

  deleteUserAvatar: () =>
    requestJson<{ user: User }>('/api/account/avatar', { method: 'DELETE' }),

  // Private User Characters
  listUserCharacters: () => requestJson<UserCharacters>('/api/user-characters'),

  createUserCharacter: (payload: {
    name: string;
    slug?: string;
    description: string;
    color: string;
    tags: string[];
    personality: string;
    greeting: string;
    providerId?: string | null;
    active: boolean;
  }) =>
    requestJson<Character>('/api/user-characters', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateUserCharacter: (
    id: string,
    payload: Partial<{
      name: string;
      description: string;
      color: string;
      tags: string[];
      personality: string;
      greeting: string;
      providerId: string | null;
      active: boolean;
    }>
  ) =>
    requestJson<Character>(`/api/user-characters/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteUserCharacter: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/user-characters/${id}`, { method: 'DELETE' }),

  uploadUserCharacterAvatar: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('avatar', file);
    return requestJson<Character>(`/api/user-characters/${id}/avatar`, {
      method: 'POST',
      body: fd,
    });
  },

  deleteUserCharacterAvatar: (id: string) =>
    requestJson<Character>(`/api/user-characters/${id}/avatar`, { method: 'DELETE' }),

  // Conversations & Attachments
  listConversations: () => requestJson<Conversation[]>('/api/conversations'),

  createConversation: (payload: {
    characterIds: string[];
    title?: string;
    maxRounds?: number;
  }) =>
    requestJson<Conversation>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getConversation: (id: string, params?: { limit?: number; before?: string }) => {
    const sp = new URLSearchParams();
    if (params?.limit) sp.set('limit', String(params.limit));
    if (params?.before) sp.set('before', params.before);
    const qs = sp.toString();
    return requestJson<ConversationDetail>(`/api/conversations/${id}${qs ? `?${qs}` : ''}`);
  },

  updateConversation: (
    id: string,
    payload: Partial<{ title: string; maxRounds: number; summary: string }>
  ) =>
    requestJson<Conversation>(`/api/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteConversation: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/conversations/${id}`, { method: 'DELETE' }),

  clearConversationMessages: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/conversations/${id}/messages`, { method: 'DELETE' }),

  uploadAttachment: (convId: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return requestJson<Attachment>(`/api/conversations/${convId}/attachments`, {
      method: 'POST',
      body: fd,
    });
  },

  // Memories
  listMemories: (params?: {
    characterId?: string;
    status?: string;
    kind?: string;
    q?: string;
  }) => {
    const sp = new URLSearchParams();
    if (params?.characterId) sp.set('characterId', params.characterId);
    if (params?.status) sp.set('status', params.status);
    if (params?.kind) sp.set('kind', params.kind);
    if (params?.q) sp.set('q', params.q);
    const qs = sp.toString();
    return requestJson<Memory[]>(`/api/memories${qs ? `?${qs}` : ''}`);
  },

  createMemory: (payload: {
    characterId: string;
    content: string;
    kind?: MemoryKind;
    importance?: number;
    tags?: string[];
  }) =>
    requestJson<Memory>('/api/memories', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateMemory: (
    id: string,
    payload: Partial<{
      content: string;
      kind: MemoryKind;
      status: 'active' | 'archived';
      importance: number;
      tags: string[];
    }>
  ) =>
    requestJson<Memory>(`/api/memories/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteMemory: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/memories/${id}`, { method: 'DELETE' }),

  summarizeMemories: (characterId: string) =>
    requestJson<{ saved: number }>('/api/memories/summarize', {
      method: 'POST',
      body: JSON.stringify({ characterId }),
    }),

  recallPreview: (characterId: string, query: string) =>
    requestJson<MemoryRecallResult[]>('/api/memories/recall-preview', {
      method: 'POST',
      body: JSON.stringify({ characterId, query }),
    }),

  reindexMemories: (characterId: string) =>
    requestJson<{ ok: boolean }>('/api/memories/reindex', {
      method: 'POST',
      body: JSON.stringify({ characterId }),
    }),

  // Admin
  adminOverview: () => requestJson<AdminOverview>('/api/admin/overview'),
  adminGetSettings: () => requestJson<PlatformSettings>('/api/admin/settings'),
  adminSaveSettings: (patch: Partial<PlatformSettings>) =>
    requestJson<PlatformSettings>('/api/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  adminListUsers: () => requestJson<User[]>('/api/admin/users'),
  adminCreateUser: (payload: {
    email: string;
    password: string;
    name: string;
    role: 'user' | 'admin';
    limit5h?: number;
    limit7d?: number;
    characterSlots?: number;
  }) =>
    requestJson<User>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  adminUpdateUser: (
    id: string,
    payload: Partial<{
      role: 'user' | 'admin';
      disabled: boolean;
      limit5h: number;
      limit7d: number;
      characterSlots: number;
      password: string;
    }>
  ) =>
    requestJson<User>(`/api/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  adminResetUserQuota: (id: string) =>
    requestJson<QuotaSnapshot>(`/api/admin/users/${id}/reset-quota`, { method: 'POST' }),

  adminListCharacters: () => requestJson<Character[]>('/api/admin/characters'),
  adminCreateCharacter: (payload: Partial<Character> & { name: string; personality: string }) =>
    requestJson<Character>('/api/admin/characters', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  adminUpdateCharacter: (id: string, payload: Partial<Character>) =>
    requestJson<Character>(`/api/admin/characters/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  adminDeleteCharacter: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/admin/characters/${id}`, { method: 'DELETE' }),
  adminUploadCharacterAvatar: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('avatar', file);
    return requestJson<Character>(`/api/admin/characters/${id}/avatar`, {
      method: 'POST',
      body: fd,
    });
  },
  adminDeleteCharacterAvatar: (id: string) =>
    requestJson<Character>(`/api/admin/characters/${id}/avatar`, { method: 'DELETE' }),

  adminListSuppliers: () => requestJson<SupplierConfig[]>('/api/admin/suppliers'),
  adminCreateSupplier: (payload: {
    name: string;
    protocol: string;
    baseUrl: string;
    apiKey?: string;
    active: boolean;
  }) =>
    requestJson<SupplierConfig>('/api/admin/suppliers', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  adminUpdateSupplier: (
    id: string,
    payload: Partial<{
      name: string;
      protocol: string;
      baseUrl: string;
      apiKey: string;
      active: boolean;
    }>
  ) =>
    requestJson<SupplierConfig>(`/api/admin/suppliers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  adminDeleteSupplier: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/admin/suppliers/${id}`, { method: 'DELETE' }),

  adminListModels: () => requestJson<ProviderConfig[]>('/api/admin/providers'),
  adminCreateModel: (payload: {
    name: string;
    supplierId: string;
    model: string;
    kind: string;
    capabilities: string[];
    reasoningEffort: string;
    thinkingBudget?: number | null;
    active: boolean;
    contextWindow: number;
    maxOutput: number;
    temperature?: number | null;
  }) =>
    requestJson<ProviderConfig>('/api/admin/providers', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  adminUpdateModel: (
    id: string,
    payload: Partial<{
      name: string;
      supplierId: string;
      model: string;
      kind: string;
      capabilities: string[];
      reasoningEffort: string;
      thinkingBudget: number | null;
      active: boolean;
      contextWindow: number;
      maxOutput: number;
      temperature: number | null;
    }>
  ) =>
    requestJson<ProviderConfig>(`/api/admin/providers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  adminDeleteModel: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/admin/providers/${id}`, { method: 'DELETE' }),
  adminTestModel: (id: string) =>
    requestJson<{ ok: boolean; reply?: string; dimensions?: number; durationMs: number }>(
      `/api/admin/providers/${id}/test`,
      { method: 'POST' }
    ),

  adminGetEmbedding: () => requestJson<EmbeddingConfig>('/api/admin/embedding'),
  adminSaveEmbedding: (payload: {
    enabled: boolean;
    modelId: string;
    topK: number;
    minSimilarity: number;
  }) =>
    requestJson<EmbeddingConfig>('/api/admin/embedding', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  adminTestEmbedding: (modelId?: string) =>
    requestJson<{ ok: boolean; dimensions: number; durationMs: number }>(
      '/api/admin/embedding/test',
      {
        method: 'POST',
        body: JSON.stringify(modelId ? { modelId } : {}),
      }
    ),

  adminListAnnouncements: () => requestJson<Announcement[]>('/api/admin/announcements'),
  adminCreateAnnouncement: (payload: {
    title: string;
    content: string;
    pinned: boolean;
    published: boolean;
  }) =>
    requestJson<Announcement>('/api/admin/announcements', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  adminUpdateAnnouncement: (
    id: string,
    payload: Partial<{ title: string; content: string; pinned: boolean; published: boolean }>
  ) =>
    requestJson<Announcement>(`/api/admin/announcements/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  adminDeleteAnnouncement: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/admin/announcements/${id}`, { method: 'DELETE' }),

  adminGetMail: () => requestJson<MailConfig>('/api/admin/mail'),
  adminSaveMail: (payload: {
    host: string;
    port: number;
    secure: boolean;
    requireTLS: boolean;
    username: string;
    password?: string;
    fromEmail: string;
    fromName: string;
  }) =>
    requestJson<MailConfig>('/api/admin/mail', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  adminTestMail: (recipient?: string) =>
    requestJson<{ ok: boolean; summary: string; hint?: string }>('/api/admin/mail/test', {
      method: 'POST',
      body: JSON.stringify(recipient ? { recipient } : {}),
    }),
  adminListMailDeliveries: (params: {
    page?: number;
    pageSize?: number;
    status?: string;
    kind?: string;
  }) => {
    const sp = new URLSearchParams();
    if (params.page) sp.set('page', String(params.page));
    if (params.pageSize) sp.set('pageSize', String(params.pageSize));
    if (params.status) sp.set('status', params.status);
    if (params.kind) sp.set('kind', params.kind);
    return requestJson<MailDeliveryList>(`/api/admin/mail/deliveries?${sp.toString()}`);
  },

  adminListAudit: (params: {
    page?: number;
    pageSize?: number;
    status?: string;
    kind?: string;
    q?: string;
  }) => {
    const sp = new URLSearchParams();
    if (params.page) sp.set('page', String(params.page));
    if (params.pageSize) sp.set('pageSize', String(params.pageSize));
    if (params.status) sp.set('status', params.status);
    if (params.kind) sp.set('kind', params.kind);
    if (params.q) sp.set('q', params.q);
    return requestJson<RequestAuditList>(`/api/admin/audit?${sp.toString()}`);
  },
  adminAuditStats: (hours?: number) =>
    requestJson<RequestAuditStats>(
      `/api/admin/audit/stats${hours ? `?hours=${hours}` : ''}`
    ),
  adminAuditDetail: (id: string) =>
    requestJson<RequestAuditDetail>(`/api/admin/audit/${id}`),
  adminClearAudit: () =>
    requestJson<{ cleared: number }>('/api/admin/audit', { method: 'DELETE' }),
};

export async function streamChatMessage(
  conversationId: string,
  payload: {
    content: string;
    requestId: string;
    attachmentIds?: string[];
    retryOf?: string;
  },
  onEvent: (ev: ChatEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const resp = await fetch(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });

  if (!resp.ok) {
    let errBody: { error?: { code?: string; message?: string } } | null = null;
    try {
      errBody = await resp.json();
    } catch {
      errBody = null;
    }
    throw new ApiError(
      resp.status,
      errBody?.error?.code ?? `HTTP_${resp.status}`,
      errBody?.error?.message ?? `发送失败（HTTP ${resp.status}）`
    );
  }

  const reader = resp.body?.getReader();
  if (!reader) {
    throw new ApiError(500, 'STREAM_UNAVAILABLE', '浏览器不支持流式响应读取。');
  }

  const decoder = new TextDecoder();
  let buf = '';

  const processLines = (flush: boolean) => {
    const lines = buf.split(/\r?\n/);
    buf = flush ? '' : (lines.pop() ?? '');
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const jsonStr = line.slice(5).trim();
      if (!jsonStr) continue;
      try {
        const parsed = JSON.parse(jsonStr) as ChatEvent;
        onEvent(parsed);
      } catch {
        // Ignore malformed partial heartbeat
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    processLines(false);
  }
  buf += decoder.decode();
  processLines(true);
}
