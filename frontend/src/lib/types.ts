export type Protocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic'
  | 'gemini';

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

export interface UserPersona {
  enabled: boolean;
  name: string;
  species: string;
  pronouns: string;
  appearance: string;
  personality: string;
  background: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  disabled: boolean;
  timezone: string;
  createdAt: string;
  emailVerifiedAt: string | null;
  avatar: string;
  persona?: UserPersona;
  limit5h: number;
  limit7d: number;
  characterSlots: number;
}

export interface Character {
  id: string;
  ownerId: string | null;
  name: string;
  slug: string;
  description: string;
  avatar: string;
  color: string;
  tags: string[];
  personality?: string;
  greeting: string;
  providerId?: string | null;
  active: boolean;
  createdAt: string;
}

export interface ConversationCharacter extends Character {
  imageInput?: boolean;
}

export interface SlotsInfo {
  used: number;
  limit: number;
  remaining: number;
}

export interface ModelOption {
  id: string;
  name: string;
}

export interface UserCharacters {
  items: Character[];
  slots: SlotsInfo;
  models: ModelOption[];
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

export interface Attachment {
  id: string;
  mime: string;
  width: number;
  height: number;
  size: number;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  characterId: string | null;
  content: string;
  createdAt: string;
  attachments?: Attachment[];
}

export type MemoryKind =
  | 'note'
  | 'fact'
  | 'preference'
  | 'relationship'
  | 'event'
  | 'plan'
  | 'summary';

export interface Memory {
  id: string;
  userId: string;
  characterId: string;
  characterName?: string;
  characterAvatar?: string;
  characterColor?: string;
  content: string;
  source: 'manual' | 'auto';
  kind: MemoryKind;
  importance: number;
  status: 'active' | 'archived';
  accessCount: number;
  lastAccessedAt: string | null;
  expiresAt: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  vectorStatus?: string;
}

export interface MemoryRecallResult {
  id: string;
  content: string;
  kind: MemoryKind;
  importance: number;
  score: number;
  relevance: number;
  routes: string[];
}

export interface EmbeddingConfig {
  modelId: string;
  supplierId: string;
  supplierName?: string;
  supplierActive: boolean;
  protocol: string;
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
  defaultCharacterSlots: number;
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
  streamingEnabled: boolean;
  imageInputEnabled: boolean;
  maxImagesPerMessage: number;
  actionStyleEnabled: boolean;
  actionMarkers: string[];
  actionHideMarkers: boolean;
  memoryStructuredExtraction: boolean;
  memoryRecallTopK: number;
  memoryKeywordWeight: number;
  memoryDecayRate: number;
  memoryArchiveThreshold: number;
}

export interface Bootstrap {
  user: User | null;
  characters: Character[];
  conversations: Conversation[];
  announcements: Announcement[];
  quota: QuotaSnapshot | null;
  settings: PlatformSettings;
  stats: {
    conversations: number;
    messages: number;
    memories: number;
  };
}

export interface ConversationDetail {
  conversation: Conversation;
  characters: ConversationCharacter[];
  messages: Message[];
  hasMore?: boolean;
}

export interface AdminOverview {
  users: number;
  characters: number;
  conversations: number;
  calls: number;
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

export interface MailDelivery {
  id: string;
  kind: string;
  status: string;
  recipient: string;
  smtpHost: string;
  smtpPort: number;
  fromEmail: string;
  stage: string;
  code: string | null;
  command: string | null;
  smtpCode: number | null;
  enhancedStatus: string | null;
  response: string | null;
  summary: string;
  hint: string;
  createdAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface MailDeliveryList {
  items: MailDelivery[];
  total: number;
  page: number;
  pageSize: number;
  retentionDays: number;
}

export interface RequestAudit {
  id: string;
  kind: string;
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
  status: string;
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

export type ChatEvent =
  | { type: 'user'; message: Message }
  | { type: 'status'; text: string; characterId?: string }
  | { type: 'stream-start'; streamId: string; characterId: string }
  | { type: 'delta'; streamId: string; text: string }
  | { type: 'stream-end'; streamId: string }
  | { type: 'message'; message: Message; streamId?: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; quota: QuotaSnapshot; rounds: number; limited: boolean };
