use chrono::{DateTime, Duration, Utc};
use rusqlite::{Connection, OptionalExtension};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::models::{QuotaSnapshot, QuotaWindow, iso_from_utc, new_id, now_iso};

const PENDING_TIMEOUT_MINS: i64 = 15;

pub fn parse_utc(raw: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(raw)
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(|_| DateTime::<Utc>::from_timestamp(0, 0).unwrap())
}

fn expire_stale_pending(conn: &Connection, user_id: &str, now: DateTime<Utc>) -> AppResult<()> {
    let pending_cutoff = iso_from_utc(now - Duration::minutes(PENDING_TIMEOUT_MINS));
    let now_str = iso_from_utc(now);
    conn.execute(
        "UPDATE api_calls
         SET status='failed', finished_at=?
         WHERE user_id=? AND status='pending' AND created_at < ?",
        rusqlite::params![now_str, user_id, pending_cutoff],
    )?;
    Ok(())
}

fn read_window(
    conn: &Connection,
    user_id: &str,
    since_iso: &str,
    limit: i64,
    window_dur: Duration,
) -> AppResult<QuotaWindow> {
    let (used, oldest): (i64, Option<String>) = conn.query_row(
        "SELECT COUNT(*), MIN(counted_at)
         FROM api_calls
         WHERE user_id=? AND status IN ('pending','success') AND counted_at >= ?",
        rusqlite::params![user_id, since_iso],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let resets_at = oldest
        .filter(|_| used > 0)
        .map(|ts| iso_from_utc(parse_utc(&ts) + window_dur));
    let remaining = (limit - used).max(0);
    Ok(QuotaWindow {
        used,
        limit,
        remaining,
        resets_at,
    })
}

pub fn get_quota_conn(conn: &Connection, user_id: &str) -> AppResult<QuotaSnapshot> {
    let row: Option<(i64, i64, String)> = conn
        .query_row(
            "SELECT limit_5h, limit_7d, quota_reset_at FROM users WHERE id=?",
            rusqlite::params![user_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((limit_5h, limit_7d, quota_reset_at)) = row else {
        return Err(AppError::not_found("USER_NOT_FOUND", "用户不存在。"));
    };

    let now = Utc::now();
    let reset_dt = parse_utc(&quota_reset_at);
    let cutoff_5h = iso_from_utc((now - Duration::hours(5)).max(reset_dt));
    let cutoff_7d = iso_from_utc((now - Duration::days(7)).max(reset_dt));
    let pending_cutoff = iso_from_utc(now - Duration::minutes(PENDING_TIMEOUT_MINS));

    // Read counts excluding stale pending even in read-only connections
    let window_5h = read_window_with_stale(conn, user_id, &cutoff_5h, &pending_cutoff, limit_5h, Duration::hours(5))?;
    let window_7d = read_window_with_stale(conn, user_id, &cutoff_7d, &pending_cutoff, limit_7d, Duration::days(7))?;

    Ok(QuotaSnapshot {
        five_hour: window_5h,
        seven_day: window_7d,
    })
}

fn read_window_with_stale(
    conn: &Connection,
    user_id: &str,
    since_iso: &str,
    pending_cutoff: &str,
    limit: i64,
    window_dur: Duration,
) -> AppResult<QuotaWindow> {
    let (used, oldest): (i64, Option<String>) = conn.query_row(
        "SELECT COUNT(*), MIN(counted_at)
         FROM api_calls
         WHERE user_id=? AND counted_at >= ?
           AND (status='success' OR (status='pending' AND created_at >= ?))",
        rusqlite::params![user_id, since_iso, pending_cutoff],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let resets_at = oldest
        .filter(|_| used > 0)
        .map(|ts| iso_from_utc(parse_utc(&ts) + window_dur));
    Ok(QuotaWindow {
        used,
        limit,
        remaining: (limit - used).max(0),
        resets_at,
    })
}

pub fn get_quota(db: &Db, user_id: &str) -> AppResult<QuotaSnapshot> {
    db.read(|conn| get_quota_conn(conn, user_id))
}

pub fn reserve_call(
    db: &Db,
    user_id: &str,
    conversation_id: Option<&str>,
    character_id: Option<&str>,
) -> AppResult<String> {
    db.write(|tx| {
        let row: Option<(i64, i64, String)> = tx
            .query_row(
                "SELECT limit_5h, limit_7d, quota_reset_at FROM users WHERE id=?",
                rusqlite::params![user_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((limit_5h, limit_7d, quota_reset_at)) = row else {
            return Err(AppError::unauthorized("账户不存在或登录已失效。"));
        };

        let now = Utc::now();
        expire_stale_pending(tx, user_id, now)?;

        let reset_dt = parse_utc(&quota_reset_at);
        let cutoff_5h = iso_from_utc((now - Duration::hours(5)).max(reset_dt));
        let cutoff_7d = iso_from_utc((now - Duration::days(7)).max(reset_dt));

        let w5 = read_window(tx, user_id, &cutoff_5h, limit_5h, Duration::hours(5))?;
        if w5.used >= w5.limit {
            return Err(AppError::too_many_requests(
                "QUOTA_5H_EXCEEDED",
                "已达到 5 小时调用上限，请稍后再试。",
            ));
        }
        let w7 = read_window(tx, user_id, &cutoff_7d, limit_7d, Duration::days(7))?;
        if w7.used >= w7.limit {
            return Err(AppError::too_many_requests(
                "QUOTA_7D_EXCEEDED",
                "已达到 7 天调用上限，请联系管理员或等待额度恢复。",
            ));
        }

        let id = new_id();
        let now_str = iso_from_utc(now);
        tx.execute(
            "INSERT INTO api_calls(id,user_id,conversation_id,character_id,status,created_at,counted_at)
             VALUES(?,?,?,?,'pending',?,?)",
            rusqlite::params![id, user_id, conversation_id, character_id, now_str, now_str],
        )?;
        Ok(id)
    })
}

pub fn finish_call(db: &Db, call_id: &str, success: bool) {
    let status = if success { "success" } else { "failed" };
    let now = now_iso();
    let res = db.write(|tx| {
        tx.execute(
            "UPDATE api_calls SET status=?, finished_at=? WHERE id=? AND status='pending'",
            rusqlite::params![status, now, call_id],
        )?;
        Ok(())
    });
    if let Err(err) = res {
        tracing::warn!("Failed to finish quota call {}: {:?}", call_id, err);
    }
}

pub fn reset_quota(db: &Db, user_id: &str) -> AppResult<QuotaSnapshot> {
    db.write(|tx| {
        let now = now_iso();
        let updated = tx.execute(
            "UPDATE users SET quota_reset_at=? WHERE id=?",
            rusqlite::params![now, user_id],
        )?;
        if updated == 0 {
            return Err(AppError::not_found("USER_NOT_FOUND", "用户不存在。"));
        }
        get_quota_conn(tx, user_id)
    })
}
