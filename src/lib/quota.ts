import { getDb, id, now } from './db';
import { AppError } from './errors';
import type { QuotaSnapshot, QuotaWindow } from './types';
import type { Row } from './mappers';

const FIVE_HOURS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

function expireReservations(time: string): void {
  getDb()
    .query(
      "UPDATE api_calls SET status='failed', finished_at=? WHERE status='pending' AND created_at < ?",
    )
    .run(time, new Date(Date.parse(time) - 15 * 60 * 1000).toISOString());
}

function snapshot(user: Row, time: string): QuotaSnapshot {
  const window = (milliseconds: number, limit: number): QuotaWindow => {
    const cutoff = new Date(Date.parse(time) - milliseconds).toISOString();
    const usage = getDb()
      .query(
        "SELECT COUNT(*) AS used, MIN(counted_at) AS first_call FROM api_calls WHERE user_id=? AND status IN ('pending','success') AND counted_at>? AND counted_at>=?",
      )
      .get(String(user.id), cutoff, String(user.quota_reset_at)) as Row;
    const used = Number(usage.used);
    return {
      used,
      limit,
      remaining: Math.max(0, limit - used),
      resetsAt: usage.first_call
        ? new Date(Date.parse(String(usage.first_call)) + milliseconds).toISOString()
        : null,
    };
  };
  return {
    fiveHour: window(FIVE_HOURS, Number(user.limit_5h)),
    sevenDay: window(SEVEN_DAYS, Number(user.limit_7d)),
  };
}

export function getQuota(userId: string): QuotaSnapshot {
  const db = getDb();
  return db
    .transaction(() => {
      const time = now();
      expireReservations(time);
      const user = db.query('SELECT * FROM users WHERE id=?').get(userId) as Row | null;
      if (!user) throw new AppError(404, 'USER_NOT_FOUND', '用户不存在。');
      return snapshot(user, time);
    })
    .immediate();
}

/** All limit checks and the insertion share an IMMEDIATE SQLite transaction. */
export function reserveCall(userId: string, conversationId: string, characterId: string): string {
  const db = getDb();
  return db
    .transaction(() => {
      const time = now();
      expireReservations(time);
      const user = db.query('SELECT * FROM users WHERE id=?').get(userId) as Row | null;
      if (!user || user.disabled) throw new AppError(403, 'ACCOUNT_DISABLED', '此账号当前不可用。');
      const quota = snapshot(user, time);
      if (quota.fiveHour.remaining <= 0 || quota.sevenDay.remaining <= 0)
        throw new AppError(
          429,
          'QUOTA_EXCEEDED',
          quota.fiveHour.remaining <= 0
            ? '已达到 5 小时调用限额，请在额度恢复后继续。'
            : '已达到 7 天调用限额，请在额度恢复后继续。',
        );
      const reservationId = id();
      db.query(
        "INSERT INTO api_calls(id,user_id,conversation_id,character_id,status,created_at,counted_at) VALUES(?,?,?,?,'pending',?,?)",
      ).run(reservationId, userId, conversationId, characterId, time, time);
      return reservationId;
    })
    .immediate();
}

export function finishCall(reservationId: string, success: boolean): void {
  getDb()
    .query("UPDATE api_calls SET status=?, finished_at=? WHERE id=? AND status='pending'")
    .run(success ? 'success' : 'failed', now(), reservationId);
}

/** Resets settled usage while retaining reservations already in flight. */
export function resetQuota(userId?: string): number {
  const db = getDb();
  return db
    .transaction(() => {
      const time = now();
      expireReservations(time);
      if (userId && !db.query('SELECT id FROM users WHERE id=?').get(userId))
        throw new AppError(404, 'USER_NOT_FOUND', '用户不存在。');
      const count = userId
        ? db.query('UPDATE users SET quota_reset_at=? WHERE id=?').run(time, userId).changes
        : db.query('UPDATE users SET quota_reset_at=?').run(time).changes;
      // Moving settled usage one millisecond behind the reset avoids same-ms collisions.
      const before = new Date(Date.parse(time) - 1).toISOString();
      if (userId) {
        db.query("UPDATE api_calls SET counted_at=? WHERE user_id=? AND status='pending'").run(
          time,
          userId,
        );
        db.query(
          "UPDATE api_calls SET counted_at=? WHERE user_id=? AND status='success' AND counted_at>=?",
        ).run(before, userId, time);
      } else {
        db.query("UPDATE api_calls SET counted_at=? WHERE status='pending'").run(time);
        db.query("UPDATE api_calls SET counted_at=? WHERE status='success' AND counted_at>=?").run(
          before,
          time,
        );
      }
      return count;
    })
    .immediate();
}
