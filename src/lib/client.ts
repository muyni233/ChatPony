import type { ChatEvent } from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (
      response.status === 401 &&
      data?.error?.code === 'UNAUTHORIZED' &&
      typeof window !== 'undefined'
    )
      window.dispatchEvent(new Event('chatpony:unauthorized'));
    throw new ApiError(
      data?.error?.message || data?.error || '请求失败，请稍后重试。',
      response.status,
      data?.error?.code,
    );
  }
  return data as T;
}

export async function streamChat(
  path: string,
  body: object,
  onEvent: (event: ChatEvent) => void,
  signal: AbortSignal,
) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    if (response.status === 401 && data?.error?.code === 'UNAUTHORIZED')
      window.dispatchEvent(new Event('chatpony:unauthorized'));
    throw new ApiError(
      data?.error?.message || '暂时无法发送消息，请稍后重试。',
      response.status,
      data?.error?.code,
    );
  }
  if (!response.body) throw new Error('连接未返回内容。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let doneReceived = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, '\n');
      let index: number;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const payload = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!payload || payload === '[DONE]') continue;
        const event = JSON.parse(payload) as ChatEvent;
        if (event.type === 'done' || event.type === 'error') doneReceived = true;
        onEvent(event);
      }
      if (done) break;
    }
    if (!doneReceived) throw new Error('连接意外中断。已保存的消息仍会保留，请重试。');
  } finally {
    reader.releaseLock();
  }
}

export function announceConversationChange() {
  window.dispatchEvent(new Event('chatpony:conversations'));
}
export function relativeDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}
