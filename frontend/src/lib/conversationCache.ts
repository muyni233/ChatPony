import type { ConversationDetail } from './types';

const MAX_CACHE = 12;
const cache = new Map<string, ConversationDetail>();

export function getCachedConversation(id: string): ConversationDetail | undefined {
  const item = cache.get(id);
  if (!item) return undefined;
  // Refresh LRU order
  cache.delete(id);
  cache.set(id, item);
  return item;
}

export function setCachedConversation(id: string, detail: ConversationDetail): void {
  if (cache.has(id)) {
    cache.delete(id);
  }
  cache.set(id, detail);
  if (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
}

export function deleteCachedConversation(id: string): void {
  cache.delete(id);
}

export function clearConversationCache(): void {
  cache.clear();
}
