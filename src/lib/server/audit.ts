import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AuditEntry, AuditResponse, AuditStats, AuditStatus, Protocol } from '@/lib/types';
import { getDb } from './db';
import { HttpError } from './http';
import { getSettings } from './settings';

const DAY = 24 * 60 * 60 * 1000;
const STALE_PENDING = 15 * 60 * 1000;
const STATUSES: AuditStatus[] = [
  'pending',
  'success',
  'error',
  'cancelled',
  'rejected',
  'replayed',
];
const PROTOCOLS: Protocol[] = ['anthropic', 'openai-chat', 'openai-responses', 'gemini'];

export interface AuditProvider {
  id: string;
  name: string;
  protocol: Protocol;
  model: string;
}

export interface BeginAuditInput {
  userId: string;
  username: string;
  conversationId: string;
  conversationTitle: string;
  kind: 'direct' | 'group';
  provider?: AuditProvider | null;
  characterNames: string[];
}

export interface FinishAuditInput {
  status: Exclude<AuditStatus, 'pending'>;
  provider?: AuditProvider | null;
  characterNames?: string[];
  replyCount?: number;
  outputCharacters?: number;
  quotaCharged?: 0 | 1;
  errorCode?: unknown;
  /** Accepted for caller ergonomics, but never stored. Codes map to curated messages. */
  errorMessage?: unknown;
}

interface AuditOptions {
  db?: DatabaseSync;
  now?: () => number;
  retentionDays?: () => number;
}

interface AuditRow {
  id: string;
  created_at: number;
  finished_at: number | null;
  status: AuditStatus;
  user_id: string;
  username: string;
  conversation_id: string;
  conversation_title: string;
  kind: 'direct' | 'group';
  provider_id: string | null;
  provider_name: string | null;
  protocol: Protocol | null;
  model: string | null;
  character_names: string;
  duration_ms: number | null;
  reply_count: number;
  output_characters: number;
  quota_charged: 0 | 1;
  error_code: string | null;
  error_message: string | null;
}

// Never persist an upstream body or caller-supplied error string, even for an unknown code.
const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  configuration: '模型服务配置无效或缺少访问凭据。',
  invalid_url: '模型服务地址格式无效。',
  unsafe_url: '模型服务地址未通过网络访问检查。',
  context_length: '最近的对话内容超出模型上下文限制。',
  cancelled: '用户停止了本轮回复。',
  timeout: '模型服务响应超时。',
  upstream_auth: '模型服务鉴权失败，请检查密钥与权限。',
  upstream_rate_limit: '模型服务触发请求频率限制。',
  upstream_unavailable: '模型服务暂时不可用或无法连接。',
  upstream_error: '模型服务未能完成本次请求。',
  invalid_response: '模型服务返回了无效、空白或未完成的回复。',
  content_filtered: '模型未能回复本次内容。',
  response_too_large: '模型返回内容超过接收上限。',
  PROVIDER_NOT_CONFIGURED: '尚未配置可用的模型服务。',
  PROVIDER_NOT_FOUND: '所选模型服务不可用。',
  QUOTA_EXCEEDED: '账号的滚动回复额度已用尽或已暂停。',
  QUOTA_RESERVATION_EXPIRED: '本轮额度预留已失效，内容未保存。',
  GENERATION_IN_PROGRESS: '该会话已有一轮正在生成。',
  GENERATION_CONFLICT: '会话状态发生变化，本轮未保存。',
  GENERATION_TIMEOUT: '本轮回复超时，内容未保存。',
  GENERATION_FAILED: '本轮回复未能完成，内容未保存。',
  GENERATION_INTERRUPTED: '请求超过处理期限，可能发生服务重启或连接中断。',
  REQUEST_CANCELLED: '用户取消了请求或断开了连接。',
  REQUEST_REJECTED: '本次请求未满足平台的处理条件。',
  ACCOUNT_DISABLED: '账号当前不可用。',
  UNAUTHORIZED: '登录状态已失效。',
  FORBIDDEN: '当前账号没有此操作权限。',
  RATE_LIMITED: '请求频率超过平台限制。',
  RESOURCE_LIMIT: '会话或消息数量已达到平台上限。',
  EMPTY_RESPONSE: '模型没有返回有效文本。',
  OUTPUT_LIMIT: '模型回复超出长度上限，本轮未保存。',
  CHARACTER_NOT_IN_CONVERSATION: '指定角色不属于当前会话。',
  AMBIGUOUS_CHARACTER_NAMES: '群聊中存在同名角色，无法明确匹配发言对象。',
  CHARACTER_NOT_FOUND: '会话角色未发布或已被移除。',
  CONVERSATION_NOT_FOUND: '会话已不存在或无法继续访问。',
  EMPTY_MESSAGE: '没有可处理的消息或角色发言请求。',
  IDEMPOTENCY_CONFLICT: '同一请求标识被用于不同的消息。',
  INVALID_REQUEST_ID: '请求标识格式无效。',
  VALIDATION_ERROR: '请求参数不符合平台要求。',
};

function cleanLabel(value: string, maximum: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .trim()
    .slice(0, maximum);
}

function characterNames(names: string[]): string[] {
  return [
    ...new Set(
      names
        .filter((name) => typeof name === 'string')
        .map((name) => cleanLabel(name, 60))
        .filter(Boolean),
    ),
  ].slice(0, 24);
}

function providerFields(
  provider: AuditProvider | null | undefined,
): [string | null, string | null, Protocol | null, string | null] {
  if (!provider) return [null, null, null, null];
  return [
    cleanLabel(provider.id, 100),
    cleanLabel(provider.name, 80),
    PROTOCOLS.includes(provider.protocol) ? provider.protocol : null,
    cleanLabel(provider.model, 160),
  ];
}

function safeError(input: FinishAuditInput): [string | null, string | null] {
  if (input.status === 'success' || input.status === 'replayed') return [null, null];
  const fallback =
    input.status === 'cancelled'
      ? 'REQUEST_CANCELLED'
      : input.status === 'rejected'
        ? 'REQUEST_REJECTED'
        : 'GENERATION_FAILED';
  const code =
    typeof input.errorCode === 'string' && Object.hasOwn(ERROR_MESSAGES, input.errorCode)
      ? input.errorCode
      : fallback;
  return [code, ERROR_MESSAGES[code]];
}

function nonNegativeInteger(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)))
    : 0;
}

function toEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    time: new Date(row.created_at).toISOString(),
    finishedAt: row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
    status: row.status,
    userId: row.user_id,
    username: row.username,
    conversationId: row.conversation_id,
    conversationTitle: row.conversation_title,
    kind: row.kind,
    providerId: row.provider_id,
    providerName: row.provider_name,
    protocol: row.protocol,
    model: row.model,
    characterNames: JSON.parse(row.character_names) as string[],
    durationMs: row.duration_ms,
    replyCount: row.reply_count,
    outputCharacters: row.output_characters,
    quotaCharged: row.quota_charged,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

function queryInteger(
  params: URLSearchParams,
  key: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const value = params.get(key);
  if (value === null || value === '') return fallback;
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw new HttpError(
      400,
      `审计筛选 ${key} 必须是 ${minimum}–${maximum} 之间的整数。`,
      'INVALID_AUDIT_FILTER',
    );
  }
  return Number(value);
}

/** Injectable clock/database keep audit tests isolated from application data and real requests. */
export function createAuditStore(options: AuditOptions = {}) {
  const database = () => options.db ?? getDb();
  const clock = options.now ?? Date.now;
  const retention = () => {
    const days = options.retentionDays ? options.retentionDays() : getSettings().auditRetentionDays;
    return Number.isInteger(days) && days >= 7 && days <= 365 ? days : 90;
  };

  function pruneAudit(timestamp = clock(), days = retention()): void {
    const db = database();
    db.prepare('DELETE FROM request_audit WHERE created_at<?').run(timestamp - days * DAY);
    // A generation is capped at ten minutes. Give its cancellation/commit five extra minutes.
    db.prepare(
      `UPDATE request_audit SET status='error', finished_at=created_at+?, duration_ms=?,
      error_code='GENERATION_INTERRUPTED', error_message=? WHERE status='pending' AND created_at<=?`,
    ).run(
      STALE_PENDING,
      STALE_PENDING,
      ERROR_MESSAGES.GENERATION_INTERRUPTED,
      timestamp - STALE_PENDING,
    );
  }

  function beginAudit(input: BeginAuditInput): string {
    const timestamp = clock();
    pruneAudit(timestamp);
    const id = randomUUID();
    const [providerId, providerName, protocol, model] = providerFields(input.provider);
    database()
      .prepare(
        `INSERT INTO request_audit (
      id,created_at,status,user_id,username,conversation_id,conversation_title,kind,
      provider_id,provider_name,protocol,model,character_names
    ) VALUES (?,?,'pending',?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        timestamp,
        cleanLabel(input.userId, 100),
        cleanLabel(input.username, 32),
        cleanLabel(input.conversationId, 100),
        cleanLabel(input.conversationTitle, 80),
        input.kind,
        providerId,
        providerName,
        protocol,
        model,
        JSON.stringify(characterNames(input.characterNames)),
      );
    return id;
  }

  /** No transaction is opened here: success belongs in the message + quota transaction. */
  function finishAudit(id: string, input: FinishAuditInput): boolean {
    if (!['success', 'error', 'cancelled', 'rejected', 'replayed'].includes(input.status))
      throw new HttpError(400, '审计终态无效。', 'INVALID_AUDIT_STATUS');
    const db = database();
    const row = db
      .prepare("SELECT created_at FROM request_audit WHERE id=? AND status='pending'")
      .get(id) as { created_at: number } | undefined;
    if (!row) return false;
    const finishedAt = Math.max(row.created_at, clock());
    const duration = finishedAt - row.created_at;
    const replayed = input.status === 'replayed';
    const [errorCode, errorMessage] = safeError(input);
    const values: (string | number | null)[] = [
      input.status,
      finishedAt,
      duration,
      replayed ? 0 : nonNegativeInteger(input.replyCount),
      replayed ? 0 : nonNegativeInteger(input.outputCharacters),
      input.status === 'success' && input.quotaCharged === 1 ? 1 : 0,
      errorCode,
      errorMessage,
    ];
    const assignments = [
      'status=?',
      'finished_at=?',
      'duration_ms=?',
      'reply_count=?',
      'output_characters=?',
      'quota_charged=?',
      'error_code=?',
      'error_message=?',
    ];
    if (input.provider !== undefined) {
      assignments.push('provider_id=?', 'provider_name=?', 'protocol=?', 'model=?');
      values.push(...providerFields(input.provider));
    }
    if (input.characterNames !== undefined) {
      assignments.push('character_names=?');
      values.push(JSON.stringify(characterNames(input.characterNames)));
    }
    values.push(id);
    const changed = db
      .prepare(`UPDATE request_audit SET ${assignments.join(',')} WHERE id=? AND status='pending'`)
      .run(...values);
    return Number(changed.changes) > 0;
  }

  function readAudit(params: URLSearchParams): AuditResponse {
    const requestedDays = queryInteger(params, 'days', 1, 365, 7);
    const page = queryInteger(params, 'page', 1, 1_000_000, 1);
    const pageSize = queryInteger(params, 'pageSize', 1, 100, 20);
    const status = params.get('status') || 'all';
    if (status !== 'all' && !STATUSES.includes(status as AuditStatus))
      throw new HttpError(400, '请选择有效的审计状态。', 'INVALID_AUDIT_FILTER');
    const query = (params.get('query') || '').trim();
    if (query.length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(query))
      throw new HttpError(400, '审计检索最多 100 个普通字符。', 'INVALID_AUDIT_FILTER');
    const timestamp = clock(),
      retentionDays = retention();
    const days = Math.min(requestedDays, retentionDays);
    const start = timestamp - days * DAY;
    pruneAudit(timestamp, retentionDays);
    const db = database();
    const where = ['created_at>?', 'created_at<=?'];
    const bindings: (string | number)[] = [start, timestamp];
    if (status !== 'all') {
      where.push('status=?');
      bindings.push(status);
    }
    if (query) {
      const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
      const fields = [
        'id',
        'user_id',
        'username',
        'conversation_title',
        'conversation_id',
        'provider_name',
        'model',
        'character_names',
      ];
      where.push(`(${fields.map((field) => `${field} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
      bindings.push(...fields.map(() => pattern));
    }
    const clause = where.join(' AND ');
    // Keep counters, list and trend in one snapshot even if another worker commits a turn.
    // A savepoint also works when the caller already owns a transaction.
    db.exec('SAVEPOINT chatpony_audit_read');
    try {
      const aggregate = db
        .prepare(
          `SELECT COUNT(*) AS requests,
      COALESCE(SUM(status='success'),0) AS success, COALESCE(SUM(status='error'),0) AS error,
      COALESCE(SUM(status='cancelled'),0) AS cancelled, COALESCE(SUM(status='rejected'),0) AS rejected,
      COALESCE(SUM(status='replayed'),0) AS replayed, COALESCE(SUM(status='pending'),0) AS pending,
      COALESCE(SUM(quota_charged),0) AS chargedTurns,
      COALESCE(SUM(CASE WHEN status='success' THEN reply_count ELSE 0 END),0) AS replies,
      COALESCE(AVG(CASE WHEN status IN('success','error','cancelled') THEN duration_ms END),0) AS averageDurationMs
      FROM request_audit WHERE ${clause}`,
        )
        .get(...bindings) as unknown as Omit<AuditStats, 'daily' | 'timeZone'>;
      const items = (
        db
          .prepare(
            `SELECT * FROM request_audit WHERE ${clause} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,
          )
          .all(...bindings, pageSize, (page - 1) * pageSize) as unknown as AuditRow[]
      ).map(toEntry);
      const dailyRows = db
        .prepare(
          `SELECT strftime('%Y-%m-%d',created_at/1000,'unixepoch') AS date,
      COUNT(*) AS requests, COALESCE(SUM(status='success'),0) AS success, COALESCE(SUM(status='error'),0) AS error
      FROM request_audit WHERE ${clause} GROUP BY date ORDER BY date`,
        )
        .all(...bindings) as unknown as AuditStats['daily'];
      const dailyMap = new Map(dailyRows.map((row) => [row.date, row]));
      const daily: AuditStats['daily'] = [];
      // Rolling windows can intersect one more UTC date than their nominal day count.
      for (
        let day = Math.floor(start / DAY) * DAY;
        day <= Math.floor(timestamp / DAY) * DAY;
        day += DAY
      ) {
        const date = new Date(day).toISOString().slice(0, 10);
        daily.push(dailyMap.get(date) ?? { date, requests: 0, success: 0, error: 0 });
      }
      return {
        entries: { items, total: aggregate.requests, page, pageSize },
        stats: {
          ...aggregate,
          averageDurationMs: Math.round(aggregate.averageDurationMs),
          daily,
          timeZone: 'UTC',
        },
        filters: { days, status: status as AuditStatus | 'all', query },
        retentionDays,
      };
    } finally {
      db.exec('RELEASE SAVEPOINT chatpony_audit_read');
    }
  }

  return { beginAudit, finishAudit, readAudit, pruneAudit };
}

const audit = createAuditStore();
export const beginAudit = audit.beginAudit;
export const finishAudit = audit.finishAudit;
export const readAudit = audit.readAudit;
export const pruneAudit = audit.pruneAudit;
