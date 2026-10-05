import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { domainToASCII } from 'node:url';
import type { User } from '@/lib/types';
import { getDb, now, transaction } from './db';
import { anonymousRateLimit, HttpError, json, rateLimit, readBody, textField } from './http';
import { assertMailerConfigured, getSettings, sendMail } from './settings';

const scryptAsync = promisify(scrypt);
const COOKIE = 'chatpony_session';
const SESSION_DAYS = 30;
type UserRow = {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  role: 'user' | 'admin';
  disabled: number;
  email_verified: number;
  created_at: string;
};

export function safeUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    disabled: !!row.disabled,
    createdAt: row.created_at,
  };
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, salt, hex] = encoded.split(':');
  if (algorithm !== 'scrypt' || !salt || !hex || hex.length !== 128) return false;
  const result = (await scryptAsync(password, salt, 64)) as Buffer;
  return timingSafeEqual(result, Buffer.from(hex, 'hex'));
}

export function validatePassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128)
    throw new HttpError(400, '密码需要 10–128 个字符。', 'INVALID_PASSWORD');
  return value;
}

function validateEmail(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  )
    throw new HttpError(400, '请输入有效的邮箱地址。', 'INVALID_EMAIL');
  return value.trim().toLowerCase();
}

function tokenHash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
function sessionToken(request: Request) {
  return (
    request.headers
      .get('cookie')
      ?.split(';')
      .map((item) => item.trim())
      .find((item) => item.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1) || ''
  );
}

export function sessionCookie(token: string, days = SESSION_DAYS) {
  const secure = process.env.NODE_ENV === 'production';
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${days * 86400}${secure ? '; Secure' : ''}`;
}

export function currentUser(request: Request): User | null {
  const token = sessionToken(request);
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const row = getDb()
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0 AND u.email_verified=1`,
    )
    .get(tokenHash(token), now()) as UserRow | undefined;
  return row ? safeUser(row) : null;
}

export function requireUser(request: Request): User {
  const user = currentUser(request);
  if (!user) throw new HttpError(401, '请先登录后继续。', 'UNAUTHORIZED');
  return user;
}

export function requireAdmin(request: Request) {
  const user = requireUser(request);
  if (user.role !== 'admin') throw new HttpError(403, '此操作需要管理员权限。', 'FORBIDDEN');
  return user;
}

function startSession(userId: string) {
  const db = getDb();
  const token = randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
  // Keep a bounded number of devices per account.
  db.prepare(
    'DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 9)',
  ).run(userId);
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)').run(
    tokenHash(token),
    userId,
    new Date(Date.now() + SESSION_DAYS * 86400000).toISOString(),
    now(),
  );
  return token;
}

export async function register(request: Request) {
  anonymousRateLimit(request, 'register', 20, 3600000);
  const body = await readBody(request);
  const username = textField(body, 'username', 32, 2);
  const email = validateEmail(body.email);
  rateLimit(`register-account:${tokenHash(email)}`, 5, 3600000);
  const password = validatePassword(body.password);
  const db = getDb();
  if (db.prepare('SELECT id FROM users WHERE email=? OR username=?').get(email, username))
    throw new HttpError(409, '邮箱或用户名已被使用。', 'ACCOUNT_EXISTS');
  const id = randomUUID();
  const encoded = await hashPassword(password);
  const verificationRequired = transaction(() => {
    // Serializing the count and insert makes the initial administrator unique,
    // even if two registration requests finish hashing at the same time.
    const first = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n === 0;
    const settings = getSettings();
    if (!first && !settings.registrationEnabled)
      throw new HttpError(403, '当前暂未开放注册。', 'REGISTRATION_CLOSED');
    if (
      !first &&
      settings.allowedEmailDomains.length &&
      !settings.allowedEmailDomains.includes(domainToASCII(email.slice(email.lastIndexOf('@') + 1)))
    )
      throw new HttpError(
        400,
        '此邮箱域名暂不在本站允许的注册范围内，请使用页面所列域名的邮箱。',
        'EMAIL_DOMAIN_NOT_ALLOWED',
      );
    const verify = !first && settings.requireEmailVerification;
    if (verify) assertMailerConfigured();
    try {
      db.prepare(
        'INSERT INTO users(id,username,email,password_hash,role,email_verified,created_at) VALUES (?,?,?,?,?,?,?)',
      ).run(id, username, email, encoded, first ? 'admin' : 'user', verify ? 0 : 1, now());
    } catch {
      throw new HttpError(409, '邮箱或用户名已被使用。', 'ACCOUNT_EXISTS');
    }
    return verify;
  });
  const row = db.prepare('SELECT * FROM users WHERE id=?').get(id) as UserRow;
  if (verificationRequired) {
    await sendVerification(row);
    return json(
      { user: null, verificationRequired: true, message: '验证邮件已发送，请完成邮箱验证后登录。' },
      201,
    );
  }
  return json({ user: safeUser(row) }, 201, { 'Set-Cookie': sessionCookie(startSession(id)) });
}

export async function login(request: Request) {
  const body = await readBody(request);
  const email = validateEmail(body.email);
  const password =
    typeof body.password === 'string' && body.password.length <= 128 ? body.password : '';
  anonymousRateLimit(request, 'login-ip', 100, 900000);
  rateLimit(`login-account:${tokenHash(email)}`, 10, 900000);
  const row = getDb().prepare('SELECT * FROM users WHERE email=?').get(email) as
    UserRow | undefined;
  // A fixed dummy derivation also runs for nonexistent accounts.
  const valid = await verifyPassword(
    password,
    row?.password_hash || `scrypt:00000000000000000000000000000000:${'0'.repeat(128)}`,
  );
  if (!valid || !row)
    throw new HttpError(401, '邮箱或密码不正确，或账号暂不可用。', 'INVALID_CREDENTIALS');
  const authenticated = transaction(() => {
    // Password hashing yields to other requests. A reset or email change during
    // that interval must invalidate this login rather than issue a new session.
    const latest = getDb().prepare('SELECT * FROM users WHERE id=?').get(row.id) as
      UserRow | undefined;
    if (
      !latest ||
      latest.disabled ||
      latest.password_hash !== row.password_hash ||
      latest.email !== email
    )
      throw new HttpError(401, '邮箱或密码不正确，或账号暂不可用。', 'INVALID_CREDENTIALS');
    if (!latest.email_verified)
      throw new HttpError(
        403,
        '请先通过注册邮件验证邮箱；若邮件未收到，可以重新发送验证邮件。',
        'EMAIL_NOT_VERIFIED',
      );
    return { user: safeUser(latest), token: startSession(latest.id) };
  });
  return json({ user: authenticated.user }, 200, {
    'Set-Cookie': sessionCookie(authenticated.token),
  });
}

export function logout(request: Request) {
  getDb()
    .prepare('DELETE FROM sessions WHERE token_hash=?')
    .run(tokenHash(sessionToken(request)));
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}

export async function updateProfile(request: Request) {
  requireUser(request);
  const body = await readBody(request);
  const user = requireUser(request);
  const email = body.email === undefined ? undefined : validateEmail(body.email);
  const row = getDb().prepare('SELECT * FROM users WHERE id=?').get(user.id) as UserRow | undefined;
  if (!row) throw new HttpError(401, '登录信息已变化，请重新登录后修改资料。', 'UNAUTHORIZED');
  const changesEmail = email !== undefined && email !== row.email;
  if (
    changesEmail &&
    !(await verifyPassword(
      typeof body.currentPassword === 'string' ? body.currentPassword.slice(0, 128) : '',
      row.password_hash,
    ))
  )
    throw new HttpError(400, '修改邮箱需要验证当前密码。', 'PASSWORD_REQUIRED');
  const updated = transaction(() => {
    requireUser(request);
    const latest = getDb().prepare('SELECT * FROM users WHERE id=?').get(user.id) as
      UserRow | undefined;
    if (!latest || latest.password_hash !== row.password_hash || latest.email !== row.email)
      throw new HttpError(401, '登录信息已变化，请重新登录后修改资料。', 'UNAUTHORIZED');
    const username = textField(body, 'username', 32, 2, latest.username);
    if (
      changesEmail &&
      getDb().prepare('SELECT id FROM users WHERE email=? AND id<>?').get(email!, user.id)
    )
      throw new HttpError(409, '此邮箱已被使用。', 'ACCOUNT_EXISTS');
    if (changesEmail) {
      rateLimit(`email-change-user:${user.id}`, 10, 3600000);
      rateLimit(`email-change-target:${tokenHash(email!)}`, 5, 3600000);
    }
    try {
      getDb().prepare('UPDATE users SET username=? WHERE id=?').run(username, user.id);
    } catch {
      throw new HttpError(409, '邮箱或用户名已被使用。', 'ACCOUNT_EXISTS');
    }
    // Authorize and create the email-change token in the same transaction.
    // A subsequent password rotation then revokes it, even while SMTP is pending.
    const verification = changesEmail ? prepareVerification(latest, email) : null;
    return { user: safeUser({ ...latest, username }), verification };
  });
  if (updated.verification) {
    await deliverVerification(updated.verification);
    // Do not perform account writes or return an authenticated snapshot after
    // an SMTP await when another request has revoked this original session.
    requireUser(request);
  }
  return json({
    user: updated.user,
    verificationRequired: changesEmail,
    message: changesEmail ? '已向新邮箱发送验证邮件，验证完成后将更新邮箱。' : undefined,
  });
}

export async function changePassword(request: Request) {
  const user = requireUser(request);
  rateLimit(`password:${user.id}`, 6, 900000);
  const body = await readBody(request);
  requireUser(request);
  const row = getDb().prepare('SELECT * FROM users WHERE id=?').get(user.id) as UserRow | undefined;
  if (!row) throw new HttpError(401, '登录信息已变化，请重新登录后修改密码。', 'UNAUTHORIZED');
  if (
    !(await verifyPassword(
      typeof body.currentPassword === 'string' ? body.currentPassword.slice(0, 128) : '',
      row.password_hash,
    ))
  )
    throw new HttpError(400, '当前密码不正确。', 'INVALID_PASSWORD');
  const encoded = await hashPassword(validatePassword(body.newPassword));
  const token = transaction(() => {
    // Recheck the original session and credentials after both async derivations.
    // Session rotation shares this transaction, including across Node workers.
    requireUser(request);
    const latest = getDb().prepare('SELECT password_hash FROM users WHERE id=?').get(user.id) as
      { password_hash: string } | undefined;
    if (!latest || latest.password_hash !== row.password_hash)
      throw new HttpError(401, '登录信息已变化，请重新登录后修改密码。', 'UNAUTHORIZED');
    getDb().prepare('UPDATE users SET password_hash=? WHERE id=?').run(encoded, user.id);
    getDb().prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    getDb().prepare('DELETE FROM reset_tokens WHERE user_id=?').run(user.id);
    getDb().prepare('DELETE FROM verification_tokens WHERE user_id=?').run(user.id);
    return startSession(user.id);
  });
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token) });
}

export async function forgotPassword(request: Request) {
  anonymousRateLimit(request, 'forgot', 10, 3600000);
  const settings = assertMailerConfigured();
  const body = await readBody(request);
  const email = validateEmail(body.email);
  rateLimit(`forgot-account:${tokenHash(email)}`, 3, 3600000);
  const row = getDb().prepare('SELECT * FROM users WHERE email=? AND disabled=0').get(email) as
    UserRow | undefined;
  if (row) {
    const token = randomBytes(32).toString('hex');
    const url = new URL('/reset-password', settings.siteUrl);
    url.searchParams.set('token', token);
    transaction(() => {
      getDb()
        .prepare('DELETE FROM reset_tokens WHERE user_id=? OR expires_at<=?')
        .run(row.id, now());
      getDb()
        .prepare('INSERT INTO reset_tokens(token_hash,user_id,expires_at) VALUES (?,?,?)')
        .run(tokenHash(token), row.id, new Date(Date.now() + 30 * 60000).toISOString());
    });
    try {
      await sendMail(
        email,
        '重置你的 ChatPony 密码',
        `请通过以下链接重置密码，链接将在 30 分钟后失效。\n\n${url.toString()}\n\n如非本人操作，请忽略此邮件。`,
      );
    } catch {
      getDb().prepare('DELETE FROM reset_tokens WHERE token_hash=?').run(tokenHash(token));
      throw new HttpError(502, '重置邮件暂时无法发送，请稍后重试。', 'MAIL_DELIVERY_FAILED');
    }
  }
  return json({ ok: true, message: '如果该邮箱已注册，将收到重置密码邮件。' });
}

function prepareVerification(user: UserRow, newEmail?: string) {
  const settings = assertMailerConfigured();
  const token = randomBytes(32).toString('hex');
  const url = new URL('/verify-email', settings.siteUrl);
  url.searchParams.set('token', token);
  getDb().prepare('DELETE FROM verification_tokens WHERE user_id=?').run(user.id);
  getDb()
    .prepare(
      'INSERT INTO verification_tokens(token_hash,user_id,expires_at,new_email) VALUES (?,?,?,?)',
    )
    .run(
      tokenHash(token),
      user.id,
      new Date(Date.now() + 24 * 3600000).toISOString(),
      newEmail || null,
    );
  return {
    to: newEmail || user.email,
    subject: `验证你的 ${settings.siteName} 邮箱`,
    text: `请通过以下链接验证邮箱，链接将在 24 小时后失效。\n\n${url.toString()}\n\n如非本人操作，请忽略此邮件。`,
    tokenHash: tokenHash(token),
  };
}

async function deliverVerification(verification: ReturnType<typeof prepareVerification>) {
  try {
    await sendMail(verification.to, verification.subject, verification.text);
  } catch (error) {
    // Delete only this failed attempt, never a newer verification link.
    getDb()
      .prepare('DELETE FROM verification_tokens WHERE token_hash=?')
      .run(verification.tokenHash);
    throw error;
  }
}

async function sendVerification(user: UserRow, newEmail?: string) {
  const verification = transaction(() => prepareVerification(user, newEmail));
  await deliverVerification(verification);
}

export async function resendVerification(request: Request) {
  anonymousRateLimit(request, 'verify-resend', 10, 3600000);
  assertMailerConfigured();
  const email = validateEmail((await readBody(request)).email);
  rateLimit(`verify-resend-account:${tokenHash(email)}`, 3, 3600000);
  const row = getDb()
    .prepare('SELECT * FROM users WHERE email=? AND email_verified=0 AND disabled=0')
    .get(email) as UserRow | undefined;
  if (row) await sendVerification(row);
  return json({ ok: true, message: '如果该邮箱有待验证账号，将收到新的验证邮件。' });
}

export async function verifyEmail(request: Request) {
  anonymousRateLimit(request, 'verify', 30, 900000);
  const body = await readBody(request);
  const token = textField(body, 'token', 64, 64);
  const userId = transaction(() => {
    const row = getDb()
      .prepare(
        'SELECT v.* FROM verification_tokens v JOIN users u ON u.id=v.user_id WHERE v.token_hash=? AND v.expires_at>? AND u.disabled=0',
      )
      .get(tokenHash(token), now()) as { user_id: string; new_email: string | null } | undefined;
    if (!row)
      throw new HttpError(
        400,
        '验证链接无效或已经过期，请重新发送验证邮件。',
        'INVALID_VERIFICATION_TOKEN',
      );
    if (row.new_email) {
      if (
        getDb()
          .prepare('SELECT id FROM users WHERE email=? AND id<>?')
          .get(row.new_email, row.user_id)
      )
        throw new HttpError(409, '此邮箱已被其他账号使用，请重新设置。', 'ACCOUNT_EXISTS');
      getDb()
        .prepare('UPDATE users SET email=?,email_verified=1 WHERE id=?')
        .run(row.new_email, row.user_id);
      getDb().prepare('DELETE FROM sessions WHERE user_id=?').run(row.user_id);
      getDb().prepare('DELETE FROM reset_tokens WHERE user_id=?').run(row.user_id);
    } else getDb().prepare('UPDATE users SET email_verified=1 WHERE id=?').run(row.user_id);
    getDb().prepare('DELETE FROM verification_tokens WHERE user_id=?').run(row.user_id);
    return row.user_id;
  });
  const row = getDb().prepare('SELECT * FROM users WHERE id=?').get(userId) as UserRow;
  return json({ user: safeUser(row) }, 200, { 'Set-Cookie': sessionCookie(startSession(userId)) });
}

export async function resetPassword(request: Request) {
  anonymousRateLimit(request, 'reset', 15, 900000);
  const body = await readBody(request);
  const token = textField(body, 'token', 64, 64);
  const encoded = await hashPassword(validatePassword(body.password));
  transaction(() => {
    const row = getDb()
      .prepare('SELECT user_id FROM reset_tokens WHERE token_hash=? AND expires_at>?')
      .get(tokenHash(token), now()) as { user_id: string } | undefined;
    if (!row)
      throw new HttpError(400, '重置链接无效或已经过期，请重新申请。', 'INVALID_RESET_TOKEN');
    getDb().prepare('UPDATE users SET password_hash=? WHERE id=?').run(encoded, row.user_id);
    getDb().prepare('DELETE FROM sessions WHERE user_id=?').run(row.user_id);
    getDb().prepare('DELETE FROM reset_tokens WHERE user_id=?').run(row.user_id);
    getDb().prepare('DELETE FROM verification_tokens WHERE user_id=?').run(row.user_id);
  });
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}

export async function deleteAccount(request: Request) {
  requireUser(request);
  const body = await readBody(request);
  const user = requireUser(request);
  const row = getDb().prepare('SELECT * FROM users WHERE id=?').get(user.id) as UserRow | undefined;
  if (!row) throw new HttpError(401, '登录信息已变化，请重新登录后删除账号。', 'UNAUTHORIZED');
  if (
    !(await verifyPassword(
      typeof body.password === 'string' ? body.password.slice(0, 128) : '',
      row.password_hash,
    ))
  )
    throw new HttpError(400, '密码不正确，无法删除账号。', 'INVALID_PASSWORD');
  transaction(() => {
    requireUser(request);
    const latest = getDb().prepare('SELECT * FROM users WHERE id=?').get(user.id) as
      UserRow | undefined;
    if (!latest || latest.password_hash !== row.password_hash)
      throw new HttpError(401, '登录信息已变化，请重新登录后删除账号。', 'UNAUTHORIZED');
    if (latest.role === 'admin')
      throw new HttpError(409, '管理员账号请先转移管理权限，再删除。', 'ADMIN_ACCOUNT');
    getDb().prepare('DELETE FROM users WHERE id=?').run(user.id);
  });
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}
