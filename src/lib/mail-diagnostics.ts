import { getDb, id, now } from './db';
import { AppError } from './errors';
import type { Row } from './mappers';
import type { MailDelivery, MailDeliveryList } from './types';

type Diagnosis = Pick<
  MailDelivery,
  'stage' | 'code' | 'command' | 'smtpCode' | 'enhancedStatus' | 'response' | 'summary' | 'hint'
>;
export interface MailAttempt {
  id: string;
  started: number;
  kind: MailDelivery['kind'];
  secrets: string[];
}

function maskedEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/** Never store message content, credentials, authentication payloads or raw recipient addresses. */
function redact(value: string, secrets: string[]): string {
  let text = value;
  const variants = new Set<string>();
  for (const secret of secrets.filter(Boolean)) {
    variants.add(secret);
    variants.add(Buffer.from(secret).toString('base64'));
    try {
      variants.add(encodeURIComponent(secret));
    } catch {
      /* The literal and base64 variants still cover malformed Unicode. */
    }
  }
  for (const secret of [...variants].sort((a, b) => b.length - a.length))
    text = text.split(secret).join('[REDACTED]');
  return text
    .replace(/\bAUTH\s+(?:PLAIN|LOGIN|XOAUTH2|OAUTHBEARER)\s+\S+/gi, 'AUTH [REDACTED]')
    .replace(/((?:password|passwd|secret|token|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:smtp|smtps):\/\/[^\s@]+@/gi, 'smtp://[REDACTED]@')
    .replace(/[A-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Z0-9.-]+/gi, (email) => maskedEmail(email))
    .replace(/\b\d{6}\b/g, '[REDACTED]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 1600);
}

function retentionDays(): number {
  const row = getDb()
    .query("SELECT value FROM settings WHERE key='auditRetentionDays'")
    .get() as Row | null;
  return Math.max(1, Math.min(90, Number(row?.value) || 7));
}

function prune(): void {
  const db = getDb();
  db.transaction(() => {
    db.query(
      'DELETE FROM mail_deliveries WHERE id IN (SELECT id FROM mail_deliveries WHERE created_at<? ORDER BY created_at ASC LIMIT 1000)',
    ).run(new Date(Date.now() - retentionDays() * 86_400_000).toISOString());
    db.query(
      "UPDATE mail_deliveries SET status='interrupted',stage='unknown',code='MAIL_INTERRUPTED',summary='邮件操作未留下完成记录',hint='进程可能中断，是否已被 SMTP 接受未知；先检查收件箱，再决定是否重试。',finished_at=? WHERE status='pending' AND created_at<?",
    ).run(now(), new Date(Date.now() - 180_000).toISOString());
  }).immediate();
}

export function beginMailAttempt(kind: MailDelivery['kind'], recipient = ''): MailAttempt {
  const attempt: MailAttempt = { id: id(), started: Date.now(), kind, secrets: [] };
  try {
    prune();
    getDb()
      .query(
        "INSERT INTO mail_deliveries(id,kind,status,recipient,stage,summary,created_at) VALUES(?,?,'pending',?,'configuration','正在准备邮件操作',?)",
      )
      .run(attempt.id, kind, maskedEmail(recipient), now());
  } catch {
    console.error('[ChatPony mail] Diagnostic storage unavailable', attempt.id);
  }
  return attempt;
}

export function configureMailAttempt(
  attempt: MailAttempt,
  config: { host: string; port: number; fromEmail: string; username: string },
  password: string,
  extraSecrets: string[] = [],
): void {
  attempt.secrets = [
    password,
    config.username,
    ...extraSecrets,
    ...(config.username && password ? [`\0${config.username}\0${password}`] : []),
  ];
  try {
    getDb()
      .query(
        "UPDATE mail_deliveries SET smtp_host=?,smtp_port=?,from_email=?,stage='connection',summary='正在连接邮件服务器' WHERE id=?",
      )
      .run(config.host, config.port, maskedEmail(config.fromEmail), attempt.id);
  } catch {
    console.error('[ChatPony mail] Diagnostic update unavailable', attempt.id);
  }
}

export function diagnoseMailError(error: unknown, attempt: MailAttempt): Diagnosis {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const rawCode = String(record.code || 'MAIL_ERROR');
  const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(rawCode) ? rawCode : 'MAIL_ERROR';
  const rawCommand = String(record.command || '').toUpperCase();
  const command =
    ['MAIL FROM', 'RCPT TO', 'STARTTLS', 'AUTH', 'DATA', 'CONN', 'EHLO', 'HELO'].find(
      (name) => rawCommand === name || rawCommand.startsWith(name + ' '),
    ) || null;
  const smtpCode =
    typeof record.responseCode === 'number' &&
    record.responseCode >= 200 &&
    record.responseCode <= 599
      ? Math.trunc(record.responseCode)
      : null;
  const rawResponse =
    typeof record.response === 'string'
      ? record.response
      : typeof record.message === 'string'
        ? record.message
        : '';
  const enhancedStatus = rawResponse.match(/\b[245]\.\d{1,3}\.\d{1,3}\b/)?.[0] || null;
  const response = redact(rawResponse, attempt.secrets) || null;
  let stage: MailDelivery['stage'] = 'unknown';
  let summary = '邮件操作失败';
  let hint = '查看 SMTP 返回信息及服务商发送日志，按参考编号定位本次请求。';
  if (/^(MAIL_(?:CONFIG|KEY|NOT_CONFIGURED)|ENCRYPTION_)/.test(code)) {
    stage = 'configuration';
    summary = '邮件配置或加密凭据无法读取';
    hint = '检查已保存的 SMTP 配置及原加密密钥；不要直接更换加密密钥。';
  } else if (command === 'AUTH' || code === 'EAUTH') {
    stage = 'authentication';
    summary = 'SMTP 身份验证失败';
    hint = '核对用户名和 SMTP 授权码，确认账号允许 SMTP 登录及当前认证方式。';
  } else if (command === 'STARTTLS' || /TLS|SSL|CERT|SELF_SIGNED/.test(code)) {
    stage = 'tls';
    summary = 'SMTP 加密连接失败';
    hint = '核对端口与 TLS 方式、主机名和证书；465 通常使用直接 TLS，587 通常使用 STARTTLS。';
  } else if (command === 'MAIL FROM') {
    stage = 'sender';
    summary = 'SMTP 服务器拒绝发件地址';
    hint = '核对发件邮箱是否已通过服务商验证，且当前 SMTP 账号有权使用该地址或域名。';
  } else if (command === 'RCPT TO' || code === 'EENVELOPE' || code === 'MAIL_NO_RECIPIENT') {
    stage = 'recipient';
    summary = 'SMTP 服务器拒绝收件地址';
    hint = '检查收件地址、服务商沙盒/收件白名单和转发权限；具体原因以服务器响应为准。';
  } else if (command === 'DATA' || code === 'EMESSAGE') {
    stage = 'data';
    summary = 'SMTP 服务器拒绝邮件内容';
    hint = '检查服务器响应、发信额度与邮件策略，以及发件域名的 SPF/DKIM 配置。';
  } else if (code === 'EDNS' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    stage = 'connection';
    summary = 'SMTP 主机解析失败';
    hint = '检查 SMTP 主机名及服务器 DNS。';
  } else if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNECTION' ||
    command === 'CONN' ||
    code === 'ESOCKET'
  ) {
    stage = 'connection';
    summary = '无法建立 SMTP 连接';
    hint = '检查主机、端口和服务器到 SMTP 服务的网络连通性。';
  }
  if (code === 'ETIMEDOUT') {
    stage = stage === 'unknown' ? 'connection' : stage;
    summary = 'SMTP 操作超时';
    hint = '检查 SMTP 服务及网络；若发送阶段超时，邮件是否被接受可能未知，先检查收件箱再重试。';
  }
  if (smtpCode && smtpCode >= 400 && smtpCode < 500)
    hint += ' 服务器返回临时错误，请按服务商频率/配额限制稍后重试。';
  return { stage, code, command, smtpCode, enhancedStatus, response, summary, hint };
}

export function finishMailAttempt(
  attempt: MailAttempt,
  diagnosis?: Diagnosis,
  smtpResponse?: string,
): void {
  const success = !diagnosis;
  const details: Diagnosis = diagnosis || {
    stage: 'complete',
    code: null,
    command: null,
    smtpCode: null,
    enhancedStatus: null,
    response: smtpResponse ? redact(smtpResponse, attempt.secrets) : null,
    summary:
      attempt.kind === 'connection-test' ? 'SMTP 连接与鉴权检查通过' : 'SMTP 服务器已接受邮件',
    hint:
      attempt.kind === 'connection-test'
        ? '此检查不会发信，不能确认服务器允许发件地址或接受邮件内容。'
        : '服务器接受不代表已送达收件箱；请检查收件箱、垃圾邮件及服务商投递记录。',
  };
  try {
    getDb()
      .query(
        'UPDATE mail_deliveries SET status=?,stage=?,code=?,command=?,smtp_code=?,enhanced_status=?,response=?,summary=?,hint=?,finished_at=?,duration_ms=? WHERE id=?',
      )
      .run(
        success ? 'success' : 'failed',
        details.stage,
        details.code,
        details.command,
        details.smtpCode,
        details.enhancedStatus,
        details.response,
        details.summary,
        details.hint,
        now(),
        Math.max(0, Date.now() - attempt.started),
        attempt.id,
      );
  } catch {
    // A safe fallback remains available when the database itself is unavailable.
    console.error('[ChatPony mail]', JSON.stringify({ id: attempt.id, ...details }));
  }
}

function toDelivery(row: Row): MailDelivery {
  return {
    id: String(row.id),
    kind: row.kind as MailDelivery['kind'],
    status: row.status as MailDelivery['status'],
    recipient: String(row.recipient),
    smtpHost: String(row.smtp_host),
    smtpPort: Number(row.smtp_port),
    fromEmail: String(row.from_email),
    stage: row.stage as MailDelivery['stage'],
    code: row.code ? String(row.code) : null,
    command: row.command ? String(row.command) : null,
    smtpCode: row.smtp_code === null ? null : Number(row.smtp_code),
    enhancedStatus: row.enhanced_status ? String(row.enhanced_status) : null,
    response: row.response ? String(row.response) : null,
    summary: String(row.summary),
    hint: String(row.hint),
    createdAt: String(row.created_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
  };
}

export function listMailDeliveries(params: Record<string, string>): MailDeliveryList {
  const page = Number(params.page || 1),
    pageSize = Number(params.pageSize || 20);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 100000 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 50
  )
    throw new AppError(400, 'VALIDATION_ERROR', '邮件记录页码或每页数量无效。');
  const where: string[] = [],
    values: string[] = [];
  if (params.status) {
    if (!['pending', 'success', 'failed', 'interrupted'].includes(params.status))
      throw new AppError(400, 'VALIDATION_ERROR', '邮件记录状态无效。');
    where.push('status=?');
    values.push(params.status);
  }
  if (params.search?.trim()) {
    if (params.search.length > 200)
      throw new AppError(400, 'VALIDATION_ERROR', '搜索内容不能超过 200 字符。');
    where.push('(instr(id,?)>0 OR instr(recipient,?)>0)');
    values.push(params.search.trim(), params.search.trim());
  }
  prune();
  const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const db = getDb();
  const total = Number(
    (db.query('SELECT COUNT(*) AS n FROM mail_deliveries' + clause).get(...values) as Row).n,
  );
  const items = (
    db
      .query(
        'SELECT * FROM mail_deliveries' +
          clause +
          ' ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?',
      )
      .all(...values, pageSize, (page - 1) * pageSize) as Row[]
  ).map(toDelivery);
  return { items, total, page, pageSize, retentionDays: retentionDays() };
}
