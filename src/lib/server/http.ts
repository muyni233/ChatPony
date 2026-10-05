import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { getDb } from './db';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'REQUEST_FAILED',
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, extraHeaders?: HeadersInit) {
  const headers = new Headers(extraHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(JSON.stringify(data), { status, headers });
}

export function errorResponse(error: unknown) {
  if (error instanceof HttpError)
    return json({ error: { message: error.message, code: error.code } }, error.status);
  // Never send database errors, upstream response bodies, secrets, or stack traces to clients.
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code.startsWith('SQLITE_CONSTRAINT'))
    return json(
      { error: { message: '数据已存在或仍被使用，请检查后重试。', code: 'CONFLICT' } },
      409,
    );
  return json(
    { error: { message: '服务器暂时无法处理请求，请稍后重试。', code: 'INTERNAL_ERROR' } },
    500,
  );
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.includes('application/json'))
    throw new HttpError(415, '请使用 JSON 格式提交。', 'CONTENT_TYPE');
  const reader = request.body?.getReader();
  if (!reader) return {};
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65_536) {
      await reader.cancel();
      throw new HttpError(413, '提交内容过长，请缩短后重试。', 'BODY_TOO_LARGE');
    }
    chunks.push(value);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, '提交内容不是有效的 JSON 对象。', 'INVALID_JSON');
  }
}

export function textField(
  body: Record<string, unknown>,
  field: string,
  max: number,
  min = 0,
  fallback?: string,
): string {
  const value = body[field] === undefined && fallback !== undefined ? fallback : body[field];
  if (typeof value !== 'string' || value.trim().length < min || value.length > max)
    throw new HttpError(400, `${field} 内容不符合要求（${min}–${max} 字符）。`, 'VALIDATION_ERROR');
  return value.trim();
}

export function booleanField(body: Record<string, unknown>, field: string, fallback: boolean) {
  if (body[field] === undefined) return fallback;
  if (typeof body[field] !== 'boolean')
    throw new HttpError(400, `${field} 必须为是或否。`, 'VALIDATION_ERROR');
  return body[field];
}

export function numberField(
  body: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
  fallback: number,
  integer = false,
) {
  const value = body[field] === undefined ? fallback : body[field];
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  )
    throw new HttpError(400, `${field} 应在 ${min}–${max} 之间。`, 'VALIDATION_ERROR');
  return value;
}

export function assertSameOrigin(request: Request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.headers.get('origin');
  const invalid = () =>
    new HttpError(403, '请求来源验证失败，请刷新页面后重试。', 'INVALID_ORIGIN');
  if (!origin || request.headers.get('sec-fetch-site') === 'cross-site') throw invalid();
  try {
    const requestUrl = new URL(request.url);
    const originUrl = new URL(origin);
    // The configured siteUrl is for mail links, never a CSRF allowlist. Otherwise
    // a typo locks out the administrator and can allow an unrelated Origin.
    // Next may expose its bind address in request.url, so use the actual Host.
    // A TLS proxy must preserve Host and overwrite X-Forwarded-Proto: Next uses
    // that header to build request.url. Never infer the protocol from Origin.
    const host = request.headers.get('host') ?? requestUrl.host;
    if (
      !['http:', 'https:'].includes(requestUrl.protocol) ||
      !['http:', 'https:'].includes(originUrl.protocol) ||
      origin !== originUrl.origin ||
      !host ||
      /[\s/@\\?#,%]/.test(host)
    )
      throw invalid();
    const expected = new URL(`${requestUrl.protocol}//${host}`).origin;
    if (origin !== expected) throw invalid();
  } catch {
    throw invalid();
  }
}

export function fingerprint(request: Request) {
  // Forwarded IPs are trusted only after an administrator explicitly confirms
  // the reverse proxy overwrites this header, never just because it is present.
  const saved = getDb().prepare("SELECT value FROM settings WHERE key='site'").get() as
    { value: string } | undefined;
  const trusted =
    saved && (JSON.parse(saved.value) as { trustProxy?: boolean }).trustProxy === true;
  const forwarded = trusted
    ? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    : undefined;
  const address = forwarded && isIP(forwarded) ? forwarded : 'shared';
  if (address === 'shared') return address;
  return createHash('sha256').update(address).digest('hex').slice(0, 24);
}

export function anonymousRateLimit(
  request: Request,
  name: string,
  perIp: number,
  windowMs: number,
) {
  const identity = fingerprint(request);
  rateLimit(`${name}:${identity}`, identity === 'shared' ? 1000 : perIp, windowMs);
}

export function rateLimit(key: string, limit: number, windowMs: number) {
  const db = getDb();
  const timestamp = Date.now();
  db.prepare('DELETE FROM rate_limits WHERE expires_at < ?').run(timestamp);
  const row = db
    .prepare(
      `INSERT INTO rate_limits(key, hits, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET hits = hits + 1 RETURNING hits`,
    )
    .get(key, timestamp + windowMs) as { hits: number };
  if (row.hits > limit) throw new HttpError(429, '操作太频繁，请稍后再试。', 'RATE_LIMITED');
}
