import { randomUUID } from 'node:crypto';
import type { QuotaStatus, QuotaWindow } from '@/lib/types';
import { getDb, transaction } from './db';
import { HttpError } from './http';
import { getSettings } from './settings';

const FIVE_HOURS = 5 * 60 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

interface WindowPolicy {
  column: 'quota_5h_epoch' | 'quota_1d_epoch' | 'quota_7d_epoch';
  limit: number;
  enabled: boolean;
  epoch: number;
  duration: number;
}
interface QuotaUser {
  quota_5h: number | null;
  quota_1d: number | null;
  quota_7d: number | null;
  quota_5h_enabled: number | null;
  quota_1d_enabled: number | null;
  quota_7d_enabled: number | null;
  quota_5h_epoch: number;
  quota_1d_epoch: number;
  quota_7d_epoch: number;
}

function policies(userId: string): [WindowPolicy, WindowPolicy, WindowPolicy] {
  const user = getDb()
    .prepare(
      `SELECT quota_5h,quota_1d,quota_7d,quota_5h_enabled,quota_1d_enabled,quota_7d_enabled,
    quota_5h_epoch,quota_1d_epoch,quota_7d_epoch FROM users WHERE id=? AND disabled=0`,
    )
    .get(userId) as QuotaUser | undefined;
  if (!user) throw new HttpError(403, '账号当前不可用。', 'ACCOUNT_DISABLED');
  const settings = getSettings();
  return [
    {
      column: 'quota_5h_epoch',
      epoch: user.quota_5h_epoch,
      limit: user.quota_5h ?? settings.quota5h,
      enabled: user.quota_5h_enabled === null ? settings.quota5hEnabled : !!user.quota_5h_enabled,
      duration: FIVE_HOURS,
    },
    {
      column: 'quota_1d_epoch',
      epoch: user.quota_1d_epoch,
      limit: user.quota_1d ?? settings.quota1d,
      enabled: user.quota_1d_enabled === null ? settings.quota1dEnabled : !!user.quota_1d_enabled,
      duration: ONE_DAY,
    },
    {
      column: 'quota_7d_epoch',
      epoch: user.quota_7d_epoch,
      limit: user.quota_7d ?? settings.quota7d,
      enabled: user.quota_7d_enabled === null ? settings.quota7dEnabled : !!user.quota_7d_enabled,
      duration: SEVEN_DAYS,
    },
  ];
}

function quotaWindow(
  userId: string,
  policy: WindowPolicy,
  timestamp: number,
  reserved: number,
): QuotaWindow {
  const db = getDb();
  const { column, epoch, limit, enabled, duration } = policy;
  const boundary = timestamp - duration;
  const used = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM quota_usage WHERE user_id=? AND charged_at>? AND ${column}=?`,
      )
      .get(userId, boundary, epoch) as { n: number }
  ).n;
  const total = used + reserved;
  let resetsAt: string | null = null;
  if (enabled && limit > 0 && total > 0) {
    // After a limit reduction, enough old charges must leave the window to
    // admit another turn. The very first expiry may not release usable quota.
    const offset = Math.max(0, total - limit);
    const next = db
      .prepare(
        `SELECT releases_at FROM (
      SELECT charged_at + ? AS releases_at FROM quota_usage WHERE user_id=? AND charged_at>? AND ${column}=?
      UNION ALL
      SELECT expires_at AS releases_at FROM quota_reservations WHERE user_id=? AND expires_at>?
    ) ORDER BY releases_at LIMIT 1 OFFSET ?`,
      )
      .get(duration, userId, boundary, epoch, userId, timestamp, offset) as
      { releases_at: number } | undefined;
    if (next) resetsAt = new Date(next.releases_at).toISOString();
  }
  return {
    enabled,
    limit,
    used,
    reserved,
    remaining: enabled ? Math.max(0, limit - total) : null,
    resetsAt,
  };
}

function statusWithinTransaction(userId: string, timestamp: number): QuotaStatus {
  const db = getDb();
  const [fiveHour, oneDay, sevenDay] = policies(userId);
  const reserved = (
    db
      .prepare('SELECT COUNT(*) AS n FROM quota_reservations WHERE user_id=? AND expires_at>?')
      .get(userId, timestamp) as { n: number }
  ).n;
  return {
    fiveHour: quotaWindow(userId, fiveHour, timestamp, reserved),
    oneDay: quotaWindow(userId, oneDay, timestamp, reserved),
    sevenDay: quotaWindow(userId, sevenDay, timestamp, reserved),
  };
}

export function getQuotaStatus(userId: string): QuotaStatus {
  return transaction(() => statusWithinTransaction(userId, Date.now()));
}

export function reserveQuota(
  userId: string,
  conversationId: string,
  requestId: string,
  expiresAt: number,
): string {
  return transaction(() => {
    const db = getDb(),
      timestamp = Date.now();
    db.prepare('DELETE FROM quota_reservations WHERE expires_at<=?').run(timestamp);
    const status = statusWithinTransaction(userId, timestamp);
    const windows = [
      { label: '5 小时', ...status.fiveHour },
      { label: '1 天', ...status.oneDay },
      { label: '7 天', ...status.sevenDay },
    ];
    const exhausted = windows.filter((window) => window.enabled && window.remaining === 0);
    if (exhausted.length) {
      const message = exhausted.some((window) => window.limit === 0)
        ? '当前账号的 AI 回复额度已暂停，请联系管理员调整。普通群聊消息仍可发送。'
        : `已达到${exhausted.map((window) => window.label).join('、')}滚动额度。请等待已用额度逐次恢复，或联系管理员；普通群聊消息仍可发送。`;
      throw new HttpError(429, message, 'QUOTA_EXCEEDED');
    }
    const id = randomUUID();
    db.prepare(
      'INSERT INTO quota_reservations(id,user_id,conversation_id,request_id,created_at,expires_at) VALUES (?,?,?,?,?,?)',
    ).run(id, userId, conversationId, requestId, timestamp, expiresAt);
    return id;
  });
}

// The caller must be inside the same transaction that persists the messages.
// Replacing the hold with a charge is atomic, including when a later write fails.
export function commitQuota(reservationId: string): 0 | 1 {
  const db = getDb(),
    timestamp = Date.now();
  const hold = db
    .prepare(
      'SELECT user_id,conversation_id,request_id FROM quota_reservations WHERE id=? AND expires_at>?',
    )
    .get(reservationId, timestamp) as
    { user_id: string; conversation_id: string; request_id: string } | undefined;
  if (!hold)
    throw new HttpError(
      409,
      '本轮额度预留已失效，内容尚未保存，请重试。',
      'QUOTA_RESERVATION_EXPIRED',
    );
  const current = policies(hold.user_id);
  // Resets do not release active holds. A finishing turn joins the current
  // epoch of every window, even if it began before that window was reset.
  db.prepare(
    `INSERT INTO quota_usage(id,user_id,conversation_id,request_id,charged_at,quota_5h_epoch,quota_1d_epoch,quota_7d_epoch)
    VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    reservationId,
    hold.user_id,
    hold.conversation_id,
    hold.request_id,
    timestamp,
    ...current.map((policy) => policy.epoch),
  );
  db.prepare('DELETE FROM quota_reservations WHERE id=?').run(reservationId);
  return current.some((policy) => policy.enabled) ? 1 : 0;
}

export function releaseQuota(reservationId: string) {
  getDb().prepare('DELETE FROM quota_reservations WHERE id=?').run(reservationId);
}
