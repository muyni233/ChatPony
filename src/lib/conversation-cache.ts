import { api } from './client';
import type { ConversationDetail } from './types';

/** Newest messages loaded when a conversation opens; older pages load on scroll. */
export const MESSAGE_PAGE_SIZE = 60;
const MAX_ENTRIES = 24;
const FRESH_MS = 20_000;

type Entry = { detail: ConversationDetail; at: number };
const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<ConversationDetail>>();
const key = (userId: string, conversationId: string) => `${userId}:${conversationId}`;

/** A previously opened (or prefetched) conversation, shown instantly while it revalidates. */
export function cachedConversation(
  userId: string,
  conversationId: string,
): ConversationDetail | null {
  const entry = entries.get(key(userId, conversationId));
  if (!entry) return null;
  // Refresh LRU position.
  entries.delete(key(userId, conversationId));
  entries.set(key(userId, conversationId), entry);
  return entry.detail;
}

export function storeConversation(
  userId: string,
  conversationId: string,
  detail: ConversationDetail,
): void {
  entries.delete(key(userId, conversationId));
  entries.set(key(userId, conversationId), { detail, at: Date.now() });
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
}

export function forgetConversation(userId: string, conversationId: string): void {
  entries.delete(key(userId, conversationId));
}

/** Deduplicates concurrent loads, so a hover prefetch and the page open share one request. */
export function fetchConversation(
  userId: string,
  conversationId: string,
): Promise<ConversationDetail> {
  const cacheKey = key(userId, conversationId);
  const running = inflight.get(cacheKey);
  if (running) return running;
  const request = api<ConversationDetail>(
    `/conversations/${conversationId}?limit=${MESSAGE_PAGE_SIZE}`,
  )
    .then((detail) => {
      storeConversation(userId, conversationId, detail);
      return detail;
    })
    .finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, request);
  return request;
}

/** Call on hover, focus or touch of a conversation link. Failures are silent. */
export function prefetchConversation(userId: string | undefined, conversationId: string): void {
  if (!userId) return;
  const entry = entries.get(key(userId, conversationId));
  if (entry && Date.now() - entry.at < FRESH_MS) return;
  void fetchConversation(userId, conversationId).catch(() => undefined);
}
