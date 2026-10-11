import { strict as assert } from 'node:assert';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { getDb, closeDb, id, now } from '../../src/lib/db';
import { createSession } from '../../src/lib/auth';
import {
  normalizeEmail,
  normalizeEmailDomains,
  emailDomainAllowed,
} from '../../src/lib/email-policy';
import { GET, POST, PATCH } from '../../src/app/api/[...path]/route';
import type { Row } from '../../src/lib/mappers';

const temp = process.env.CHATPONY_TEST_DIR;
assert.ok(temp);
process.env.DATABASE_PATH = join(temp, 'mail.db');
process.env.ENCRYPTION_KEY = 'ef'.repeat(32);
const password = 'registration-test-password';
const delivered: { recipient: string; raw: string }[] = [];
const sockets = new Set<Socket>();
let authentications = 0;
const smtp = createServer((socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.setEncoding('utf8');
  socket.write('220 local.test SMTP fixture\r\n');
  let buffer = '';
  let dataMode = false;
  let recipient = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      if (dataMode) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end < 0) return;
        delivered.push({ recipient, raw: buffer.slice(0, end) });
        buffer = buffer.slice(end + 5);
        dataMode = false;
        socket.write('250 message accepted\r\n');
        continue;
      }
      const end = buffer.indexOf('\r\n');
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (/^(EHLO|HELO) /i.test(line))
        socket.write('250-local.test\r\n250-AUTH PLAIN\r\n250 SIZE 100000\r\n');
      else if (/^AUTH PLAIN /i.test(line)) {
        authentications++;
        socket.write(
          Buffer.from(line.slice(11), 'base64').toString() === '\0smtp-user\0smtp-fixture-password'
            ? '235 authenticated\r\n'
            : '535 private-upstream-auth-detail\r\n',
        );
      } else if (/^MAIL FROM:/i.test(line)) socket.write('250 sender accepted\r\n');
      else if (/^RCPT TO:/i.test(line)) {
        recipient = line.match(/<([^>]+)>/)?.[1] || '';
        socket.write('250 recipient accepted\r\n');
      } else if (line.toUpperCase() === 'DATA') {
        dataMode = true;
        socket.write('354 end with dot\r\n');
      } else if (line.toUpperCase() === 'QUIT') socket.end('221 bye\r\n');
      else socket.write('250 ok\r\n');
    }
  });
});
await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
const address = smtp.address();
assert.ok(address && typeof address !== 'string');

async function call(method: 'GET' | 'POST' | 'PATCH', path: string, input?: unknown, cookie = '') {
  const request = new Request(`http://local.test/api/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie.split(';')[0] } : {}),
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  const response = await { GET, POST, PATCH }[method](request, {
    params: Promise.resolve({ path: path.split('/') }),
  });
  const result = (await response.json()) as {
    data: Record<string, unknown>;
    error?: { code: string; message: string };
  };
  return { ...result, status: response.status };
}
const codeFor = (email: string) => {
  const mail = delivered.findLast((message) => message.recipient === email);
  assert.ok(mail);
  const decoded = mail.raw
    .replace(/=\r\n/g, '')
    .replace(/=([A-F\d]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  const code = decoded.match(/font-weight:bold">(\d{6})</)?.[1];
  assert.ok(code);
  return code;
};
const signup = (email: string, verificationCode?: string) =>
  call('POST', 'auth/register', { name: 'Verified user', email, password, verificationCode });

try {
  assert.equal(normalizeEmail('USER@例子.测试'), 'user@xn--fsqu00a.xn--0zwm56d');
  assert.deepEqual(normalizeEmailDomains(['EXAMPLE.COM', '*.例子.测试', 'example.com']), [
    'example.com',
    '*.xn--fsqu00a.xn--0zwm56d',
  ]);
  assert.equal(emailDomainAllowed('u@sub.example.com', 'allowlist', ['example.com']), false);
  assert.equal(emailDomainAllowed('u@example.com', 'allowlist', ['*.example.com']), false);
  assert.equal(emailDomainAllowed('u@deep.sub.example.com', 'allowlist', ['*.example.com']), true);
  assert.equal(emailDomainAllowed('u@notexample.com', 'blocklist', ['*.example.com']), true);
  assert.throws(() => normalizeEmailDomains(['http://example.com']));
  assert.throws(() => normalizeEmailDomains(['example.com/path']));
  assert.throws(() => normalizeEmailDomains(['*example.com']));
  assert.throws(() => normalizeEmail('u\r\nBcc:other@example.com'));
  const db = getDb();
  const adminId = id();
  db.query(
    "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,'admin@example.test','Admin','not-used','admin',?)",
  ).run(adminId, now());
  const session = createSession(adminId);
  const unverified = await signup('existing@blocked.test');
  assert.equal(unverified.status, 201);
  assert.equal(unverified.data.emailVerifiedAt, null);
  assert.equal((await call('GET', 'admin/mail')).status, 401);
  assert.equal((await call('GET', 'admin/mail', undefined, session)).data.hasPassword, false);
  assert.equal(
    (await call('PATCH', 'admin/settings', { requireEmailVerification: true }, session)).error
      ?.code,
    'MAIL_NOT_CONFIGURED',
  );
  const config = await call(
    'PATCH',
    'admin/mail',
    {
      host: '127.0.0.1',
      port: address.port,
      secure: false,
      requireTLS: false,
      username: 'smtp-user',
      password: 'smtp-fixture-password',
      fromEmail: 'no-reply@example.test',
      fromName: 'ChatPony',
    },
    session,
  );
  assert.equal(config.status, 200);
  assert.equal(config.data.hasPassword, true);
  assert.ok(!JSON.stringify(config.data).includes('smtp-fixture-password'));
  assert.ok(
    !String(
      (db.query("SELECT value FROM settings WHERE key='mailConfig'").get() as Row).value,
    ).includes('smtp-fixture-password'),
  );
  assert.equal(
    (await call('PATCH', 'admin/mail', { fromName: 'Updated' }, session)).data.hasPassword,
    true,
  );
  assert.equal(
    (await call('PATCH', 'admin/mail', { password: '密'.repeat(8192) }, session)).status,
    200,
  );
  assert.equal((await call('GET', 'admin/mail', undefined, session)).data.hasPassword, true);
  assert.equal(
    (await call('PATCH', 'admin/mail', { password: 'x'.repeat(8193) }, session)).status,
    400,
  );
  const storedLongPassword = JSON.parse(
    String((db.query("SELECT value FROM settings WHERE key='mailConfig'").get() as Row).value),
  ) as { password: string };
  assert.ok(storedLongPassword.password.length > 16384);
  await call('PATCH', 'admin/mail', { username: '', password: '' }, session);
  const authBeforeRelayCheck = authentications;
  assert.equal((await call('POST', 'admin/mail/test', undefined, session)).status, 200);
  assert.equal(authentications, authBeforeRelayCheck);
  assert.equal((await call('GET', 'admin/mail', undefined, session)).data.hasPassword, false);
  await call(
    'PATCH',
    'admin/mail',
    { username: 'smtp-user', password: 'smtp-fixture-password' },
    session,
  );
  assert.equal((await call('POST', 'admin/mail/test', undefined, session)).status, 200);
  assert.ok(authentications > 0);
  assert.equal(delivered.length, 0);
  await call('PATCH', 'admin/mail', { password: 'wrong-password' }, session);
  const failedTest = await call('POST', 'admin/mail/test', undefined, session);
  assert.equal(failedTest.status, 503);
  assert.ok(!JSON.stringify(failedTest).includes('private-upstream-auth-detail'));
  await call('PATCH', 'admin/mail', { password: 'smtp-fixture-password' }, session);
  assert.equal(
    (
      await call(
        'PATCH',
        'admin/settings',
        {
          requireEmailVerification: true,
          emailDomainMode: 'allowlist',
          emailDomains: ['EXAMPLE.TEST', '*.trusted.test', '例子.测试'],
        },
        session,
      )
    ).status,
    200,
  );
  assert.equal(
    (await call('PATCH', 'admin/mail', { host: '' }, session)).error?.code,
    'MAIL_IN_USE',
  );
  assert.equal(
    (await call('PATCH', 'admin/mail', { fromEmail: '' }, session)).error?.code,
    'MAIL_IN_USE',
  );
  assert.equal((await call('GET', 'admin/mail', undefined, session)).data.host, '127.0.0.1');
  assert.equal(
    (await call('GET', 'admin/mail', undefined, session)).data.fromEmail,
    'no-reply@example.test',
  );
  assert.equal((await signup('denied@blocked.test', '123456')).status, 403);
  assert.equal(
    (await call('POST', 'auth/verification/send', { email: 'denied@blocked.test' })).status,
    403,
  );
  assert.equal(
    (await call('POST', 'auth/login', { email: 'existing@blocked.test', password })).status,
    200,
  );
  assert.equal((await signup('valid@example.test')).error?.code, 'VERIFICATION_REQUIRED');
  const sent = await call('POST', 'auth/verification/send', { email: 'VALID@example.test' });
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.data, { ok: true, retryAfter: 60, expiresIn: 600 });
  const code = codeFor('valid@example.test');
  const challenge = db
    .query('SELECT * FROM registration_challenges WHERE email=?')
    .get('valid@example.test') as Row;
  assert.equal(String(challenge.code_hash).length, 64);
  assert.notEqual(challenge.code_hash, code);
  assert.equal(challenge.delivered, 1);
  assert.equal(
    (await call('POST', 'auth/verification/send', { email: 'valid@example.test' })).status,
    429,
  );
  const verified = await signup('valid@example.test', code);
  assert.equal(verified.status, 201);
  assert.equal(typeof verified.data.emailVerifiedAt, 'string');
  assert.equal(
    (db.query('SELECT email_verified_at FROM users WHERE email=?').get('valid@example.test') as Row)
      .email_verified_at,
    verified.data.emailVerifiedAt,
  );
  assert.equal(
    db.query('SELECT email FROM registration_challenges WHERE email=?').get('valid@example.test'),
    null,
  );
  assert.equal((await signup('valid@example.test', code)).status, 409);

  await call('POST', 'auth/verification/send', { email: 'guesses@example.test' });
  const correct = codeFor('guesses@example.test');
  const wrong = correct === '000000' ? '000001' : '000000';
  for (let attempt = 0; attempt < 5; attempt++)
    assert.equal((await signup('guesses@example.test', wrong)).error?.code, 'VERIFICATION_INVALID');
  assert.equal(
    (
      db
        .query('SELECT attempts FROM registration_challenges WHERE email=?')
        .get('guesses@example.test') as Row
    ).attempts,
    5,
  );
  assert.equal(
    (await signup('guesses@example.test', correct)).error?.code,
    'VERIFICATION_ATTEMPTS',
  );
  db.query('DELETE FROM rate_limits').run();
  db.query('UPDATE registration_challenges SET sent_at=? WHERE email=?').run(
    new Date(Date.now() - 61000).toISOString(),
    'guesses@example.test',
  );
  assert.equal(
    (await call('POST', 'auth/verification/send', { email: 'guesses@example.test' })).status,
    200,
  );
  assert.equal((await signup('guesses@example.test', codeFor('guesses@example.test'))).status, 201);

  await call('POST', 'auth/verification/send', { email: 'expired@example.test' });
  const expiredCode = codeFor('expired@example.test');
  db.query('UPDATE registration_challenges SET expires_at=? WHERE email=?').run(
    new Date(Date.now() - 1).toISOString(),
    'expired@example.test',
  );
  assert.equal(
    (await signup('expired@example.test', expiredCode)).error?.code,
    'VERIFICATION_EXPIRED',
  );

  await call('POST', 'auth/verification/send', { email: 'race@example.test' });
  const raceCode = codeFor('race@example.test');
  const raced = await Promise.all([
    signup('race@example.test', raceCode),
    signup('race@example.test', raceCode),
  ]);
  assert.deepEqual(raced.map((item) => item.status).sort(), [201, 409]);
  assert.equal(
    (db.query("SELECT COUNT(*) AS count FROM users WHERE email='race@example.test'").get() as Row)
      .count,
    1,
  );

  await call('POST', 'auth/verification/send', { email: 'policy@example.test' });
  const policyCode = codeFor('policy@example.test');
  const originalHash = Bun.password.hash;
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  Bun.password.hash = async (...args) => {
    const hash = await originalHash(...args);
    started.resolve();
    await resume.promise;
    return hash;
  };
  try {
    const pending = signup('policy@example.test', policyCode);
    await started.promise;
    await call(
      'PATCH',
      'admin/settings',
      { emailDomainMode: 'blocklist', emailDomains: ['example.test'] },
      session,
    );
    resume.resolve();
    assert.equal((await pending).status, 403);
    assert.ok(
      db
        .query('SELECT email FROM registration_challenges WHERE email=?')
        .get('policy@example.test'),
    );
  } finally {
    resume.resolve();
    Bun.password.hash = originalHash;
  }
  await call('PATCH', 'admin/settings', { emailDomainMode: 'any', emailDomains: [] }, session);
  assert.equal((await signup('policy@example.test', policyCode)).status, 201);
  const before = delivered.length;
  assert.equal(
    (await call('POST', 'auth/verification/send', { email: 'existing@blocked.test' })).status,
    200,
  );
  assert.equal(delivered.length, before);
  await call('PATCH', 'admin/settings', { requireEmailVerification: false }, session);
  assert.equal(
    (await call('PATCH', 'admin/mail', { host: '', fromEmail: '' }, session)).status,
    200,
  );
  assert.equal((await signup('without-code@example.test')).status, 201);
  assert.equal(
    (await call('POST', 'auth/verification/send', { email: 'unused@example.test' })).error?.code,
    'VERIFICATION_DISABLED',
  );
  console.log('Mail check passed');
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => smtp.close(() => resolve()));
  closeDb();
}
