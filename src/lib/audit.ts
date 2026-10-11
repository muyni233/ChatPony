import { getDb, id, now } from './db';
import { AppError } from './errors';
import type { Row } from './mappers';

export type AuditKind = 'chat' | 'embedding' | 'connection-test' | 'compression' | 'memory-summary';
export type AuditStatus = 'pending' | 'success' | 'failed' | 'cancelled';
export interface AuditContext {
  kind?: AuditKind;
  userId?: string | null;
  conversationId?: string | null;
  characterId?: string | null;
  supplierId?: string | null;
  modelId?: string | null;
  requestId?: string | null;
}
export interface AuditEntry {
  id: string;
  kind: AuditKind;
  userId: string | null;
  userName: string | null;
  conversationId: string | null;
  characterId: string | null;
  characterName: string | null;
  supplierId: string | null;
  supplierName: string | null;
  modelId: string | null;
  protocol: string;
  model: string;
  endpoint: string;
  status: AuditStatus;
  httpStatus: number | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
  requestId: string | null;
  attempt: number;
  requestTruncated: boolean;
  responseTruncated: boolean;
}
interface AuditHandle {
  id: string;
  start: number;
  capture: boolean;
  secrets: string[];
}
const BODY_LIMIT = 16 * 1024;
const META_COLUMNS =
  'id,kind,user_id,user_name,conversation_id,character_id,character_name,supplier_id,supplier_name,model_id,protocol,model,endpoint,status,http_status,duration_ms,input_tokens,output_tokens,error_code,error_message,created_at,finished_at,request_id,attempt,request_truncated,response_truncated';
let checkedAt = 0;
let checkedDatabase = '';

function preferences(): { capture: boolean; retention: number } {
  const rows = getDb()
    .query(
      "SELECT key,value FROM settings WHERE key IN ('auditCaptureContent','auditRetentionDays')",
    )
    .all() as Row[];
  const values = Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)]));
  return {
    capture: values.auditCaptureContent === 'true',
    retention: Math.max(1, Math.min(90, Number(values.auditRetentionDays) || 7)),
  };
}

/** Indexed, bounded cleanup runs at most once per five minutes across all processes. */
function pruneAudits(): void {
  const database = process.env.DATABASE_PATH || './data/chatpony.db';
  if (database === checkedDatabase && Date.now() - checkedAt < 30_000) return;
  checkedAt = Date.now();
  checkedDatabase = database;
  const db = getDb();
  db.transaction(() => {
    const checkpoint = db
      .query("SELECT value FROM settings WHERE key='auditLastPrune'")
      .get() as Row | null;
    if (checkpoint && Date.now() - Number(checkpoint.value) < 300_000) return;
    const timestamp = now();
    const cutoff = new Date(Date.now() - preferences().retention * 86_400_000).toISOString();
    db.query(
      'DELETE FROM request_audits WHERE id IN (SELECT id FROM request_audits WHERE created_at<? ORDER BY created_at ASC LIMIT 1000)',
    ).run(cutoff);
    db.query(
      "UPDATE request_audits SET status='failed',error_code='REQUEST_INTERRUPTED',error_message='请求未留下完成记录，可能因服务进程中断。',finished_at=? WHERE id IN (SELECT id FROM request_audits WHERE status='pending' AND created_at<? LIMIT 1000)",
    ).run(timestamp, new Date(Date.now() - 15 * 60_000).toISOString());
    db.query(
      "INSERT INTO settings(key,value) VALUES('auditLastPrune',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(String(Date.now()));
  }).immediate();
}

function redactString(value: string, secrets: string[]): string {
  let safe = value;
  for (const secret of secrets) if (secret) safe = safe.split(secret).join('[REDACTED]');
  return safe.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]');
}

function safeJson(value: unknown, secrets: string[]): { body: string | null; truncated: boolean } {
  if (value === undefined || value === null) return { body: null, truncated: false };
  const serialized = JSON.stringify(value, (key, item: unknown) => {
    if (
      /^(?:authorization|proxy-authorization|api[-_]?key|x-api-key|x-goog-api-key|password|access_token|refresh_token)$/i.test(
        key,
      )
    )
      return '[REDACTED]';
    return typeof item === 'string' ? redactString(item, secrets) : item;
  });
  const bytes = new TextEncoder().encode(serialized);
  if (bytes.length <= BODY_LIMIT) return { body: serialized, truncated: false };
  // Streaming mode excludes an incomplete final UTF-8 code point.
  return {
    body: new TextDecoder().decode(bytes.slice(0, BODY_LIMIT), { stream: true }),
    truncated: true,
  };
}

export function sanitizedEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[invalid endpoint]';
  }
}

/** Logging is best effort: storage trouble must never alter the actual upstream request or billing. */
export function beginAudit(
  input: AuditContext & {
    kind: AuditKind;
    protocol: string;
    model: string;
    endpoint: string;
    attempt?: number;
    requestBody?: unknown;
    secrets?: string[];
  },
): AuditHandle | null {
  try {
    pruneAudits();
    const db = getDb();
    const capture = preferences().capture;
    const secrets = input.secrets || [];
    const request = capture
      ? safeJson(input.requestBody, secrets)
      : { body: null, truncated: false };
    const name = (table: 'users' | 'characters' | 'suppliers', key?: string | null) => {
      if (!key) return null;
      const row = db.query(`SELECT name FROM ${table} WHERE id=?`).get(key) as Row | null;
      return row ? redactString(String(row.name), secrets).slice(0, 200) : null;
    };
    const auditId = id();
    db.query(
      "INSERT INTO request_audits(id,kind,user_id,user_name,conversation_id,character_id,character_name,supplier_id,supplier_name,model_id,protocol,model,endpoint,status,created_at,request_id,attempt,request_body,request_truncated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?)",
    ).run(
      auditId,
      input.kind,
      input.userId || null,
      name('users', input.userId),
      input.conversationId || null,
      input.characterId || null,
      name('characters', input.characterId),
      input.supplierId || null,
      name('suppliers', input.supplierId),
      input.modelId || null,
      input.protocol.slice(0, 60),
      redactString(input.model, secrets).slice(0, 200),
      redactString(sanitizedEndpoint(input.endpoint), secrets).slice(0, 2048),
      now(),
      input.requestId ? redactString(input.requestId, secrets).slice(0, 240) : null,
      Math.max(1, input.attempt || 1),
      request.body,
      Number(request.truncated),
    );
    return { id: auditId, start: performance.now(), capture, secrets };
  } catch {
    return null;
  }
}

function validTokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Only provider-reported values are accepted; no prompt-length estimates enter audit totals. */
export function reportedUsage(payload: unknown): {
  inputTokens: number | null;
  outputTokens: number | null;
} {
  const object = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const usage =
    object.usage && typeof object.usage === 'object'
      ? (object.usage as Record<string, unknown>)
      : {};
  const native =
    object.usageMetadata && typeof object.usageMetadata === 'object'
      ? (object.usageMetadata as Record<string, unknown>)
      : {};
  return {
    inputTokens:
      validTokens(usage.input_tokens) ??
      validTokens(usage.prompt_tokens) ??
      validTokens(native.promptTokenCount),
    outputTokens:
      validTokens(usage.output_tokens) ??
      validTokens(usage.completion_tokens) ??
      validTokens(native.candidatesTokenCount),
  };
}

export function finishAudit(
  handle: AuditHandle | null,
  result: {
    status: Exclude<AuditStatus, 'pending'>;
    httpStatus?: number;
    responseBody?: unknown;
    inputTokens?: number | null;
    outputTokens?: number | null;
    errorCode?: string;
    errorMessage?: string;
  },
): void {
  if (!handle) return;
  try {
    // Turning capture off during a request prevents storing its later response body.
    const capture = handle.capture && preferences().capture;
    const response = capture
      ? safeJson(result.responseBody, handle.secrets)
      : { body: null, truncated: false };
    getDb()
      .query(
        "UPDATE request_audits SET status=?,http_status=?,duration_ms=?,input_tokens=?,output_tokens=?,error_code=?,error_message=?,response_body=?,response_truncated=?,finished_at=? WHERE id=? AND status='pending'",
      )
      .run(
        result.status,
        result.httpStatus ?? null,
        Math.max(0, Math.round(performance.now() - handle.start)),
        validTokens(result.inputTokens),
        validTokens(result.outputTokens),
        result.errorCode?.slice(0, 100) || null,
        result.errorMessage
          ? redactString(result.errorMessage, handle.secrets).slice(0, 500)
          : null,
        response.body,
        Number(response.truncated),
        now(),
        handle.id,
      );
  } catch {
    /* An audit failure cannot roll back a successful reply or charge. */
  }
}

const nullableString = (value: unknown) => (value == null ? null : String(value));
const nullableNumber = (value: unknown) => (value == null ? null : Number(value));
function entry(row: Row): AuditEntry {
  return {
    id: String(row.id),
    kind: row.kind as AuditKind,
    userId: nullableString(row.user_id),
    userName: nullableString(row.user_name),
    conversationId: nullableString(row.conversation_id),
    characterId: nullableString(row.character_id),
    characterName: nullableString(row.character_name),
    supplierId: nullableString(row.supplier_id),
    supplierName: nullableString(row.supplier_name),
    modelId: nullableString(row.model_id),
    protocol: String(row.protocol),
    model: String(row.model),
    endpoint: String(row.endpoint),
    status: row.status as AuditStatus,
    httpStatus: nullableNumber(row.http_status),
    durationMs: nullableNumber(row.duration_ms),
    inputTokens: nullableNumber(row.input_tokens),
    outputTokens: nullableNumber(row.output_tokens),
    errorCode: nullableString(row.error_code),
    errorMessage: nullableString(row.error_message),
    createdAt: String(row.created_at),
    finishedAt: nullableString(row.finished_at),
    requestId: nullableString(row.request_id),
    attempt: Number(row.attempt),
    requestTruncated: Boolean(row.request_truncated),
    responseTruncated: Boolean(row.response_truncated),
  };
}

export function listAudit(query: Record<string, string | undefined> = {}): {
  items: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
} {
  pruneAudits();
  const numeric = (key: string, fallback: number) => {
    const value = query[key] ? Number(query[key]) : fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000)
      throw new AppError(400, 'VALIDATION_ERROR', '分页参数无效。');
    return value;
  };
  const page = numeric('page', 1);
  const pageSize = Math.min(50, numeric('pageSize', 20));
  const clauses: string[] = [];
  const values: string[] = [];
  for (const [parameter, column] of [
    ['userId', 'user_id'],
    ['supplierId', 'supplier_id'],
    ['modelId', 'model_id'],
  ]) {
    if (query[parameter]) {
      if (query[parameter]!.length > 128)
        throw new AppError(400, 'VALIDATION_ERROR', '筛选标识过长。');
      clauses.push(`${column}=?`);
      values.push(query[parameter]!);
    }
  }
  for (const [parameter, allowed] of [
    ['status', ['pending', 'success', 'failed', 'cancelled']],
    ['kind', ['chat', 'embedding', 'connection-test', 'compression', 'memory-summary']],
  ] as const) {
    const value = query[parameter];
    if (value) {
      if (!(allowed as readonly string[]).includes(value))
        throw new AppError(400, 'VALIDATION_ERROR', '请求类型或状态无效。');
      clauses.push(`${parameter}=?`);
      values.push(value);
    }
  }
  const dates: Record<string, string> = {};
  for (const [key, comparison] of [
    ['from', '>='],
    ['to', '<='],
  ]) {
    if (!query[key]) continue;
    const time = Date.parse(query[key]!);
    if (!Number.isFinite(time)) throw new AppError(400, 'VALIDATION_ERROR', '日期筛选无效。');
    dates[key] = new Date(time).toISOString();
    clauses.push(`created_at${comparison}?`);
    values.push(dates[key]);
  }
  if (dates.from && dates.to && dates.from > dates.to)
    throw new AppError(400, 'VALIDATION_ERROR', '开始时间不能晚于结束时间。');
  if (query.search?.trim()) {
    const term = query.search.trim();
    if (term.length > 200) throw new AppError(400, 'VALIDATION_ERROR', '搜索内容过长。');
    const columns = [
      'id',
      'user_name',
      'character_name',
      'supplier_name',
      'model',
      'endpoint',
      'request_id',
      'error_code',
    ];
    clauses.push(
      `(${columns.map((column) => `COALESCE(${column},'') LIKE ? ESCAPE '\\'`).join(' OR ')})`,
    );
    values.push(...columns.map(() => `%${term.replace(/[\\%_]/g, '\\$&')}%`));
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const db = getDb();
  const total = Number(
    (db.query(`SELECT COUNT(*) AS total FROM request_audits ${where}`).get(...values) as Row).total,
  );
  const rows = db
    .query(
      `SELECT ${META_COLUMNS} FROM request_audits ${where} ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?`,
    )
    .all(...values, pageSize, (page - 1) * pageSize) as Row[];
  return { items: rows.map(entry), total, page, pageSize };
}

export function getAudit(
  auditId: string,
): AuditEntry & { requestBody: string | null; responseBody: string | null } {
  pruneAudits();
  const row = getDb().query('SELECT * FROM request_audits WHERE id=?').get(auditId) as Row | null;
  if (!row) throw new AppError(404, 'NOT_FOUND', '审查记录不存在或已超过保留期限。');
  return {
    ...entry(row),
    requestBody: nullableString(row.request_body),
    responseBody: nullableString(row.response_body),
  };
}

export function getAuditStats(period = '7d') {
  pruneAudits();
  const periods: Record<string, number | null> = {
    '24h': 86_400_000,
    '7d': 7 * 86_400_000,
    '30d': 30 * 86_400_000,
    all: null,
  };
  if (!(period in periods)) throw new AppError(400, 'VALIDATION_ERROR', '统计周期无效。');
  const duration = periods[period];
  const row = getDb()
    .query(
      `SELECT COUNT(*) AS total,SUM(status='success') AS success,SUM(status IN ('failed','cancelled')) AS failed,SUM(status='pending') AS pending,AVG(duration_ms) AS avg_duration,SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens FROM request_audits ${duration === null ? '' : 'WHERE created_at>=?'}`,
    )
    .get(...(duration === null ? [] : [new Date(Date.now() - duration).toISOString()])) as Row;
  return {
    total: Number(row.total),
    success: Number(row.success || 0),
    failed: Number(row.failed || 0),
    pending: Number(row.pending || 0),
    avgDurationMs: Math.round(Number(row.avg_duration || 0)),
    inputTokens: Number(row.input_tokens || 0),
    outputTokens: Number(row.output_tokens || 0),
  };
}
