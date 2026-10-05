import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HttpError } from './http';
import { databasePath } from './db';

function encryptionKey() {
  const folder = dirname(databasePath());
  const path = join(folder, 'application.key');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    try {
      writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'))
        throw error;
    }
  }
  const key = readFileSync(path);
  if (key.length !== 32)
    throw new HttpError(
      503,
      '本地加密主密钥无效，请恢复备份的 application.key。',
      'ENCRYPTION_KEY_INVALID',
    );
  return key;
}

export function encryptSecret(value: string) {
  if (!value) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ciphertext.toString('base64')}`;
}

export function decryptSecret(value: string) {
  if (!value) return '';
  try {
    const [version, iv, tag, ciphertext] = value.split('.');
    if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
    cipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      cipher.update(Buffer.from(ciphertext, 'base64')),
      cipher.final(),
    ]).toString('utf8');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      503,
      'API 密钥无法解密，请检查加密密钥或重新保存提供商配置。',
      'SECRET_DECRYPTION_FAILED',
    );
  }
}
