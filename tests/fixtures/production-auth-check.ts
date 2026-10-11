import { strict as assert } from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, closeDb } from '../../src/lib/db';
import { GET, PATCH, POST } from '../../src/app/api/[...path]/route';
import type { Row } from '../../src/lib/mappers';

const directory = process.env.CHATPONY_TEST_DIR;
assert.ok(directory, 'An isolated fixture directory is required');
assert.equal(process.env.NODE_ENV, 'production');
const statePath = join(directory, 'auth-state.json');
type Transport = {
  name: string;
  scheme: 'http' | 'https';
  trusted: boolean;
  forwarded?: string;
  secure: boolean;
};
type AuthState = {
  transport: Transport;
  userId: string;
  email: string;
  password: string;
  activeCookie: string;
  revokedCookie: string;
};
const transports: Transport[] = [
  { name: 'plain-http', scheme: 'http', trusted: false, secure: false },
  { name: 'direct-https', scheme: 'https', trusted: false, secure: true },
  {
    name: 'untrusted-forwarded-https',
    scheme: 'http',
    trusted: false,
    forwarded: 'https',
    secure: false,
  },
  {
    name: 'trusted-forwarded-https',
    scheme: 'http',
    trusted: true,
    forwarded: 'https',
    secure: true,
  },
  {
    name: 'trusted-first-https',
    scheme: 'http',
    trusted: true,
    forwarded: ' HTTPS , http',
    secure: true,
  },
  {
    name: 'trusted-first-http',
    scheme: 'http',
    trusted: true,
    forwarded: 'http, https',
    secure: false,
  },
  {
    name: 'trusted-invalid-proto',
    scheme: 'http',
    trusted: true,
    forwarded: 'nothttps',
    secure: false,
  },
  {
    name: 'direct-https-untrusted-http',
    scheme: 'https',
    trusted: false,
    forwarded: 'http',
    secure: true,
  },
];

async function call(
  transport: Transport,
  method: 'GET' | 'PATCH' | 'POST',
  path: string,
  input?: unknown,
  cookie = '',
) {
  process.env.TRUST_PROXY = String(transport.trusted);
  const request = new Request(`${transport.scheme}://auth-fixture.test/api/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(transport.forwarded ? { 'X-Forwarded-Proto': transport.forwarded } : {}),
      ...(cookie ? { Cookie: cookie.split(';')[0] } : {}),
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  const response = await { GET, PATCH, POST }[method](request, {
    params: Promise.resolve({ path: path.split('/') }),
  });
  const data = (await response.json()) as {
    data: Record<string, unknown>;
    error?: { code: string };
  };
  return { ...data, status: response.status, cookie: response.headers.get('set-cookie') || '' };
}

function checkCookie(cookie: string, transport: Transport, expired = false): void {
  assert.ok(cookie.startsWith('chatpony_session='), `${transport.name}: missing session cookie`);
  assert.ok(
    cookie.includes('Path=/') && cookie.includes('HttpOnly') && cookie.includes('SameSite=Lax'),
    `${transport.name}: session cookie attributes missing`,
  );
  assert.equal(
    /(?:^|;)\s*Secure(?:;|$)/.test(cookie),
    transport.secure,
    `${transport.name}: Secure did not follow actual transport`,
  );
  assert.ok(
    cookie.includes(expired ? 'Max-Age=0' : 'Max-Age=2592000'),
    `${transport.name}: incorrect session lifetime`,
  );
}

try {
  if (process.argv[2] === 'create') {
    const saved: AuthState[] = [];
    for (const [index, transport] of transports.entries()) {
      const email = `user-${index}@fixture.test`;
      const originalPassword = randomBytes(20).toString('base64url');
      const password = randomBytes(20).toString('base64url');
      const register = await call(transport, 'POST', 'auth/register', {
        email,
        name: `Fixture ${index}`,
        password: originalPassword,
      });
      assert.equal(register.status, 201, `${transport.name}: registration failed`);
      checkCookie(register.cookie, transport);
      const userId = String(register.data.id);
      const registerToken = register.cookie.split(';')[0].slice('chatpony_session='.length);
      const tokenHash = createHash('sha256').update(registerToken).digest('hex');
      assert.equal(
        (getDb().query('SELECT user_id FROM sessions WHERE token_hash=?').get(tokenHash) as Row)
          .user_id,
        userId,
      );
      assert.equal(
        getDb().query('SELECT user_id FROM sessions WHERE token_hash=?').get(registerToken),
        null,
      );
      assert.equal((await call(transport, 'GET', 'quota', undefined, register.cookie)).status, 200);
      const login = await call(transport, 'POST', 'auth/login', {
        email,
        password: originalPassword,
      });
      assert.equal(login.status, 200, `${transport.name}: login failed`);
      checkCookie(login.cookie, transport);
      const changed = await call(
        transport,
        'PATCH',
        'account',
        { currentPassword: originalPassword, password },
        login.cookie,
      );
      assert.equal(changed.status, 200, `${transport.name}: password change failed`);
      checkCookie(changed.cookie, transport);
      assert.equal((await call(transport, 'GET', 'quota', undefined, register.cookie)).status, 401);
      assert.equal((await call(transport, 'GET', 'quota', undefined, login.cookie)).status, 401);
      assert.equal((await call(transport, 'GET', 'quota', undefined, changed.cookie)).status, 200);
      assert.equal(
        (await call(transport, 'POST', 'auth/login', { email, password: originalPassword })).status,
        401,
      );
      const disposable = await call(transport, 'POST', 'auth/login', { email, password });
      assert.equal(disposable.status, 200);
      checkCookie(disposable.cookie, transport);
      const logout = await call(transport, 'POST', 'auth/logout', undefined, disposable.cookie);
      assert.equal(logout.status, 200);
      checkCookie(logout.cookie, transport, true);
      assert.equal(
        (await call(transport, 'GET', 'quota', undefined, disposable.cookie)).status,
        401,
      );
      assert.equal((await call(transport, 'GET', 'quota', undefined, changed.cookie)).status, 200);
      saved.push({
        transport,
        userId,
        email,
        password,
        activeCookie: changed.cookie,
        revokedCookie: login.cookie,
      });
    }
    writeFileSync(statePath, JSON.stringify(saved), { mode: 0o600 });
    console.log('Production auth create passed');
  } else if (process.argv[2] === 'restart') {
    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as AuthState[];
    assert.equal(saved.length, transports.length);
    for (const state of saved) {
      const quota = await call(state.transport, 'GET', 'quota', undefined, state.activeCookie);
      assert.equal(
        quota.status,
        200,
        `${state.transport.name}: persisted session was lost on restart`,
      );
      const bootstrap = await call(
        state.transport,
        'GET',
        'bootstrap',
        undefined,
        state.activeCookie,
      );
      assert.equal((bootstrap.data.user as { id: string }).id, state.userId);
      assert.equal(
        (await call(state.transport, 'GET', 'quota', undefined, state.revokedCookie)).status,
        401,
      );
      const logout = await call(
        state.transport,
        'POST',
        'auth/logout',
        undefined,
        state.activeCookie,
      );
      assert.equal(logout.status, 200);
      checkCookie(logout.cookie, state.transport, true);
      assert.equal(
        (await call(state.transport, 'GET', 'quota', undefined, state.activeCookie)).status,
        401,
      );
      const relogin = await call(state.transport, 'POST', 'auth/login', {
        email: state.email,
        password: state.password,
      });
      assert.equal(relogin.status, 200);
      checkCookie(relogin.cookie, state.transport);
      const token = relogin.cookie.split(';')[0].slice('chatpony_session='.length);
      getDb()
        .query('UPDATE sessions SET expires_at=? WHERE token_hash=?')
        .run(
          new Date(Date.now() - 1000).toISOString(),
          createHash('sha256').update(token).digest('hex'),
        );
      assert.equal(
        (await call(state.transport, 'GET', 'quota', undefined, relogin.cookie)).status,
        401,
      );
    }
    console.log('Production auth restart passed');
  } else throw new Error('Unknown auth fixture mode');
} finally {
  closeDb();
}
