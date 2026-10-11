import sharp from 'sharp';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { getDb, id } from './db';
import { AppError } from './errors';
import { toUser, type Row } from './mappers';
import type { User } from './types';

export const AVATAR_JSON_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const FILE_NAME =
  /^[a-zA-Z0-9_-]{1,100}-[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\.webp$/;

export function avatarDirectory(): string {
  const database = process.env.DATABASE_PATH || './data/chatpony.db';
  return resolve(database === ':memory:' ? './data' : dirname(resolve(database)), 'avatars');
}

function avatarPath(filename: string): string {
  if (!FILE_NAME.test(filename)) throw new AppError(404, 'AVATAR_NOT_FOUND', '头像不存在。');
  const directory = avatarDirectory();
  const target = resolve(directory, filename);
  if (dirname(target) !== directory) throw new AppError(404, 'AVATAR_NOT_FOUND', '头像不存在。');
  return target;
}

/** Only a server-generated file belonging to this exact user may be removed. */
export async function removeOwnedAvatar(userId: string, url: string): Promise<void> {
  if (!url.startsWith('/api/avatars/')) return;
  const filename = url.slice('/api/avatars/'.length);
  if (!FILE_NAME.test(filename) || !filename.startsWith(`${userId}-`)) return;
  try {
    await unlink(avatarPath(filename));
  } catch {
    /* An old or already removed avatar must not make a successful account update fail. */
  }
}

export async function avatarResponse(filename: string): Promise<Response> {
  const path = avatarPath(filename);
  try {
    const bytes = await readFile(path);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'image/webp',
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    throw new AppError(404, 'AVATAR_NOT_FOUND', '头像不存在。');
  }
}

export async function uploadAvatar(userId: string, input: Record<string, unknown>): Promise<User> {
  if (Object.keys(input).some((key) => key !== 'dataUrl') || typeof input.dataUrl !== 'string')
    throw new AppError(400, 'INVALID_AVATAR', '请提供 JPEG、PNG 或 WebP 图片。');
  if (input.dataUrl.length > AVATAR_JSON_BYTES)
    throw new AppError(413, 'AVATAR_TOO_LARGE', '头像原图不能超过 2 MiB。');
  const match = input.dataUrl.match(/^data:image\/(jpeg|png|webp);base64,([a-zA-Z0-9+/]+={0,2})$/);
  if (!match || match[2].length % 4 !== 0)
    throw new AppError(400, 'INVALID_AVATAR', '头像仅支持 JPEG、PNG 或 WebP 图片。');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.byteLength > MAX_IMAGE_BYTES)
    throw new AppError(413, 'AVATAR_TOO_LARGE', '头像原图不能超过 2 MiB。');
  if (bytes.toString('base64') !== match[2])
    throw new AppError(400, 'INVALID_AVATAR', '图片编码无效。');
  const expectedFormat = match[1];
  const actualFormat = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? 'png'
    : bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? 'jpeg'
      : bytes.length >= 12 &&
          bytes.toString('ascii', 0, 4) === 'RIFF' &&
          bytes.toString('ascii', 8, 12) === 'WEBP'
        ? 'webp'
        : '';
  if (actualFormat !== expectedFormat)
    throw new AppError(400, 'INVALID_AVATAR', '图片类型与文件内容不一致。');
  let encoded: Buffer;
  try {
    const image = sharp(bytes, {
      limitInputPixels: MAX_PIXELS,
      failOn: 'warning',
      animated: false,
    });
    const metadata = await image.metadata();
    if (
      metadata.format !== expectedFormat ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height * (metadata.pages || 1) > MAX_PIXELS
    )
      throw new Error('Invalid image dimensions');
    encoded = await image
      .rotate()
      .resize(256, 256, { fit: 'cover' })
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    throw new AppError(400, 'INVALID_AVATAR', '图片无法解码或超过 1600 万像素，请更换图片。');
  }
  const filename = `${userId}-${id()}.webp`;
  const path = avatarPath(filename);
  const url = `/api/avatars/${filename}`;
  await mkdir(avatarDirectory(), { recursive: true });
  await writeFile(path, encoded, { flag: 'wx', mode: 0o644 });
  let previous = '';
  let user: User;
  try {
    user = getDb()
      .transaction(() => {
        const row = getDb()
          .query('SELECT * FROM users WHERE id=? AND disabled=0')
          .get(userId) as Row | null;
        if (!row) throw new AppError(403, 'ACCOUNT_DISABLED', '此账号当前不可用。');
        previous = String(row.avatar || '');
        getDb().query('UPDATE users SET avatar=? WHERE id=?').run(url, userId);
        return toUser({ ...row, avatar: url });
      })
      .immediate();
  } catch (error) {
    await removeOwnedAvatar(userId, url);
    throw error;
  }
  await removeOwnedAvatar(userId, previous);
  return user;
}
