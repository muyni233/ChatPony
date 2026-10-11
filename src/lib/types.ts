export type Protocol = 'openai-completions' | 'openai-responses' | 'anthropic' | 'gemini';
export type ModelKind = 'language' | 'embedding';
export type ModelCapability = 'text' | 'image' | 'audio' | 'file';
export type ReasoningEffort =
  | 'default'
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';
export interface User {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  disabled: boolean;
  timezone: string;
  createdAt: string;
  emailVerifiedAt?: string | null;
  avatar?: string;
  persona?: UserPersona;
  limit5h: number;
  limit7d: number;
}
export interface UserPersona {
  enabled: boolean;
  name: string;
  species: string;
  pronouns: string;
  appearance: string;
  personality: string;
  background: string;
}
export interface Character {
  id: string;
  name: string;
  slug: string;
  description: string;
  avatar: string;
  color: string;
  tags: string[];
  personality?: string;
  greeting: string;
  providerId?: string;
  active: boolean;
  createdAt: string;
}
export interface ProviderConfig {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  model: string;
  kind: ModelKind;
  capabilities: ModelCapability[];
  reasoningEffort: ReasoningEffort;
  thinkingBudget: number | null;
  supplierId: string;
  supplierName?: string;
  supplierActive: boolean;
  hasKey: boolean;
  active: boolean;
  contextWindow: number;
  maxOutput: number;
  temperature: number | null;
  createdAt: string;
}
export interface SupplierConfig {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  hasKey: boolean;
  active: boolean;
  createdAt: string;
}
export interface Conversation {
  id: string;
  userId: string;
  title: string;
  kind: 'private' | 'group';
  characterIds: string[];
  summary: string;
  maxRounds: number;
  createdAt: string;
  updatedAt: string;
  lastMessage: string;
}
export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  characterId: string | null;
  content: string;
  createdAt: string;
}
export interface Memory {
  id: string;
  userId: string;
  characterId: string;
  content: string;
  source: 'manual' | 'auto';
  createdAt: string;
  updatedAt: string;
  vectorStatus?: 'pending' | 'ready' | 'failed' | 'disabled';
}
export interface EmbeddingConfig {
  modelId: string;
  supplierId: string;
  supplierName?: string;
  supplierActive?: boolean;
  protocol: 'openai' | 'gemini';
  enabled: boolean;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  topK: number;
  minSimilarity: number;
}
export interface Announcement {
  id: string;
  title: string;
  content: string;
  pinned: boolean;
  published: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface QuotaWindow {
  used: number;
  limit: number;
  remaining: number;
  resetsAt: string | null;
}
export interface QuotaSnapshot {
  fiveHour: QuotaWindow;
  sevenDay: QuotaWindow;
}
export interface PlatformSettings {
  registrationOpen: boolean;
  defaultLimit5h: number;
  defaultLimit7d: number;
  maxGroupRounds: number;
  siteDescription: string;
  bubbleDelimiter: string;
  hiddenSymbols: string[];
  requireEmailVerification: boolean;
  emailDomainMode: 'any' | 'allowlist' | 'blocklist';
  emailDomains: string[];
  auditCaptureContent: boolean;
  auditRetentionDays: number;
  compressionTriggerRounds: number;
  compressionKeepRounds: number;
  compressionModelId: string;
  memorySummaryInterval: number;
  memorySummaryModelId: string;
  automaticMemoryEnabled: boolean;
  metadataEnabled: boolean;
  metadataFields: string[];
  metadataTimezone: string;
  metadataCustom: string;
}

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  username: string;
  hasPassword: boolean;
  fromEmail: string;
  fromName: string;
}

export interface RequestAudit {
  id: string;
  kind: 'chat' | 'embedding' | 'connection-test' | 'compression' | 'memory-summary';
  userId: string | null;
  userName: string | null;
  conversationId: string | null;
  characterId: string | null;
  characterName: string | null;
  supplierId: string | null;
  supplierName: string | null;
  modelId: string | null;
  protocol: string;
  model: string;
  endpoint: string;
  status: 'pending' | 'success' | 'failed' | 'cancelled';
  httpStatus: number | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
  requestId: string | null;
  attempt: number;
  requestTruncated: boolean;
  responseTruncated: boolean;
}

export interface RequestAuditDetail extends RequestAudit {
  requestBody: string | null;
  responseBody: string | null;
}

export interface RequestAuditList {
  items: RequestAudit[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RequestAuditStats {
  total: number;
  success: number;
  failed: number;
  pending: number;
  avgDurationMs: number;
  inputTokens: number;
  outputTokens: number;
}
export interface Bootstrap {
  user: User | null;
  characters: Character[];
  conversations: Conversation[];
  announcements: Announcement[];
  quota: QuotaSnapshot | null;
  settings: PlatformSettings;
  stats: { conversations: number; messages: number; memories: number };
}
export interface ConversationDetail {
  conversation: Conversation;
  characters: Character[];
  messages: Message[];
}
export interface AdminOverview {
  users: number;
  characters: number;
  conversations: number;
  calls: number;
}
export type ChatEvent =
  | { type: 'user'; message: Message }
  | { type: 'status'; text: string; characterId?: string }
  | { type: 'message'; message: Message }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; quota: QuotaSnapshot; rounds: number; limited: boolean };
