export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path.startsWith('/api/') ? path : `/api${path}`, {
      ...options,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('连接暂时中断，请检查网络后重试。', 'NETWORK', 0);
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result || result.error)
    throw new ApiError(
      result?.error?.message || '服务暂时不可用，请稍后重试。',
      result?.error?.code || 'SERVER_ERROR',
      response.status,
    );
  return result.data as T;
}
export function json(method: string, data?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  };
}
export function dateLabel(value: string, options?: Intl.DateTimeFormatOptions) {
  return new Date(value).toLocaleDateString('zh-CN', options || { month: 'long', day: 'numeric' });
}

/** randomUUID requires HTTPS; getRandomValues also works on a local HTTP network. */
export function newRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function copyText(content: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(content);
    return;
  }
  const field = document.createElement('textarea');
  const previous = document.activeElement as HTMLElement | null;
  field.value = content;
  field.readOnly = true;
  field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.append(field);
  try {
    field.focus({ preventScroll: true });
    field.select();
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
  } finally {
    field.remove();
    previous?.focus({ preventScroll: true });
  }
}
