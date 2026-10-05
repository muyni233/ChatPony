export type Role = 'user' | 'admin';
export type Protocol = 'anthropic' | 'openai-chat' | 'openai-responses' | 'gemini';
export interface User {
  id: string;
  username: string;
  email: string;
  role: Role;
  createdAt: string;
  disabled?: boolean;
}
export interface Character {
  id: string;
  name: string;
  englishName: string;
  subtitle: string;
  description: string;
  personality: string;
  greeting: string;
  color: string;
  avatar: string;
  tags: string[];
  published: boolean;
  order: number;
}
export interface Provider {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
  enabled: boolean;
  isDefault: boolean;
  hasApiKey: boolean;
}
export interface Conversation {
  id: string;
  title: string;
  kind: 'direct' | 'group';
  characterIds: string[];
  scene: string;
  providerId: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessage?: string;
  lastMessageRole?: 'user' | 'assistant';
  summary?: string;
}
export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  characterId: string | null;
  content: string;
  createdAt: string;
}
export interface Memory {
  id: string;
  characterId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}
export interface QuotaWindow {
  enabled: boolean;
  limit: number;
  used: number;
  reserved: number;
  remaining: number | null;
  resetsAt: string | null;
}
export interface QuotaStatus {
  fiveHour: QuotaWindow;
  oneDay: QuotaWindow;
  sevenDay: QuotaWindow;
}
export type AuditStatus = 'pending' | 'success' | 'error' | 'cancelled' | 'rejected' | 'replayed';
export interface AuditEntry {
  id: string;
  time: string;
  finishedAt: string | null;
  status: AuditStatus;
  userId: string;
  username: string;
  conversationId: string;
  conversationTitle: string;
  kind: 'direct' | 'group';
  providerId: string | null;
  providerName: string | null;
  protocol: Protocol | null;
  model: string | null;
  characterNames: string[];
  durationMs: number | null;
  replyCount: number;
  outputCharacters: number;
  quotaCharged: 0 | 1;
  errorCode: string | null;
  errorMessage: string | null;
}
export interface AuditStats {
  requests: number;
  success: number;
  error: number;
  cancelled: number;
  rejected: number;
  replayed: number;
  pending: number;
  chargedTurns: number;
  replies: number;
  averageDurationMs: number;
  daily: { date: string; requests: number; success: number; error: number }[];
  timeZone: 'UTC';
}
export interface AuditResponse {
  entries: { items: AuditEntry[]; total: number; page: number; pageSize: number };
  stats: AuditStats;
  filters: { days: number; status: AuditStatus | 'all'; query: string };
  retentionDays: number;
}
export interface ConversationDetail {
  conversation: Conversation;
  messages: Message[];
  characters: Character[];
}
export type ChatEvent =
  | { type: 'user'; message: Message }
  | { type: 'start'; characterId: string; messageId: string }
  | { type: 'delta'; text: string; characterId: string; messageId: string }
  | { type: 'message'; message: Message }
  | { type: 'status'; message: string }
  | { type: 'done' }
  | { type: 'error'; message: string; code?: string };
