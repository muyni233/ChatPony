import nodemailer from 'nodemailer';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getDb, now } from './db';
import { encrypt, decrypt } from './crypto';
import { AppError } from './errors';
import { assertRegistrationAllowed, getRegistrationPolicy, normalizeEmail } from './email-policy';
import type { MailConfig } from './types';
import type { Row } from './mappers';

type StoredMail = Omit<MailConfig, 'hasPassword'> & { password: string };
const defaults: StoredMail = {
  host: '',
  port: 587,
  secure: false,
  requireTLS: true,
  username: '',
  password: '',
  fromEmail: '',
  fromName: '',
};
const fields = z
  .object({
    host: z
      .string()
      .trim()
      .max(253)
      .refine(
        (value) => !value || /^[a-zA-Z0-9.:-]+$/.test(value),
        'SMTP 主机应为域名或 IP，不包含协议、路径或凭据',
      ),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    requireTLS: z.boolean(),
    username: z
      .string()
      .trim()
      .max(320)
      .refine((value) => !/[\r\n\0]/.test(value)),
    password: z.string().max(8192),
    fromEmail: z.string().trim().max(254),
    fromName: z
      .string()
      .trim()
      .max(100)
      .refine((value) => !/[\r\n\0]/.test(value)),
  })
  .strict();
// AES-GCM ciphertext includes UTF-8 expansion, base64, nonce and authentication tag.
const storedFields = fields.extend({ password: z.string().max(65536) });

function storedMail(): StoredMail {
  const row = getDb()
    .query("SELECT value FROM settings WHERE key='mailConfig'")
    .get() as Row | null;
  if (!row) return { ...defaults };
  try {
    return storedFields.parse({ ...defaults, ...JSON.parse(String(row.value)) });
  } catch {
    throw new AppError(503, 'MAIL_CONFIG', '邮件配置无法读取，请管理员重新保存。');
  }
}

export function getMailConfig(): MailConfig {
  const { password, ...config } = storedMail();
  return { ...config, hasPassword: Boolean(password) };
}

export function updateMailConfig(input: Record<string, unknown>): MailConfig {
  const parsed = fields.partial().safeParse(input);
  if (!parsed.success)
    throw new AppError(400, 'VALIDATION_ERROR', `邮件配置无效：${parsed.error.issues[0].message}`);
  return getDb()
    .transaction(() => {
      const previous = storedMail();
      const patch = parsed.data;
      const config: StoredMail = {
        ...previous,
        ...patch,
        password: patch.password === undefined ? previous.password : encrypt(patch.password),
      };
      if (config.fromEmail) config.fromEmail = normalizeEmail(config.fromEmail);
      if (getRegistrationPolicy().requireEmailVerification && (!config.host || !config.fromEmail))
        throw new AppError(
          400,
          'MAIL_IN_USE',
          '注册邮箱验证已开启，请先关闭该选项，再清空 SMTP 主机或发件邮箱。',
        );
      getDb()
        .query(
          "INSERT INTO settings(key,value) VALUES('mailConfig',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(JSON.stringify(config));
      return getMailConfig();
    })
    .immediate();
}

export function assertMailConfigured(): void {
  const config = storedMail();
  if (!config.host || !config.fromEmail)
    throw new AppError(
      400,
      'MAIL_NOT_CONFIGURED',
      '请先填写并保存 SMTP 主机与发件邮箱，再启用邮件验证。',
    );
}

function transport() {
  assertMailConfigured();
  const config = storedMail();
  let password: string;
  try {
    password = decrypt(config.password);
  } catch {
    throw new AppError(503, 'MAIL_KEY', '邮件凭据无法读取，请管理员重新配置。');
  }
  return {
    config,
    client: nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: config.requireTLS,
      ...(config.username ? { auth: { user: config.username, pass: password } } : {}),
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
    }),
  };
}

function mailError(error: unknown): AppError {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return new AppError(
    503,
    code === 'EAUTH' ? 'MAIL_AUTH_FAILED' : 'MAIL_UNAVAILABLE',
    code === 'EAUTH'
      ? 'SMTP 鉴权失败，请管理员检查邮件凭据。'
      : '邮件服务暂不可用，请稍后重试或联系管理员。',
  );
}

export async function testMail(): Promise<{ ok: true; message: string }> {
  const { client } = transport();
  try {
    await client.verify();
    return { ok: true, message: 'SMTP 连接与鉴权验证成功，未发送测试邮件。' };
  } catch (error) {
    throw mailError(error);
  } finally {
    client.close();
  }
}

const challengeHash = (email: string, salt: string, code: string) =>
  createHash('sha256').update(`${email}\0${salt}\0${code}`).digest('hex');
const result = { ok: true as const, retryAfter: 60, expiresIn: 600 };
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );

export async function sendVerificationCode(email: string): Promise<typeof result> {
  const policy = assertRegistrationAllowed(email);
  if (!policy.requireEmailVerification)
    throw new AppError(409, 'VERIFICATION_DISABLED', '当前注册无需邮箱验证码。');
  if (getDb().query('SELECT id FROM users WHERE email=?').get(email)) return result;
  const { config, client } = transport();
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const salt = randomBytes(32).toString('hex');
  const codeHash = challengeHash(email, salt, code);
  const timestamp = now();
  getDb()
    .transaction(() => {
      getDb().query('DELETE FROM registration_challenges WHERE expires_at<=?').run(timestamp);
      const previous = getDb()
        .query('SELECT sent_at FROM registration_challenges WHERE email=?')
        .get(email) as Row | null;
      if (previous && Date.parse(String(previous.sent_at)) > Date.now() - 60_000)
        throw new AppError(
          429,
          'VERIFICATION_COOLDOWN',
          '验证码发送间隔至少为 60 秒，请稍后重试。',
        );
      getDb()
        .query(
          'INSERT INTO registration_challenges(email,code_hash,salt,expires_at,sent_at,attempts,delivered) VALUES(?,?,?,?,?,0,0) ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,salt=excluded.salt,expires_at=excluded.expires_at,sent_at=excluded.sent_at,attempts=0,delivered=0',
        )
        .run(
          email,
          codeHash,
          salt,
          new Date(Date.parse(timestamp) + 600_000).toISOString(),
          timestamp,
        );
    })
    .immediate();
  try {
    const info = await client.sendMail({
      from: { name: config.fromName || 'ChatPony', address: config.fromEmail },
      to: { address: email, name: '' },
      subject: 'ChatPony 注册验证码',
      text: `你的 ChatPony 注册验证码是：${code}\n验证码 10 分钟内有效，只能使用一次。如非本人操作，请忽略此邮件。`,
      html: `<p>你的 ChatPony 注册验证码是：</p><p style="font-size:28px;letter-spacing:6px;font-weight:bold">${escapeHtml(code)}</p><p>验证码 10 分钟内有效，只能使用一次。如非本人操作，请忽略此邮件。</p>`,
    });
    if (!info.accepted?.length) throw new Error('No accepted recipient');
    getDb()
      .query('UPDATE registration_challenges SET delivered=1 WHERE email=? AND code_hash=?')
      .run(email, codeHash);
    return result;
  } catch (error) {
    getDb()
      .query('DELETE FROM registration_challenges WHERE email=? AND code_hash=?')
      .run(email, codeHash);
    throw mailError(error);
  } finally {
    client.close();
  }
}

/** Caller commits the returned error so failed-attempt increments cannot roll back. */
export function checkVerificationChallenge(email: string, code: unknown): AppError | null {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code))
    return new AppError(400, 'VERIFICATION_REQUIRED', '请输入邮件中的 6 位验证码。');
  const db = getDb();
  const challenge = db
    .query('SELECT * FROM registration_challenges WHERE email=?')
    .get(email) as Row | null;
  if (!challenge || !challenge.delivered || Date.parse(String(challenge.expires_at)) <= Date.now())
    return new AppError(400, 'VERIFICATION_EXPIRED', '验证码无效或已过期，请重新获取。');
  if (Number(challenge.attempts) >= 5)
    return new AppError(429, 'VERIFICATION_ATTEMPTS', '验证码尝试次数已用完，请重新获取。');
  const actual = Buffer.from(challengeHash(email, String(challenge.salt), code), 'hex');
  const expected = Buffer.from(String(challenge.code_hash), 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    db.query('UPDATE registration_challenges SET attempts=attempts+1 WHERE email=?').run(email);
    return new AppError(400, 'VERIFICATION_INVALID', '验证码不正确，请检查后重试。');
  }
  return null;
}
