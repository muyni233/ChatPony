import { randomUUID } from 'node:crypto';
import type { Announcement, AnnouncementList } from '@/lib/announcements-types';
import { requireAdmin, requireUser } from './auth';
import { getDb, now, transaction } from './db';
import { booleanField, HttpError, json, readBody, textField } from './http';

interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  status: 'draft' | 'published';
  pinned: number;
  revision: number;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  read_at?: string | null;
}

function toAnnouncement(row: AnnouncementRow): Announcement {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    pinned: Boolean(row.pinned),
    revision: row.revision,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...('read_at' in row ? { readAt: row.read_at ?? null } : {}),
  };
}

export function unreadAnnouncements(userId: string): number {
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM announcements a
    LEFT JOIN announcement_reads r ON r.announcement_id=a.id AND r.user_id=? AND r.revision=a.revision
    WHERE a.status='published' AND r.announcement_id IS NULL`,
      )
      .get(userId) as { n: number }
  ).n;
}

function pagination(params: URLSearchParams) {
  const read = (key: string, fallback: number, maximum: number) => {
    const raw = params.get(key);
    const value = raw === null ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new HttpError(400, '公告分页参数无效。', 'VALIDATION_ERROR');
    return value;
  };
  return { page: read('page', 1, 100000), pageSize: read('pageSize', 12, 50) };
}

function listAnnouncements(params: URLSearchParams, userId?: string): AnnouncementList {
  const requested = pagination(params);
  return transaction(() => {
    const db = getDb();
    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM announcements${userId ? " WHERE status='published'" : ''}`,
        )
        .get() as { n: number }
    ).n;
    const page = Math.min(requested.page, Math.max(1, Math.ceil(total / requested.pageSize)));
    const rows = userId
      ? db
          .prepare(
            `SELECT a.*, r.read_at FROM announcements a
          LEFT JOIN announcement_reads r ON r.announcement_id=a.id AND r.user_id=? AND r.revision=a.revision
          WHERE a.status='published' ORDER BY a.pinned DESC,a.published_at DESC,a.created_at DESC,a.id DESC LIMIT ? OFFSET ?`,
          )
          .all(userId, requested.pageSize, (page - 1) * requested.pageSize)
      : db
          .prepare(
            'SELECT * FROM announcements ORDER BY pinned DESC,COALESCE(published_at,created_at) DESC,id DESC LIMIT ? OFFSET ?',
          )
          .all(requested.pageSize, (page - 1) * requested.pageSize);
    return {
      items: (rows as unknown as AnnouncementRow[]).map(toAnnouncement),
      total,
      page,
      pageSize: requested.pageSize,
      ...(userId ? { unreadCount: unreadAnnouncements(userId) } : {}),
    };
  });
}

function expectedRevision(body: Record<string, unknown>) {
  if (
    typeof body.revision !== 'number' ||
    !Number.isSafeInteger(body.revision) ||
    body.revision < 1
  )
    throw new HttpError(400, '缺少公告版本，请刷新后重试。', 'VALIDATION_ERROR');
  return body.revision;
}

function publishedAnnouncement(id: string, userId: string) {
  const row = getDb()
    .prepare(
      `SELECT a.*, r.read_at FROM announcements a
    LEFT JOIN announcement_reads r ON r.announcement_id=a.id AND r.user_id=? AND r.revision=a.revision
    WHERE a.id=? AND a.status='published'`,
    )
    .get(userId, id) as unknown as AnnouncementRow | undefined;
  if (!row) throw new HttpError(404, '此公告不存在或已撤回。', 'ANNOUNCEMENT_NOT_FOUND');
  return row;
}

export async function userAnnouncements(request: Request, id?: string, action?: string) {
  const user = requireUser(request);
  if (request.method === 'GET' && !action) {
    if (!id) return json(listAnnouncements(new URL(request.url).searchParams, user.id));
    if (id === 'unread') return json({ unreadCount: unreadAnnouncements(user.id) });
    return json({ announcement: toAnnouncement(publishedAnnouncement(id, user.id)) });
  }
  if (request.method === 'POST' && id && action === 'read') {
    const revision = expectedRevision(await readBody(request));
    requireUser(request);
    return transaction(() => {
      const row = publishedAnnouncement(id, user.id);
      if (row.revision !== revision)
        throw new HttpError(409, '公告内容已更新，请重新打开后阅读。', 'ANNOUNCEMENT_CHANGED');
      getDb()
        .prepare(
          `INSERT INTO announcement_reads(announcement_id,user_id,revision,read_at) VALUES (?,?,?,?)
        ON CONFLICT(announcement_id,user_id) DO UPDATE SET revision=excluded.revision,read_at=excluded.read_at`,
        )
        .run(id, user.id, revision, now());
      return json({ ok: true, unreadCount: unreadAnnouncements(user.id) });
    });
  }
  throw new HttpError(404, '接口不存在或不支持此操作。', 'NOT_FOUND');
}

export async function adminAnnouncements(request: Request, id?: string) {
  requireAdmin(request);
  if (request.method === 'GET' && !id)
    return json(listAnnouncements(new URL(request.url).searchParams));
  const body = request.method === 'DELETE' ? {} : await readBody(request);
  requireAdmin(request);
  return transaction(() => {
    const db = getDb();
    const existing = id
      ? (db.prepare('SELECT * FROM announcements WHERE id=?').get(id) as unknown as
          AnnouncementRow | undefined)
      : undefined;
    if (id && !existing)
      throw new HttpError(404, '此公告不存在或已删除。', 'ANNOUNCEMENT_NOT_FOUND');
    if (request.method === 'DELETE' && id) {
      db.prepare('DELETE FROM announcements WHERE id=?').run(id);
      return json({ ok: true });
    }
    if (existing && expectedRevision(body) !== existing.revision)
      throw new HttpError(409, '公告已被修改，请刷新列表后重新编辑。', 'ANNOUNCEMENT_CHANGED');
    const title = textField(body, 'title', 120, 1, existing?.title);
    const content = textField(body, 'body', 12000, 1, existing?.body);
    const status = body.status ?? existing?.status ?? 'draft';
    if (status !== 'draft' && status !== 'published')
      throw new HttpError(400, '请选择草稿或已发布。', 'VALIDATION_ERROR');
    const pinned = Number(booleanField(body, 'pinned', Boolean(existing?.pinned)));
    // Re-saving unchanged text must not create new unread notifications.
    if (
      existing &&
      title === existing.title &&
      content === existing.body &&
      status === existing.status &&
      pinned === existing.pinned
    )
      return json({ announcement: toAnnouncement(existing) });
    const timestamp = now();
    const publishedAt =
      status === 'published'
        ? existing?.status === 'published'
          ? existing.published_at
          : timestamp
        : null;
    let announcementId = id;
    if (existing) {
      db.prepare(
        'UPDATE announcements SET title=?,body=?,status=?,pinned=?,revision=revision+1,published_at=?,updated_at=? WHERE id=?',
      ).run(title, content, status, pinned, publishedAt, timestamp, id!);
    } else {
      if ((db.prepare('SELECT COUNT(*) AS n FROM announcements').get() as { n: number }).n >= 1000)
        throw new HttpError(409, '公告数量已达 1000 条，请先清理旧公告。', 'RESOURCE_LIMIT');
      announcementId = randomUUID();
      db.prepare(
        'INSERT INTO announcements(id,title,body,status,pinned,published_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run(announcementId, title, content, status, pinned, publishedAt, timestamp, timestamp);
    }
    return json(
      {
        announcement: toAnnouncement(
          db
            .prepare('SELECT * FROM announcements WHERE id=?')
            .get(announcementId!) as unknown as AnnouncementRow,
        ),
      },
      existing ? 200 : 201,
    );
  });
}
