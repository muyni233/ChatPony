import nodemailer from 'nodemailer';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getDb, now } from './db';
import { encrypt, decrypt } from './crypto';
import { AppError } from './errors';
import { assertRegistrationAllowed, getRegistrationPolicy, normalizeEmail } from './email-policy';
import type { MailConfig, MailDelivery } from './types';
import type { Row } from './mappers';
import {
  beginMailAttempt,
  configureMailAttempt,
  diagnoseMailError,
  finishMailAttempt,
  type MailAttempt,
} from './mail-diagnostics';

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

function transport(attempt: MailAttempt, extraSecrets: string[]) {
  const config = storedMail();
  configureMailAttempt(attempt, config, '', extraSecrets);
  assertMailConfigured();
  let password: string;
  try {
    password = decrypt(config.password);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'MAIL_KEY', '邮件凭据无法读取，请管理员重新配置。');
  }
  configureMailAttempt(attempt, config, password, extraSecrets);
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

async function mailOperation<T>(
  kind: MailDelivery['kind'],
  recipient: string,
  action: (connection: ReturnType<typeof transport>) => Promise<{ result: T; response?: string }>,
  admin = false,
  extraSecrets: string[] = [],
): Promise<{ result: T; id: string }> {
  const attempt = beginMailAttempt(kind, recipient);
  let connection: ReturnType<typeof transport> | undefined;
  try {
    connection = transport(attempt, extraSecrets);
    const value = await action(connection);
    finishMailAttempt(attempt, undefined, value.response);
    return { result: value.result, id: attempt.id };
  } catch (error) {
    const diagnosis = diagnoseMailError(error, attempt);
    finishMailAttempt(attempt, diagnosis);
    const reason = admin
      ? `${diagnosis.summary}${diagnosis.smtpCode ? `（SMTP ${diagnosis.smtpCode}${diagnosis.enhancedStatus ? ' / ' + diagnosis.enhancedStatus : ''}）` : ''}。${diagnosis.hint}`
      : '验证码邮件发送失败，请稍后重试或联系管理员。';
    throw new AppError(
      503,
      diagnosis.code === 'EAUTH' ? 'MAIL_AUTH_FAILED' : 'MAIL_UNAVAILABLE',
      `${reason} 参考编号：${attempt.id}`,
    );
  } finally {
    connection?.client.close();
  }
}

export async function testMail(): Promise<{ ok: true; message: string; id: string }> {
  const attempt = await mailOperation(
    'connection-test',
    '',
    async ({ client }) => {
      await client.verify();
      return { result: true };
    },
    true,
  );
  return {
    ok: true,
    id: attempt.id,
    message:
      'SMTP 连接与鉴权验证成功，未发送测试邮件；这不能确认服务器会接受发件地址或邮件内容，请继续实际发信测试。',
  };
}

export async function sendTestMail(
  input: Record<string, unknown>,
): Promise<{ ok: true; message: string; id: string }> {
  const parsed = z.object({ email: z.string() }).strict().safeParse(input);
  if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', '请输入有效的测试收件邮箱。');
  const recipient = normalizeEmail(parsed.data.email);
  const attempt = await mailOperation(
    'test-email',
    recipient,
    async ({ config, client }) => {
      const info = await client.sendMail({
        from: { name: config.fromName || 'ChatPony', address: config.fromEmail },
        to: { address: recipient, name: '' },
        subject: 'ChatPony 邮件发送测试',
        text: '这是一封由 ChatPony 管理员主动发送的测试邮件，用于验证 SMTP 发件地址与实际投递配置。此邮件不包含注册验证码。',
      });
      if (!info.accepted?.length)
        throw Object.assign(new Error('SMTP accepted no recipient'), {
          code: 'MAIL_NO_RECIPIENT',
          command: 'RCPT TO',
        });
      return { result: true, response: info.response };
    },
    true,
  );
  return {
    ok: true,
    id: attempt.id,
    message: 'SMTP 服务器已接受测试邮件，请检查收件箱和垃圾邮件；服务器接受不代表已送达收件箱。',
  };
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
    await mailOperation(
      'verification',
      email,
      async ({ config, client }) => {
        const info = await client.sendMail({
          from: { name: config.fromName || 'ChatPony', address: config.fromEmail },
          to: { address: email, name: '' },
          subject: 'ChatPony 注册验证码',
          text: `你的 ChatPony 注册验证码是：${code}\n验证码 10 分钟内有效，只能使用一次。如非本人操作，请忽略此邮件。`,
          html: `<p>你的 ChatPony 注册验证码是：</p><p style="font-size:28px;letter-spacing:6px;font-weight:bold">${escapeHtml(code)}</p><p>验证码 10 分钟内有效，只能使用一次。如非本人操作，请忽略此邮件。</p>`,
        });
        if (!info.accepted?.length)
          throw Object.assign(new Error('SMTP accepted no recipient'), {
            code: 'MAIL_NO_RECIPIENT',
            command: 'RCPT TO',
          });
        return { result: true, response: info.response };
      },
      false,
      [code],
    );
    getDb()
      .query('UPDATE registration_challenges SET delivered=1 WHERE email=? AND code_hash=?')
      .run(email, codeHash);
    return result;
  } catch (error) {
    getDb()
      .query('DELETE FROM registration_challenges WHERE email=? AND code_hash=?')
      .run(email, codeHash);
    throw error;
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
