import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AIError, withSignal } from './errors';
import type { AIRuntime } from './types';

const invalidUrl = () =>
  new AIError('invalid_url', 'API 地址格式无效，请使用不含账号、参数或片段的 HTTP(S) 地址。', {
    status: 400,
  });
const unsafeUrl = () =>
  new AIError('unsafe_url', 'API 地址不能指向本机、内网或保留网络地址。', { status: 400 });

function allowPrivate(options: Pick<AIRuntime, 'allowPrivateUrls'>): boolean {
  return options.allowPrivateUrls ?? false;
}

function isPublicIPv4(address: string): boolean {
  const [a, b, c] = address.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function expandedIPv6(address: string): number[] | null {
  let text = address.toLowerCase();
  if (text.includes('.')) {
    const split = text.lastIndexOf(':');
    const octets = text
      .slice(split + 1)
      .split('.')
      .map(Number);
    if (octets.length !== 4) return null;
    text = `${text.slice(0, split)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const sides = text.split('::');
  if (sides.length > 2) return null;
  const left = sides[0] ? sides[0].split(':').map((part) => parseInt(part, 16)) : [];
  const right = sides[1] ? sides[1].split(':').map((part) => parseInt(part, 16)) : [];
  const all =
    sides.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right]
      : left;
  return all.length === 8 &&
    all.every((part) => Number.isInteger(part) && part >= 0 && part <= 65535)
    ? all
    : null;
}

export function isPublicIPAddress(raw: string): boolean {
  const address = raw.replace(/^\[|\]$/g, '');
  const version = isIP(address);
  if (version === 4) return isPublicIPv4(address);
  if (version !== 6) return false;
  const parts = expandedIPv6(address);
  if (!parts) return false;
  if (parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff) {
    return isPublicIPv4(`${parts[6] >> 8}.${parts[6] & 255}.${parts[7] >> 8}.${parts[7] & 255}`);
  }
  // Only global unicast; reject IPv4 tunnels and documentation ranges too.
  return (
    (parts[0] & 0xe000) === 0x2000 &&
    parts[0] !== 0x2002 &&
    !(parts[0] === 0x2001 && (parts[1] < 0x0200 || parts[1] === 0x0db8)) &&
    !(parts[0] === 0x3fff && (parts[1] & 0xf000) === 0)
  );
}

export function validateProviderUrl(
  baseUrl: string,
  options: Pick<AIRuntime, 'allowPrivateUrls'> = {},
): URL {
  if (
    typeof baseUrl !== 'string' ||
    baseUrl.length > 2048 ||
    /[\s\\\u0000-\u001f\u007f]/.test(baseUrl)
  )
    throw invalidUrl();
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw invalidUrl();
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw invalidUrl();
  try {
    if (/[\u0000-\u001f\u007f\\]/.test(decodeURIComponent(url.pathname))) throw invalidUrl();
  } catch {
    throw invalidUrl();
  }
  const hostname = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (!allowPrivate(options)) {
    if (isIP(hostname)) {
      if (!isPublicIPAddress(hostname)) throw unsafeUrl();
    } else if (
      !hostname.includes('.') ||
      /(^|\.)(localhost|local|internal|invalid|test)$/.test(hostname)
    )
      throw unsafeUrl();
  }
  return url;
}

/** Resolve every record before each attempt; never follow credential-bearing redirects. */
export async function assertSafeProviderUrl(
  url: URL,
  options: Pick<AIRuntime, 'allowPrivateUrls' | 'resolveHostname'> = {},
  signal?: AbortSignal,
): Promise<void> {
  validateProviderUrl(url.toString(), options);
  if (allowPrivate(options)) return;
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(hostname)) return;
  const resolver =
    options.resolveHostname ??
    (async (host: string) => lookup(host, { all: true, verbatim: true }));
  let records: readonly { address: string; family: number }[];
  try {
    records = await withSignal(resolver(hostname), signal);
  } catch (error) {
    if (error instanceof AIError) throw error;
    throw new AIError('upstream_unavailable', '无法解析模型服务地址，请联系管理员检查配置。');
  }
  if (!records.length || records.some((record) => !isPublicIPAddress(record.address)))
    throw unsafeUrl();
}
