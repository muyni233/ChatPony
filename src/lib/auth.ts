import { createHash, randomBytes } from 'node:crypto';
import { getDb, id, now } from './db';
import { AppError } from './errors';
import { toUser, type Row } from './mappers';
import type { User } from './types';
import { assertRegistrationAllowed, normalizeEmail } from './email-policy';
import { checkVerificationChallenge } from './mail';

export const SESSION_COOKIE = 'chatpony_session';
const SESSION_AGE = 30 * 24 * 60 * 60;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function assertMutationRequest(request: Request): void {
  const contentType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json')
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', '写入请求需使用 application/json 格式。');
  if (request.headers.get('sec-fetch-site')?.trim().toLowerCase() === 'cross-site')
    throw new AppError(403, 'CROSS_SITE_REQUEST', '不支持浏览器跨站写入请求。');
}

function tokenFrom(request: Request): string | null {
  const cookies = request.headers.get('cookie')?.split(';') ?? [];
  const value = cookies
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export function currentUser(request: Request): User | null {
  const token = tokenFrom(request);
  if (!token) return null;
  const row = getDb()
    .query(
      'SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0',
    )
    .get(digest(token), now()) as Row | null;
  return row ? toUser(row) : null;
}

export function requireUser(request: Request): User {
  const user = currentUser(request);
  if (!user) throw new AppError(401, 'UNAUTHORIZED', '请先登录后继续。');
  return user;
}

export function requireAdmin(request: Request): User {
  const user = requireUser(request);
  if (user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', '只有管理员可以执行此操作。');
  return user;
}

function cookie(value: string, maxAge: number, request?: Request): string {
  // HTTPS cookies follow the actual transport, including explicitly trusted TLS proxies.
  // NODE_ENV describes the build, not whether a browser is visiting this site over TLS.
  const secure = request
    ? new URL(request.url).protocol === 'https:' ||
      (process.env.TRUST_PROXY === 'true' &&
        request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase() === 'https')
    : false;
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function createSession(userId: string, request?: Request): string {
  const token = randomBytes(32).toString('base64url');
  const timestamp = now();
  const db = getDb();
  db.transaction(() => {
    const user = db.query('SELECT disabled FROM users WHERE id=?').get(userId) as Row | null;
    if (!user || user.disabled) throw new AppError(403, 'ACCOUNT_DISABLED', '此账号当前不可用。');
    db.query('DELETE FROM sessions WHERE expires_at<=?').run(timestamp);
    db.query(
      'DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 9)',
    ).run(userId, userId);
    db.query('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(
      digest(token),
      userId,
      timestamp,
      new Date(Date.parse(timestamp) + SESSION_AGE * 1000).toISOString(),
    );
  }).immediate();
  return cookie(token, SESSION_AGE, request);
}

export function destroySession(request: Request): string {
  const token = tokenFrom(request);
  if (token) getDb().query('DELETE FROM sessions WHERE token_hash=?').run(digest(token));
  return cookie('', 0, request);
}

export function revokeSessions(userId: string): void {
  getDb().query('DELETE FROM sessions WHERE user_id=?').run(userId);
}

/** Persistent limits remain effective across server restarts. Proxy headers are opt-in. */
export function rateLimit(
  request: Request,
  operation: string,
  max: number,
  windowMs: number,
  identity = '',
): void {
  const address =
    process.env.TRUST_PROXY === 'true'
      ? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim().slice(0, 80) || 'direct'
      : 'direct';
  const key = digest(`${operation}:${identity || address}`);
  const db = getDb();
  const allowed = db
    .transaction(() => {
      const timestamp = now();
      db.query('DELETE FROM rate_limits WHERE expires_at<=?').run(timestamp);
      const row = db.query('SELECT * FROM rate_limits WHERE key=?').get(key) as Row | null;
      if (row && Number(row.attempts) >= max) return false;
      db.query(
        'INSERT INTO rate_limits(key,attempts,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1',
      ).run(key, new Date(Date.parse(timestamp) + windowMs).toISOString());
      return true;
    })
    .immediate();
  if (!allowed) throw new AppError(429, 'RATE_LIMITED', '操作过于频繁，请稍后重试。');
}

export function validName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 60)
    throw new AppError(400, 'VALIDATION_ERROR', '昵称须为 1–60 个字符。');
  return value.trim();
}

export function validEmail(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  )
    throw new AppError(400, 'VALIDATION_ERROR', '请输入有效的电子邮箱。');
  return value.trim().toLowerCase();
}

export function validPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128)
    throw new AppError(400, 'VALIDATION_ERROR', '密码须为 10–128 个字符。');
  return value;
}

export async function register(request: Request, input: Record<string, unknown>): Promise<User> {
  rateLimit(request, 'register', 30, 60 * 60 * 1000);
  const name = validName(input.name);
  const email = normalizeEmail(input.email);
  const password = validPassword(input.password);
  const db = getDb();
  const policy = assertRegistrationAllowed(email);
  if (
    policy.requireEmailVerification &&
    (typeof input.verificationCode !== 'string' || !/^\d{6}$/.test(input.verificationCode))
  )
    throw new AppError(400, 'VERIFICATION_REQUIRED', '请输入邮件中的 6 位验证码。');
  if (db.query('SELECT id FROM users WHERE email=?').get(email))
    throw new AppError(409, 'EMAIL_EXISTS', '此邮箱已注册，请直接登录。');
  const passwordHash = await Bun.password.hash(password, {
    algorithm: 'argon2id',
    memoryCost: 19456,
    timeCost: 2,
  });
  const result = db
    .transaction(() => {
      const currentPolicy = assertRegistrationAllowed(email);
      if (db.query('SELECT id FROM users WHERE email=?').get(email))
        throw new AppError(409, 'EMAIL_EXISTS', '此邮箱已注册，请直接登录。');
      if (currentPolicy.requireEmailVerification) {
        const error = checkVerificationChallenge(email, input.verificationCode);
        if (error) return { error };
      }
      const setting = (key: string) =>
        Number((db.query('SELECT value FROM settings WHERE key=?').get(key) as Row).value);
      const userId = id();
      db.query(
        'INSERT INTO users(id,email,name,password_hash,limit_5h,limit_7d,created_at,email_verified_at) VALUES(?,?,?,?,?,?,?,?)',
      ).run(
        userId,
        email,
        name,
        passwordHash,
        setting('defaultLimit5h'),
        setting('defaultLimit7d'),
        now(),
        currentPolicy.requireEmailVerification ? now() : null,
      );
      db.query('DELETE FROM registration_challenges WHERE email=?').run(email);
      return { user: toUser(db.query('SELECT * FROM users WHERE id=?').get(userId) as Row) };
    })
    .immediate();
  if (result.error) throw result.error;
  return result.user!;
}

let dummyPasswordHash: Promise<string> | undefined;
export async function login(
  request: Request,
  input: Record<string, unknown>,
): Promise<{ user: User; sessionCookie: string }> {
  const email = validEmail(input.email);
  let canonicalEmail = email;
  try {
    canonicalEmail = normalizeEmail(email);
  } catch {
    /* Preserve login for previously accepted account formats. */
  }
  if (typeof input.password !== 'string' || input.password.length > 128 || !input.password)
    throw new AppError(400, 'VALIDATION_ERROR', '请输入密码。');
  rateLimit(request, 'login-client', 120, 15 * 60 * 1000);
  rateLimit(request, 'login-account', 10, 15 * 60 * 1000, canonicalEmail);
  const row = getDb()
    .query(
      'SELECT * FROM users WHERE email=? OR email=? ORDER BY CASE WHEN email=? THEN 0 ELSE 1 END LIMIT 1',
    )
    .get(email, canonicalEmail, email) as Row | null;
  dummyPasswordHash ??= Bun.password.hash(randomBytes(32).toString('base64'), {
    algorithm: 'argon2id',
    memoryCost: 19456,
    timeCost: 2,
  });
  const hash = row ? String(row.password_hash) : await dummyPasswordHash;
  const valid = await Bun.password.verify(input.password, hash);
  if (!row || !valid || row.disabled)
    throw new AppError(401, 'INVALID_CREDENTIALS', '邮箱或密码不正确，或账号当前不可用。');
  return getDb()
    .transaction(() => {
      const fresh = getDb()
        .query('SELECT * FROM users WHERE id=?')
        .get(String(row.id)) as Row | null;
      if (!fresh || fresh.disabled || fresh.password_hash !== hash)
        throw new AppError(401, 'INVALID_CREDENTIALS', '邮箱或密码不正确，或账号当前不可用。');
      return { user: toUser(fresh), sessionCookie: createSession(String(fresh.id), request) };
    })
    .immediate();
}
