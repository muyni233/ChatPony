import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const globalKey = globalThis as typeof globalThis & { __chatponyEphemeralKey?: Buffer };
function encryptionKey(): Buffer {
  const supplied = process.env.ENCRYPTION_KEY?.trim();
  if (supplied) {
    const key = /^[a-f\d]{64}$/i.test(supplied)
      ? Buffer.from(supplied, 'hex')
      : Buffer.from(supplied, 'base64');
    if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be a 32-byte hex or base64 key');
    return key;
  }
  if (process.env.NODE_ENV === 'production')
    throw new Error('ENCRYPTION_KEY is required in production');
  if (process.env.DATABASE_PATH === ':memory:')
    return (globalKey.__chatponyEphemeralKey ??= randomBytes(32));
  const keyPath = resolve(
    dirname(process.env.DATABASE_PATH || './data/chatpony.db'),
    '.encryption-key',
  );
  mkdirSync(dirname(keyPath), { recursive: true });
  try {
    writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error('Invalid persisted encryption key');
  return key;
}

export function encrypt(value: string): string {
  if (!value) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const payload = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    payload.toString('base64url'),
  ].join(':');
}

export function decrypt(value: string): string {
  if (!value) return '';
  const [version, nonce, tag, payload, extra] = value.split(':');
  if (version !== 'v1' || !nonce || !tag || !payload || extra)
    throw new Error('Invalid encrypted credential');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(nonce, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(payload, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
