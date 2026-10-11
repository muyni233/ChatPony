import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { AppError } from './errors';

const globalKey = globalThis as typeof globalThis & { __chatponyEphemeralKey?: Buffer };
function encryptionKey(): Buffer {
  const supplied = process.env.ENCRYPTION_KEY?.trim();
  if (supplied) {
    const hex = /^[a-f\d]{64}$/i.test(supplied);
    const base64 = /^[A-Za-z0-9+/]{43}=$/.test(supplied);
    const key = hex
      ? Buffer.from(supplied, 'hex')
      : base64
        ? Buffer.from(supplied, 'base64')
        : null;
    if (!key || key.length !== 32)
      throw new AppError(
        503,
        'ENCRYPTION_KEY_INVALID',
        '服务器的 ENCRYPTION_KEY 格式无效，应为 32 字节密钥的十六进制或 Base64 编码。',
      );
    return key;
  }
  if (process.env.DATABASE_PATH === ':memory:')
    return (globalKey.__chatponyEphemeralKey ??= randomBytes(32));
  const keyPath = resolve(
    dirname(process.env.DATABASE_PATH || './data/chatpony.db'),
    '.encryption-key',
  );
  function readKey(): Buffer | null {
    try {
      const key = readFileSync(keyPath);
      if (key.length !== 32)
        throw new AppError(
          503,
          'ENCRYPTION_KEY_FILE_INVALID',
          '数据库目录中的 .encryption-key 文件无效。请恢复原密钥文件，系统不会覆盖它。',
        );
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (error instanceof AppError) throw error;
      throw new AppError(
        503,
        'ENCRYPTION_KEY_READ_FAILED',
        '无法读取数据库目录中的 .encryption-key，请检查服务进程的文件访问权限。',
      );
    }
  }
  // The same persisted key is used in development and production. A build-mode
  // change must never make already-saved credentials unreadable.
  const existing = readKey();
  if (existing) return existing;
  const temporary = `${keyPath}.${randomBytes(12).toString('hex')}.tmp`;
  try {
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(temporary, randomBytes(32), { flag: 'wx', mode: 0o600 });
    // Publish a complete key atomically without replacing another process's key.
    try {
      linkSync(temporary, keyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const key = readKey();
    if (!key) throw new Error('Key not persisted');
    return key;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      503,
      'ENCRYPTION_KEY_WRITE_FAILED',
      '无法在数据库目录保存加密密钥。请赋予该目录写入权限，或配置有效的 ENCRYPTION_KEY。',
    );
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* A concurrent creator never owns this temporary path. */
    }
  }
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
