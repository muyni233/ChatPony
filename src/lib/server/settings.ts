import nodemailer from 'nodemailer';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import type { User } from '@/lib/types';
import {
  buildPromptMetadata,
  DEFAULT_PROMPT_METADATA_OPTIONS,
  PromptMetadataValidationError,
  validatePromptMetadataOptions,
  type PromptMetadataOptions,
} from '@/lib/prompt-metadata';
import { getDb } from './db';
import { booleanField, HttpError, json, numberField, rateLimit, readBody, textField } from './http';
import { decryptSecret, encryptSecret } from './secrets';
import { requireAdmin } from './auth';

export interface SiteSettings extends PromptMetadataOptions {
  siteName: string;
  siteDescription: string;
  siteUrl: string;
  registrationEnabled: boolean;
  requireEmailVerification: boolean;
  allowedEmailDomains: string[];
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpFrom: string;
  smtpPasswordCipher: string;
  localDemoMode: boolean;
  trustProxy: boolean;
  quota5h: number;
  quota1d: number;
  quota7d: number;
  quota5hEnabled: boolean;
  quota1dEnabled: boolean;
  quota7dEnabled: boolean;
  maxMessagesPerConversation: number;
  maxConversationsPerUser: number;
  maxGroupReplies: number;
  maxGroupDepth: number;
  auditRetentionDays: number;
  bubbleSeparator: string;
  hiddenOutputMarkers: string[];
}
const defaults: SiteSettings = {
  ...DEFAULT_PROMPT_METADATA_OPTIONS,
  siteName: 'ChatPony',
  siteDescription: '与你喜欢的角色，续写每一段故事。',
  siteUrl: '',
  registrationEnabled: true,
  requireEmailVerification: true,
  allowedEmailDomains: [],
  smtpHost: '',
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: '',
  smtpFrom: '',
  smtpPasswordCipher: '',
  localDemoMode: false,
  trustProxy: false,
  quota5h: 50,
  quota1d: 100,
  quota7d: 500,
  quota5hEnabled: true,
  quota1dEnabled: false,
  quota7dEnabled: true,
  maxMessagesPerConversation: 2000,
  maxConversationsPerUser: 200,
  maxGroupReplies: 6,
  maxGroupDepth: 3,
  auditRetentionDays: 90,
  bubbleSeparator: '|||',
  hiddenOutputMarkers: [],
};

export function getSettings(): SiteSettings {
  const row = getDb().prepare("SELECT value FROM settings WHERE key='site'").get() as
    { value: string } | undefined;
  if (!row) return { ...defaults };
  const saved = JSON.parse(row.value) as Partial<SiteSettings> & {
    maxDailyTurns?: number;
    allowPrivateApiUrls?: unknown;
  };
  delete saved.maxDailyTurns;
  // Retired flags must neither reappear in settings nor gate administrator-configured services.
  delete saved.allowPrivateApiUrls;
  return { ...defaults, ...saved };
}

export function safeSettings() {
  const { smtpPasswordCipher, ...settings } = getSettings();
  return {
    ...settings,
    smtpHasPassword: !!smtpPasswordCipher,
    developmentMode: process.env.NODE_ENV !== 'production',
  };
}

export function bootstrapRequired() {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n === 0;
}

export function publicSettings() {
  const settings = getSettings();
  return {
    name: settings.siteName,
    description: settings.siteDescription,
    registrationEnabled: settings.registrationEnabled,
    requireEmailVerification: settings.requireEmailVerification,
    allowedEmailDomains: settings.allowedEmailDomains,
    bubbleSeparator: settings.bubbleSeparator,
    hiddenOutputMarkers: settings.hiddenOutputMarkers,
  };
}

function allowedEmailDomainsField(value: unknown, fallback: string[]) {
  if (value === undefined) return fallback;
  const invalid = () =>
    new HttpError(
      400,
      '注册邮箱域名最多 64 个，请填写完整域名（如 example.com），不要包含 @、协议、端口、路径或通配符。',
      'INVALID_EMAIL_DOMAINS',
    );
  if (!Array.isArray(value) || value.length > 64) throw invalid();
  const domains = value.map((item) => {
    if (
      typeof item !== 'string' ||
      item.length > 1024 ||
      /[\s@:/\\*?#%\u0000-\u001f\u007f-\u009f]/.test(item.trim())
    )
      throw invalid();
    const domain = domainToASCII(item.trim().toLowerCase());
    const labels = domain.split('.');
    if (
      !domain ||
      domain.length > 253 ||
      labels.length < 2 ||
      isIP(domain) ||
      labels.some((label) => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
    )
      throw invalid();
    return domain;
  });
  return [...new Set(domains)];
}

function bubbleSeparatorField(value: unknown, fallback: string) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > 40)
    throw new HttpError(
      400,
      '消息气泡分隔符最多 40 个字符，留空可关闭自动分段。',
      'INVALID_BUBBLE_SEPARATOR',
    );
  // Do not trim: spaces or actual newlines can be intentional delimiters.
  const normalized = value.replace(/\\n/g, '\n');
  if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(normalized))
    throw new HttpError(
      400,
      '消息气泡分隔符仅允许普通字符和换行，不能包含其他控制字符。',
      'INVALID_BUBBLE_SEPARATOR',
    );
  return normalized;
}

function hiddenOutputMarkersField(value: unknown, fallback: string[]) {
  if (value === undefined) return fallback;
  if (
    !Array.isArray(value) ||
    value.length > 16 ||
    value.some(
      (marker) =>
        typeof marker !== 'string' ||
        marker.length < 1 ||
        marker.length > 80 ||
        /[\u0000-\u001f\u007f-\u009f]/.test(marker),
    )
  )
    throw new HttpError(
      400,
      '最多配置 16 个隐藏标记，每个为 1–80 个普通字符，不能包含控制字符。',
      'INVALID_HIDDEN_OUTPUT_MARKERS',
    );
  if (new Set(value).size !== value.length)
    throw new HttpError(400, '隐藏标记不能重复，请移除重复项。', 'INVALID_HIDDEN_OUTPUT_MARKERS');
  return value as string[];
}

function promptMetadataFields(value: unknown, fallback: PromptMetadataOptions) {
  try {
    return validatePromptMetadataOptions(value, fallback);
  } catch (error) {
    if (error instanceof PromptMetadataValidationError)
      throw new HttpError(400, error.message, error.code);
    throw error;
  }
}

export function assertMailerConfigured() {
  const settings = getSettings();
  if (!settings.smtpHost || !settings.smtpFrom || !settings.siteUrl)
    throw new HttpError(
      503,
      '站点尚未配置验证邮件服务，请联系管理员完成 SMTP 和站点地址设置。',
      'MAIL_NOT_CONFIGURED',
    );
  return settings;
}

export async function sendMail(to: string, subject: string, text: string) {
  const settings = assertMailerConfigured();
  const transport = nodemailer.createTransport({
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: settings.smtpSecure,
    requireTLS: !settings.smtpSecure,
    auth: settings.smtpUser
      ? { user: settings.smtpUser, pass: decryptSecret(settings.smtpPasswordCipher) }
      : undefined,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
  try {
    await transport.sendMail({ from: settings.smtpFrom, to, subject, text });
  } catch {
    throw new HttpError(502, '邮件发送失败，请检查 SMTP 配置或稍后重试。', 'MAIL_DELIVERY_FAILED');
  } finally {
    transport.close();
  }
}

export async function adminSettings(request: Request) {
  if (request.method === 'GET') return json({ settings: safeSettings() });
  const body = await readBody(request);
  requireAdmin(request);
  const existing = getSettings();
  const siteUrl = textField(body, 'siteUrl', 1000, 0, existing.siteUrl);
  if (siteUrl) {
    try {
      const url = new URL(siteUrl);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        throw new Error();
    } catch {
      throw new HttpError(
        400,
        '站点地址应为完整的 http(s) 来源地址，不包含路径、参数或密码。',
        'INVALID_SITE_URL',
      );
    }
  }
  const smtpHost = textField(body, 'smtpHost', 254, 0, existing.smtpHost);
  if (smtpHost && !/^[a-zA-Z0-9.\-:[\]]+$/.test(smtpHost))
    throw new HttpError(400, 'SMTP 主机格式无效，请只填写域名或 IP。', 'INVALID_SMTP_HOST');
  const data: SiteSettings = {
    ...promptMetadataFields(body, existing),
    siteName: textField(body, 'siteName', 60, 1, existing.siteName),
    siteDescription: textField(body, 'siteDescription', 300, 0, existing.siteDescription),
    siteUrl: siteUrl ? new URL(siteUrl).origin : '',
    registrationEnabled: booleanField(body, 'registrationEnabled', existing.registrationEnabled),
    requireEmailVerification: booleanField(
      body,
      'requireEmailVerification',
      existing.requireEmailVerification,
    ),
    allowedEmailDomains: allowedEmailDomainsField(
      body.allowedEmailDomains,
      existing.allowedEmailDomains,
    ),
    smtpHost,
    smtpPort: numberField(body, 'smtpPort', 1, 65535, existing.smtpPort, true),
    smtpSecure: booleanField(body, 'smtpSecure', existing.smtpSecure),
    smtpUser: textField(body, 'smtpUser', 254, 0, existing.smtpUser),
    smtpFrom: textField(body, 'smtpFrom', 320, 0, existing.smtpFrom),
    smtpPasswordCipher:
      typeof body.smtpPassword === 'string' && body.smtpPassword
        ? encryptSecret(textField(body, 'smtpPassword', 4096, 1))
        : existing.smtpPasswordCipher,
    localDemoMode: booleanField(body, 'localDemoMode', existing.localDemoMode),
    trustProxy: booleanField(body, 'trustProxy', existing.trustProxy),
    quota5h: numberField(body, 'quota5h', 0, 1000000, existing.quota5h, true),
    quota1d: numberField(body, 'quota1d', 0, 1000000, existing.quota1d, true),
    quota7d: numberField(body, 'quota7d', 0, 1000000, existing.quota7d, true),
    quota5hEnabled: booleanField(body, 'quota5hEnabled', existing.quota5hEnabled),
    quota1dEnabled: booleanField(body, 'quota1dEnabled', existing.quota1dEnabled),
    quota7dEnabled: booleanField(body, 'quota7dEnabled', existing.quota7dEnabled),
    maxMessagesPerConversation: numberField(
      body,
      'maxMessagesPerConversation',
      10,
      10000,
      existing.maxMessagesPerConversation,
      true,
    ),
    maxConversationsPerUser: numberField(
      body,
      'maxConversationsPerUser',
      1,
      1000,
      existing.maxConversationsPerUser,
      true,
    ),
    maxGroupReplies: numberField(body, 'maxGroupReplies', 1, 12, existing.maxGroupReplies, true),
    maxGroupDepth: numberField(body, 'maxGroupDepth', 1, 6, existing.maxGroupDepth, true),
    auditRetentionDays: numberField(
      body,
      'auditRetentionDays',
      7,
      365,
      existing.auditRetentionDays,
      true,
    ),
    bubbleSeparator: bubbleSeparatorField(body.bubbleSeparator, existing.bubbleSeparator),
    hiddenOutputMarkers: hiddenOutputMarkersField(
      body.hiddenOutputMarkers,
      existing.hiddenOutputMarkers,
    ),
  };
  if (data.localDemoMode && process.env.NODE_ENV === 'production')
    throw new HttpError(
      400,
      '本地演示回复仅限开发环境，正式站点请配置真实模型服务。',
      'DEMO_DEVELOPMENT_ONLY',
    );
  if (data.smtpFrom && !/^[^\r\n]+@[^\r\n]+$/.test(data.smtpFrom))
    throw new HttpError(400, '请填写有效的 SMTP 发件人地址。', 'INVALID_SMTP_FROM');
  getDb()
    .prepare(
      "INSERT INTO settings(key,value) VALUES ('site',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(JSON.stringify(data));
  return json({ settings: safeSettings() });
}

export async function previewPromptMetadata(request: Request) {
  const body = await readBody(request);
  requireAdmin(request);
  const options = promptMetadataFields(body, getSettings());
  const generatedAt = new Date();
  return json({
    text: buildPromptMetadata(options, generatedAt),
    generatedAt: generatedAt.toISOString(),
  });
}

export async function testEmail(user: User) {
  rateLimit(`email-test:${user.id}`, 5, 60000);
  await sendMail(
    user.email,
    'ChatPony 邮件服务测试',
    '这是一封由你在管理后台发起的测试邮件。收到这封邮件表示 SMTP 发送配置有效。',
  );
  return json({ ok: true, message: `测试邮件已提交给 ${user.email} 的邮件服务器，请检查收件箱。` });
}
