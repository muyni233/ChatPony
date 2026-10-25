import { strict as assert } from 'node:assert';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { GET, PATCH, POST } from '../../src/app/api/[...path]/route';
import { createSession } from '../../src/lib/auth';
import { closeDb, getDb, id, now } from '../../src/lib/db';
import type { Row } from '../../src/lib/mappers';

const directory = process.env.CHATPONY_TEST_DIR;
assert.ok(directory, 'An isolated fixture directory is required');
process.env.DATABASE_PATH = join(directory, 'mail-diagnostics.db');
process.env.ENCRYPTION_KEY = 'ed'.repeat(32);
const smtpUsername = 'smtp-diagnostics-user';
const smtpPassword = 'smtp-diagnostics-private-password';
const smtpAuth = Buffer.from(`\0${smtpUsername}\0${smtpPassword}`).toString('base64');
const fromEmail = 'private-sender@example.test';
const failureMarker = 'local-fixture-rejection';
const modes = ['accept', 'sender', 'recipient', 'data', 'authentication', 'temporary'] as const;
type Mode = (typeof modes)[number];
type Delivery = {
  id: string;
  kind: 'connection-test' | 'test-email' | 'verification';
  status: 'success' | 'failed' | 'pending' | 'interrupted';
  recipient: string;
  smtpHost: string;
  smtpPort: number;
  fromEmail: string;
  stage: string;
  code: string;
  command: string;
  smtpCode: number | null;
  enhancedStatus: string | null;
  response: string;
  summary: string;
  hint: string;
  createdAt: string;
  finishedAt: string | null;
  durationMs: number | null;
};
type DeliveryPage = {
  items: Delivery[];
  total: number;
  page: number;
  pageSize: number;
  retentionDays: number;
};
type ApiResult<T> = {
  status: number;
  data?: T;
  error?: { code: string; message: string };
};
type MailRecord = { recipient: string; raw: string; accepted: boolean };
let mode: Mode = 'accept';
const messages: MailRecord[] = [];
const observedCommands: string[] = [];
const sockets = new Set<Socket>();

function otp(raw: string): string | undefined {
  const decoded = raw
    .replace(/=\r\n/g, '')
    .replace(/=([A-F\d]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  return decoded.match(/font-weight:bold">(\d{6})</)?.[1];
}

const smtp = createServer((socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => {});
  socket.setEncoding('utf8');
  socket.write('220 local.test SMTP diagnostics fixture\r\n');
  let buffer = '';
  let dataMode = false;
  let recipient = '';
  const reject = (code: number, enhanced: string, extra = '') =>
    socket.write(
      `${code} ${enhanced} ${failureMarker} sender=${fromEmail} recipient=${recipient} username=${smtpUsername} password=${smtpPassword} auth=${smtpAuth} ${extra}\r\n`,
    );
  socket.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      if (dataMode) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end < 0) return;
        const raw = buffer.slice(0, end);
        messages.push({ recipient, raw, accepted: mode !== 'data' });
        buffer = buffer.slice(end + 5);
        dataMode = false;
        if (mode === 'data') reject(554, '5.7.1', `verification-code=${otp(raw) || 'none'}`);
        else socket.write('250 2.0.0 accepted by local fixture\r\n');
        continue;
      }
      const end = buffer.indexOf('\r\n');
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      // Store command names only: no raw AUTH, addresses, or message bodies in command logs.
      observedCommands.push(line.split(' ', 1)[0].toUpperCase());
      if (/^(EHLO|HELO) /i.test(line))
        socket.write('250-local.test\r\n250-AUTH PLAIN\r\n250 SIZE 100000\r\n');
      else if (/^AUTH PLAIN /i.test(line)) {
        if (mode === 'authentication') reject(535, '5.7.8');
        else if (line.slice(11) === smtpAuth) socket.write('235 2.7.0 authenticated\r\n');
        else reject(535, '5.7.8');
      } else if (/^MAIL FROM:/i.test(line)) {
        if (mode === 'sender') reject(553, '5.7.1');
        else if (mode === 'temporary') reject(451, '4.7.1');
        else socket.write('250 2.1.0 sender accepted\r\n');
      } else if (/^RCPT TO:/i.test(line)) {
        recipient = line.match(/<([^>]+)>/)?.[1] || '';
        if (mode === 'recipient') reject(550, '5.1.1');
        else socket.write('250 2.1.5 recipient accepted\r\n');
      } else if (line.toUpperCase() === 'DATA') {
        dataMode = true;
        socket.write('354 end with dot\r\n');
      } else if (line.toUpperCase() === 'STARTTLS') {
        socket.write('454 4.7.0 local fixture does not offer TLS\r\n');
      } else if (line.toUpperCase() === 'QUIT') socket.end('221 2.0.0 bye\r\n');
      else socket.write('250 ok\r\n');
    }
  });
});
await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
const address = smtp.address();
assert.ok(address && typeof address !== 'string');

async function api<T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  input?: unknown,
  cookie = '',
): Promise<ApiResult<T>> {
  const request = new Request(`http://mail-fixture.test/api/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie.split(';')[0] } : {}),
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  const response = await { GET, POST, PATCH }[method](request, {
    params: Promise.resolve({ path: path.split('?')[0].split('/') }),
  });
  return {
    ...((await response.json()) as Omit<ApiResult<T>, 'status'>),
    status: response.status,
  };
}

let admin = '';
async function logs(query = ''): Promise<DeliveryPage> {
  const result = await api<DeliveryPage>('GET', `admin/mail/deliveries${query}`, undefined, admin);
  assert.equal(result.status, 200, 'Administrator must be able to list mail delivery diagnostics');
  assert.ok(result.data);
  return result.data;
}
async function logFor(reference: string): Promise<Delivery> {
  const result = await logs(`?search=${encodeURIComponent(reference)}`);
  assert.equal(result.total, 1, 'Public reference must identify exactly one retained diagnosis');
  assert.equal(result.items[0].id, reference);
  return result.items[0];
}
function referenceOf(result: ApiResult<unknown>): string {
  const reference = result.error?.message.match(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  )?.[0];
  assert.ok(reference, 'Failure needs a visible reference that administrators can search');
  return reference;
}
function privateValuesAbsent(value: unknown, extra: string[] = []): void {
  const serialized = JSON.stringify(value);
  for (const secret of [smtpUsername, smtpPassword, smtpAuth, fromEmail, ...extra])
    assert.ok(!serialized.includes(secret), 'Diagnostics must not contain private mail data');
}
function publicFailure(result: ApiResult<unknown>): string {
  assert.equal(result.status, 503, 'SMTP failure should be a service error');
  assert.ok(result.error?.message);
  privateValuesAbsent(result);
  assert.ok(
    !JSON.stringify(result).includes(failureMarker),
    'Anonymous API must not expose SMTP response',
  );
  assert.ok(
    !JSON.stringify(result).includes('127.0.0.1'),
    'Anonymous API must not expose SMTP host',
  );
  return referenceOf(result);
}
const countChallenges = () =>
  Number(
    (getDb().query('SELECT COUNT(*) AS count FROM registration_challenges').get() as Row).count,
  );
const clearRateLimits = () => getDb().query('DELETE FROM rate_limits').run();

try {
  const db = getDb();
  assert.equal((db.query('PRAGMA user_version').get() as Row).user_version, 14);
  const adminId = id();
  const userId = id();
  const create = db.query(
    "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,'not-used',?,?)",
  );
  create.run(adminId, 'admin@example.test', 'Mail admin', 'admin', now());
  create.run(userId, 'member@example.test', 'Member', 'user', now());
  admin = createSession(adminId);
  const user = createSession(userId);

  // Delivery details are privileged even though the user-facing reference is safe to share.
  assert.equal((await api('GET', 'admin/mail/deliveries')).status, 401);
  assert.equal((await api('GET', 'admin/mail/deliveries', undefined, user)).status, 403);
  assert.equal(
    (await api('POST', 'admin/mail/send-test', { email: 'test@example.test' })).status,
    401,
  );
  assert.equal(
    (await api('POST', 'admin/mail/send-test', { email: 'test@example.test' }, user)).status,
    403,
  );

  const unconfigured = await api(
    'POST',
    'admin/mail/send-test',
    { email: 'test@example.test' },
    admin,
  );
  assert.ok(unconfigured.status >= 400);
  const configFailure = await logFor(referenceOf(unconfigured));
  assert.equal(configFailure.stage, 'configuration');
  assert.equal(configFailure.status, 'failed');

  const saved = await api(
    'PATCH',
    'admin/mail',
    {
      host: '127.0.0.1',
      port: address.port,
      secure: false,
      requireTLS: false,
      username: smtpUsername,
      password: smtpPassword,
      fromEmail,
      fromName: 'ChatPony diagnostics fixture',
    },
    admin,
  );
  assert.equal(saved.status, 200);
  const beforeVerify = observedCommands.length;
  const verification = await api('POST', 'admin/mail/test', undefined, admin);
  assert.equal(verification.status, 200);
  assert.equal(verification.data?.ok, true);
  assert.ok(typeof verification.data?.id === 'string');
  const verifyLog = await logFor(verification.data.id);
  assert.equal(verifyLog.kind, 'connection-test');
  assert.equal(verifyLog.status, 'success');
  assert.ok(observedCommands.slice(beforeVerify).includes('AUTH'));
  assert.ok(!observedCommands.slice(beforeVerify).includes('DATA'));
  assert.ok(!observedCommands.slice(beforeVerify).includes('MAIL'));
  assert.equal(messages.length, 0, 'Connection verification must never send an email');
  assert.equal(countChallenges(), 0);

  const testEmail = 'test-recipient@example.test';
  const testSend = await api('POST', 'admin/mail/send-test', { email: testEmail }, admin);
  assert.equal(testSend.status, 200);
  assert.equal(testSend.data?.ok, true);
  assert.ok(typeof testSend.data?.id === 'string');
  const testLog = await logFor(testSend.data.id);
  assert.equal(testLog.kind, 'test-email');
  assert.equal(testLog.status, 'success');
  assert.equal(testLog.stage, 'complete');
  assert.equal(testLog.smtpHost, '127.0.0.1');
  assert.equal(testLog.smtpPort, address.port);
  assert.ok(testLog.finishedAt && Number.isFinite(testLog.durationMs));
  assert.notEqual(testLog.recipient, testEmail);
  privateValuesAbsent(testLog, [testEmail]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].accepted, true);
  assert.equal(countChallenges(), 0, 'Admin test email must not mint a registration challenge');
  assert.equal(
    otp(messages[0].raw),
    undefined,
    'Admin test email must not contain a registration OTP',
  );
  const recipientMatches = await logs(`?search=${encodeURIComponent(testLog.recipient)}`);
  assert.ok(recipientMatches.items.some((entry) => entry.id === testLog.id));
  assert.ok(recipientMatches.items.every((entry) => entry.recipient === testLog.recipient));

  await api('PATCH', 'admin/settings', { requireEmailVerification: true }, admin);
  const cases: { mode: Mode; stage: string; smtpCode: number; enhanced: string }[] = [
    { mode: 'sender', stage: 'sender', smtpCode: 553, enhanced: '5.7.1' },
    { mode: 'recipient', stage: 'recipient', smtpCode: 550, enhanced: '5.1.1' },
    { mode: 'data', stage: 'data', smtpCode: 554, enhanced: '5.7.1' },
    { mode: 'authentication', stage: 'authentication', smtpCode: 535, enhanced: '5.7.8' },
    { mode: 'temporary', stage: 'sender', smtpCode: 451, enhanced: '4.7.1' },
  ];
  const failedIds: string[] = [];
  for (const item of cases) {
    clearRateLimits();
    mode = item.mode;
    // A successful AUTH probe cannot validate MAIL FROM, recipients, or DATA acceptance.
    if (item.mode !== 'authentication') {
      const mailCount: number = messages.length;
      const probe = await api('POST', 'admin/mail/test', undefined, admin);
      assert.equal(probe.status, 200);
      assert.equal(messages.length, mailCount);
    }
    const email = `failed-${item.mode}@example.test`;
    const failed = await api('POST', 'auth/verification/send', { email });
    const reference = publicFailure(failed);
    const delivery = await logFor(reference);
    failedIds.push(reference);
    assert.equal(delivery.kind, 'verification');
    assert.equal(delivery.status, 'failed');
    assert.equal(delivery.stage, item.stage);
    assert.equal(delivery.smtpCode, item.smtpCode);
    assert.equal(delivery.enhancedStatus, item.enhanced);
    assert.ok(delivery.summary.length > 0 && delivery.hint.length > 0);
    assert.ok(
      delivery.response.includes(failureMarker),
      'Admin needs the sanitized SMTP rejection reason',
    );
    assert.ok(delivery.finishedAt && delivery.durationMs !== null && delivery.durationMs >= 0);
    const exposedCode = otp(messages.findLast((message) => message.recipient === email)?.raw || '');
    privateValuesAbsent(delivery, [email, ...(exposedCode ? [exposedCode] : [])]);
    assert.equal(db.query('SELECT * FROM registration_challenges WHERE email=?').get(email), null);
    const register = await api('POST', 'auth/register', {
      name: 'Mail failure fixture',
      email,
      password: 'isolated-fixture-password',
      verificationCode: exposedCode || '000000',
    });
    assert.equal(register.status, 400, 'A failed mail delivery must not allow registration');
    assert.equal(db.query('SELECT id FROM users WHERE email=?').get(email), null);
  }

  mode = 'accept';
  clearRateLimits();
  const successEmail = 'verified-recipient@example.test';
  const successful = await api('POST', 'auth/verification/send', { email: successEmail });
  assert.equal(successful.status, 200);
  const successfulMail = messages.findLast((message) => message.recipient === successEmail);
  assert.ok(successfulMail?.accepted);
  const successCode = otp(successfulMail.raw);
  assert.ok(successCode);
  const challenge = db
    .query('SELECT * FROM registration_challenges WHERE email=?')
    .get(successEmail) as Row;
  assert.equal(challenge.delivered, 1);
  assert.equal(String(challenge.code_hash).length, 64);
  assert.notEqual(challenge.code_hash, successCode);
  const successfulLogs = (await logs('?status=success&pageSize=50')).items;
  const deliveredLog = successfulLogs.find((entry) => entry.kind === 'verification');
  assert.ok(deliveredLog);
  privateValuesAbsent(deliveredLog, [successEmail, successCode]);
  const acceptedRegistration = await api('POST', 'auth/register', {
    name: 'Delivered fixture',
    email: successEmail,
    password: 'isolated-fixture-password',
    verificationCode: successCode,
  });
  assert.equal(acceptedRegistration.status, 201);

  // Startup/configuration failures must also be searchable; they do not reach SMTP.
  const savedConfig = String(
    (db.query("SELECT value FROM settings WHERE key='mailConfig'").get() as Row).value,
  );
  const corruptedConfig = { ...JSON.parse(savedConfig), password: 'not-an-encrypted-credential' };
  db.query("UPDATE settings SET value=? WHERE key='mailConfig'").run(
    JSON.stringify(corruptedConfig),
  );
  const commandsBeforeKeyFailure = observedCommands.length;
  clearRateLimits();
  const keyFailure = await api('POST', 'auth/verification/send', {
    email: 'broken-key@example.test',
  });
  const keyLog = await logFor(publicFailure(keyFailure));
  assert.equal(keyLog.stage, 'configuration');
  assert.equal(keyLog.status, 'failed');
  assert.equal(observedCommands.length, commandsBeforeKeyFailure);
  assert.equal(
    db.query('SELECT * FROM registration_challenges WHERE email=?').get('broken-key@example.test'),
    null,
  );
  db.query("UPDATE settings SET value=? WHERE key='mailConfig'").run(savedConfig);

  const validKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = 'invalid-master-key';
  try {
    const badSave = await api('PATCH', 'admin/mail', { password: smtpPassword }, admin);
    assert.ok(badSave.status >= 400);
    const invalidKeyOperation = await api('POST', 'admin/mail/test', undefined, admin);
    assert.equal(invalidKeyOperation.status, 503);
    const diagnostic = await logFor(referenceOf(invalidKeyOperation));
    assert.equal(diagnostic.stage, 'configuration');
    assert.equal(diagnostic.status, 'failed');
    privateValuesAbsent(diagnostic);
    assert.ok(
      (db.query("SELECT value FROM settings WHERE key='mailConfig'").get() as Row).value ===
        savedConfig,
      'A failed credential save must preserve the existing SMTP settings',
    );
  } finally {
    process.env.ENCRYPTION_KEY = validKey;
  }

  // A requested TLS upgrade is different from an authentication or sender failure.
  await api('PATCH', 'admin/mail', { requireTLS: true }, admin);
  const tlsFailure = await api('POST', 'admin/mail/test', undefined, admin);
  assert.equal(tlsFailure.status, 503);
  const tlsLog = await logFor(referenceOf(tlsFailure));
  assert.equal(tlsLog.stage, 'tls');
  await api('PATCH', 'admin/mail', { requireTLS: false }, admin);

  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => smtp.close(() => resolve()));
  const connectionFailure = await api('POST', 'admin/mail/test', undefined, admin);
  assert.equal(connectionFailure.status, 503);
  const connectionLog = await logFor(referenceOf(connectionFailure));
  assert.equal(connectionLog.stage, 'connection');
  assert.ok(connectionLog.summary.length > 0 && connectionLog.hint.length > 0);

  // No message bodies, plaintext codes, or credentials should survive in either log storage.
  const rawRows = db.query('SELECT * FROM mail_deliveries').all();
  privateValuesAbsent(rawRows, [testEmail, successEmail, successCode]);
  for (const mail of messages) {
    const code = otp(mail.raw);
    if (code) privateValuesAbsent(rawRows, [code]);
    assert.ok(!JSON.stringify(rawRows).includes(mail.raw), 'Mail body must not be recorded');
  }
  privateValuesAbsent(db.query('SELECT * FROM request_audits').all(), [successCode]);

  // Filtering, page bounds, and persistence work through the administrator API.
  const failedPage = await logs('?status=failed&pageSize=2&page=1');
  assert.equal(failedPage.items.length, 2);
  assert.ok(failedPage.items.every((entry) => entry.status === 'failed'));
  assert.ok(failedPage.total >= failedIds.length);
  const secondPage = await logs('?status=failed&pageSize=2&page=2');
  assert.equal(secondPage.items.length, 2);
  assert.ok(
    !secondPage.items.some((entry) => failedPage.items.some((other) => other.id === entry.id)),
  );
  assert.equal((await logs('?pageSize=50')).pageSize, 50);
  assert.equal(
    (await api('GET', 'admin/mail/deliveries?pageSize=500', undefined, admin)).status,
    400,
  );
  assert.equal((await logs('?search=x%25_%27%20OR%201%3D1--')).total, 0);
  assert.equal(
    (await api('GET', 'admin/mail/deliveries?status=bogus', undefined, admin)).status,
    400,
  );
  closeDb();
  const restartedLog = await logFor(failedIds[0]);
  assert.equal(restartedLog.smtpCode, 553);
  assert.equal(restartedLog.stage, 'sender');

  // Retention honors the platform setting, and abandoned operations become visibly interrupted.
  const retention = await logs();
  assert.equal(retention.retentionDays, 7);
  const insert = getDb().query(
    "INSERT INTO mail_deliveries(id,kind,status,recipient,smtp_host,smtp_port,from_email,stage,code,command,smtp_code,enhanced_status,response,summary,hint,created_at,finished_at,duration_ms) VALUES(?,'test-email',?,'t***@example.test','127.0.0.1',25,'f***@example.test','unknown','','',NULL,NULL,'','','',?,NULL,NULL)",
  );
  const pendingId = id();
  const interruptedId = id();
  const expiredId = id();
  insert.run(pendingId, 'pending', now());
  insert.run(interruptedId, 'pending', new Date(Date.now() - 4 * 60_000).toISOString());
  insert.run(
    expiredId,
    'success',
    new Date(Date.now() - (retention.retentionDays + 1) * 86400000).toISOString(),
  );
  assert.ok((await logs('?status=pending')).items.some((entry) => entry.id === pendingId));
  const interrupted = (await logs('?status=interrupted')).items.find(
    (entry) => entry.id === interruptedId,
  );
  assert.ok(interrupted);
  assert.equal(interrupted.code, 'MAIL_INTERRUPTED');
  assert.equal((await logs(`?search=${expiredId}`)).total, 0);
  const olderId = id();
  insert.run(olderId, 'success', new Date(Date.now() - 2 * 86400000).toISOString());
  await api('PATCH', 'admin/settings', { auditRetentionDays: 1 }, admin);
  assert.equal((await logs()).retentionDays, 1);
  assert.equal((await logs(`?search=${olderId}`)).total, 0);

  // Migrating an existing v11 database adds logs without changing saved SMTP credentials or users.
  const storedBeforeMigration = String(
    (getDb().query("SELECT value FROM settings WHERE key='mailConfig'").get() as Row).value,
  );
  const userCountBeforeMigration = Number(
    (getDb().query('SELECT COUNT(*) AS n FROM users').get() as Row).n,
  );
  getDb().exec('DROP TABLE mail_deliveries; PRAGMA user_version=11;');
  closeDb();
  const migrated = getDb();
  assert.equal((migrated.query('PRAGMA user_version').get() as Row).user_version, 14);
  assert.ok(
    migrated
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='mail_deliveries'")
      .get(),
  );
  assert.ok(
    String(
      (migrated.query("SELECT value FROM settings WHERE key='mailConfig'").get() as Row).value,
    ) === storedBeforeMigration,
  );
  assert.equal(
    Number((migrated.query('SELECT COUNT(*) AS n FROM users').get() as Row).n),
    userCountBeforeMigration,
  );
  console.log('Mail diagnostics check passed');
} finally {
  for (const socket of sockets) socket.destroy();
  if (smtp.listening) await new Promise<void>((resolve) => smtp.close(() => resolve()));
  closeDb();
}
