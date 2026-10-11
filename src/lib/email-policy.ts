import { domainToASCII } from 'node:url';
import { getDb } from './db';
import { AppError } from './errors';
import type { Row } from './mappers';

export function normalizeEmailDomain(value: string, wildcard = true): string {
  const input = value.trim().toLowerCase();
  if (/[\s/@:#?\[\]\\\u0000-\u001f\u007f]/.test(input))
    throw new AppError(400, 'INVALID_EMAIL_DOMAIN', '请只填写邮箱域名，不包含协议、路径或端口。');
  const prefix = wildcard && input.startsWith('*.') ? '*.' : '';
  const domain = domainToASCII(prefix ? input.slice(2) : input).toLowerCase();
  if (
    !domain ||
    domain.length > 253 ||
    !domain.includes('.') ||
    domain.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw new AppError(
      400,
      'INVALID_EMAIL_DOMAIN',
      '邮箱域名无效，请使用 example.com 或 *.example.com 格式。',
    );
  return prefix + domain;
}

export function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string')
    throw new AppError(400, 'VALIDATION_ERROR', '请输入有效的电子邮箱。');
  const input = value.trim();
  const parts = input.split('@');
  if (
    parts.length !== 2 ||
    !parts[0] ||
    parts[0].length > 64 ||
    /[\s<>(),;:\[\]"\\\u0000-\u001f\u007f]/.test(parts[0])
  )
    throw new AppError(400, 'VALIDATION_ERROR', '请输入有效的电子邮箱。');
  let domain: string;
  try {
    domain = normalizeEmailDomain(parts[1], false);
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', '请输入有效的电子邮箱。');
  }
  const email = `${parts[0].toLowerCase()}@${domain}`;
  if (email.length > 254) throw new AppError(400, 'VALIDATION_ERROR', '请输入有效的电子邮箱。');
  return email;
}

export function normalizeEmailDomains(input: unknown): string[] {
  if (
    !Array.isArray(input) ||
    input.length > 100 ||
    input.some((item) => typeof item !== 'string' || item.length > 255)
  )
    throw new AppError(400, 'INVALID_EMAIL_DOMAIN', '域名规则最多 100 项，每项最多 255 个字符。');
  return [...new Set(input.map((item) => normalizeEmailDomain(item as string)))];
}

export function emailDomainAllowed(
  email: string,
  mode: 'any' | 'allowlist' | 'blocklist',
  domains: string[],
): boolean {
  if (mode === 'any') return true;
  const domain = email.slice(email.lastIndexOf('@') + 1);
  const matches = domains.some((rule) =>
    rule.startsWith('*.')
      ? domain.endsWith(rule.slice(1)) && domain !== rule.slice(2)
      : domain === rule,
  );
  return mode === 'allowlist' ? matches : !matches;
}

export function getRegistrationPolicy() {
  const rows = getDb()
    .query(
      "SELECT key,value FROM settings WHERE key IN ('registrationOpen','requireEmailVerification','emailDomainMode','emailDomains')",
    )
    .all() as Row[];
  const values = Object.fromEntries(
    rows.map((row) => [String(row.key), JSON.parse(String(row.value))]),
  );
  return {
    registrationOpen: values.registrationOpen !== false,
    requireEmailVerification: values.requireEmailVerification === true,
    emailDomainMode: (values.emailDomainMode || 'any') as 'any' | 'allowlist' | 'blocklist',
    emailDomains: (values.emailDomains || []) as string[],
  };
}

export function assertRegistrationAllowed(email: string) {
  const policy = getRegistrationPolicy();
  if (!policy.registrationOpen)
    throw new AppError(403, 'REGISTRATION_CLOSED', '平台暂未开放注册。');
  if (!emailDomainAllowed(email, policy.emailDomainMode, policy.emailDomains))
    throw new AppError(
      403,
      'EMAIL_DOMAIN_RESTRICTED',
      '该邮箱域名不符合平台的注册规则，请使用其他邮箱。',
    );
  return policy;
}
