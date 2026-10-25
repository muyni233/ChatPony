import sharp from 'sharp';
import { getDb, id, now } from './db';
import { AppError } from './errors';
import { getSettings, ownConversation } from './repository';
import type { Row } from './mappers';
import type { Attachment } from './types';

/** JSON upload cap: base64 of an ~6 MiB original plus the small envelope. */
export const ATTACHMENT_JSON_BYTES = 8_400_000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
/** Long edge sent to models. 1568 px is the largest size most vision models use without tiling. */
const MAX_EDGE = 1568;
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ORPHANS_PER_USER = 24;

function sniff(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'webp';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'gif';
  return '';
}

function toAttachment(row: Row): Attachment {
  return {
    id: String(row.id),
    mime: String(row.mime),
    width: Number(row.width),
    height: Number(row.height),
    size: Number(row.size),
  };
}

/** Decode, auto-rotate, strip metadata and re-encode before anything is stored. */
export async function encodeAttachment(dataUrl: unknown): Promise<{
  data: Buffer;
  width: number;
  height: number;
}> {
  if (typeof dataUrl !== 'string' || dataUrl.length > ATTACHMENT_JSON_BYTES)
    throw new AppError(413, 'ATTACHMENT_TOO_LARGE', '图片不能超过 6 MiB。');
  const match = dataUrl.match(/^data:image\/(jpeg|png|webp|gif);base64,([a-zA-Z0-9+/]+={0,2})$/);
  if (!match || match[2].length % 4 !== 0)
    throw new AppError(400, 'INVALID_ATTACHMENT', '仅支持 JPEG、PNG、WebP 或 GIF 图片。');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.byteLength > MAX_IMAGE_BYTES)
    throw new AppError(413, 'ATTACHMENT_TOO_LARGE', '图片不能超过 6 MiB。');
  if (sniff(bytes) !== match[1])
    throw new AppError(400, 'INVALID_ATTACHMENT', '图片类型与文件内容不一致。');
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error', animated: false });
    const { data, info } = await image
      .rotate()
      .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch {
    throw new AppError(400, 'INVALID_ATTACHMENT', '图片无法解码或像素过大，请更换图片。');
  }
}

export async function uploadAttachment(
  userId: string,
  conversationId: string,
  input: Record<string, unknown>,
): Promise<Attachment> {
  if (Object.keys(input).some((key) => key !== 'dataUrl'))
    throw new AppError(400, 'INVALID_ATTACHMENT', '请提供图片数据。');
  if (!getSettings().imageInputEnabled)
    throw new AppError(403, 'ATTACHMENTS_DISABLED', '管理员暂未开放图片发送。');
  ownConversation(userId, conversationId);
  const encoded = await encodeAttachment(input.dataUrl);
  const db = getDb();
  return db
    .transaction(() => {
      ownConversation(userId, conversationId);
      // Unsent uploads expire, so abandoned drafts never accumulate.
      db.query(
        'DELETE FROM message_attachments WHERE user_id=? AND message_id IS NULL AND created_at<?',
      ).run(userId, new Date(Date.now() - ORPHAN_TTL_MS).toISOString());
      const orphans = Number(
        (
          db
            .query(
              'SELECT COUNT(*) AS count FROM message_attachments WHERE user_id=? AND message_id IS NULL',
            )
            .get(userId) as Row
        ).count,
      );
      if (orphans >= MAX_ORPHANS_PER_USER)
        throw new AppError(429, 'ATTACHMENT_LIMIT', '待发送的图片过多，请先发送或移除部分图片。');
      const attachmentId = id();
      db.query(
        "INSERT INTO message_attachments(id,user_id,conversation_id,message_id,mime,width,height,size,data,created_at) VALUES(?,?,?,NULL,'image/webp',?,?,?,?,?)",
      ).run(
        attachmentId,
        userId,
        conversationId,
        encoded.width,
        encoded.height,
        encoded.data.byteLength,
        encoded.data,
        now(),
      );
      return {
        id: attachmentId,
        mime: 'image/webp',
        width: encoded.width,
        height: encoded.height,
        size: encoded.data.byteLength,
      };
    })
    .immediate();
}

export function deleteDraftAttachment(userId: string, attachmentId: string): void {
  const result = getDb()
    .query('DELETE FROM message_attachments WHERE id=? AND user_id=? AND message_id IS NULL')
    .run(attachmentId, userId);
  if (!result.changes) throw new AppError(404, 'NOT_FOUND', '图片不存在或已发送。');
}

/**
 * Binds uploads to a user message inside the caller's transaction. A retried
 * request may reference attachments already bound to the same message.
 */
export function bindAttachments(
  userId: string,
  conversationId: string,
  messageId: string,
  attachmentIds: string[],
): Attachment[] {
  const db = getDb();
  const bound: Attachment[] = [];
  attachmentIds.forEach((attachmentId, position) => {
    const row = db
      .query(
        'SELECT id,mime,width,height,size,message_id FROM message_attachments WHERE id=? AND user_id=? AND conversation_id=?',
      )
      .get(attachmentId, userId, conversationId) as Row | null;
    if (!row || (row.message_id && row.message_id !== messageId))
      throw new AppError(409, 'ATTACHMENT_UNAVAILABLE', '图片已失效，请重新选择后发送。');
    if (!row.message_id)
      db.query('UPDATE message_attachments SET message_id=?,position=? WHERE id=?').run(
        messageId,
        position,
        attachmentId,
      );
    bound.push(toAttachment(row));
  });
  return bound;
}

export function attachmentsFor(messageIds: string[]): Map<string, Attachment[]> {
  const result = new Map<string, Attachment[]>();
  if (!messageIds.length) return result;
  const db = getDb();
  // Chunk to stay well below SQLite's bound-parameter limit.
  for (let index = 0; index < messageIds.length; index += 500) {
    const chunk = messageIds.slice(index, index + 500);
    const rows = db
      .query(
        `SELECT id,message_id,mime,width,height,size FROM message_attachments WHERE message_id IN (${chunk.map(() => '?').join(',')}) ORDER BY position ASC`,
      )
      .all(...chunk) as Row[];
    for (const row of rows) {
      const key = String(row.message_id);
      const list = result.get(key) || [];
      list.push(toAttachment(row));
      result.set(key, list);
    }
  }
  return result;
}

/** Base64 image parts for the model request; only ever read for the requesting user. */
export function attachmentData(
  userId: string,
  attachmentIds: string[],
): { mime: string; data: string }[] {
  const db = getDb();
  return attachmentIds.flatMap((attachmentId) => {
    const row = db
      .query('SELECT mime,data FROM message_attachments WHERE id=? AND user_id=?')
      .get(attachmentId, userId) as Row | null;
    return row
      ? [{ mime: String(row.mime), data: Buffer.from(row.data as Uint8Array).toString('base64') }]
      : [];
  });
}

export function attachmentResponse(userId: string, attachmentId: string): Response {
  const row = getDb()
    .query(
      'SELECT a.mime,a.data FROM message_attachments a JOIN conversations c ON c.id=a.conversation_id WHERE a.id=? AND a.user_id=? AND c.user_id=?',
    )
    .get(attachmentId, userId, userId) as Row | null;
  if (!row) throw new AppError(404, 'NOT_FOUND', '图片不存在。');
  const bytes = new Uint8Array(row.data as Uint8Array);
  return new Response(bytes, {
    headers: {
      'Content-Type': String(row.mime),
      'Content-Length': String(bytes.byteLength),
      // Attachment ids are random and immutable; the browser may keep its private copy.
      'Cache-Control': 'private, max-age=31536000, immutable',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    },
  });
}
