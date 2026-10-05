import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { scryptSync } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const db = new DatabaseSync(process.env.DATABASE_PATH);
const timestamp = Date.now(),
  origin = 'http://localhost:3000';
const password = 'legacy-quota-password-2026',
  salt = 'isolated-migration-salt';
db.exec(`CREATE TABLE users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user', disabled INTEGER NOT NULL DEFAULT 0,
  email_verified INTEGER NOT NULL DEFAULT 0, quota_5h INTEGER, quota_7d INTEGER, created_at TEXT NOT NULL
); CREATE TABLE quota_usage (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  request_id TEXT NOT NULL, charged_at INTEGER NOT NULL, UNIQUE(user_id,conversation_id,request_id)
); CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT NOT NULL); PRAGMA user_version=4;`);
db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?,?)').run(
  'legacy-user',
  '旧配额管理员',
  'legacy@example.com',
  `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`,
  'admin',
  0,
  1,
  7,
  17,
  new Date(timestamp).toISOString(),
);
db.prepare("INSERT INTO settings VALUES ('site',?)").run(
  JSON.stringify({ quota5h: 50, quota7d: 500, requireEmailVerification: false }),
);
for (const [id, age] of [
  ['legacy-recent', 1000],
  ['legacy-older', 6 * 3600000],
]) {
  db.prepare('INSERT INTO quota_usage VALUES (?,?,?,?,?)').run(
    id,
    'legacy-user',
    'legacy-deleted-conversation',
    id,
    timestamp - age,
  );
}
const route = await import(pathToFileURL(process.argv[2]).href);
let cookie = '',
  assertions = 0;
function check(value, message) {
  assert.ok(value, message);
  assertions++;
}
async function api(method, path, body) {
  const response = await route[method](
    new Request(`${origin}/api/${path}`, {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return { status: response.status, data: await response.json() };
}
try {
  const login = await api('POST', 'auth/login', { email: 'legacy@example.com', password });
  check(
    login.status === 200 && login.data.user.id === 'legacy-user',
    'Version-four user and credentials survive the additive quota migration',
  );
  const quota = (await api('GET', 'quota')).data;
  check(
    quota.fiveHour.enabled &&
      quota.fiveHour.limit === 7 &&
      quota.fiveHour.used === 1 &&
      quota.fiveHour.remaining === 6,
    'Existing five-hour override and recent usage remain unchanged',
  );
  check(
    quota.sevenDay.enabled &&
      quota.sevenDay.limit === 17 &&
      quota.sevenDay.used === 2 &&
      quota.sevenDay.remaining === 15,
    'Existing seven-day override and older usage remain unchanged',
  );
  check(
    !quota.oneDay.enabled &&
      quota.oneDay.limit === 100 &&
      quota.oneDay.used === 2 &&
      quota.oneDay.remaining === null,
    'The new optional one-day window can read existing successful usage',
  );
  const user = (await api('GET', 'admin/users')).data.users[0];
  check(
    user.quota5h === 7 &&
      user.quota7d === 17 &&
      user.quota1d === null &&
      ['quota5hEnabled', 'quota1dEnabled', 'quota7dEnabled'].every((field) => user[field] === null),
    'Migration preserves old overrides and inherits all new settings',
  );
  const reset = await api('POST', 'admin/quotas/reset', {
    scope: 'user',
    userId: 'legacy-user',
    window: '1d',
  });
  const afterReset = (await api('GET', 'quota')).data;
  check(
    reset.status === 200 &&
      afterReset.oneDay.used === 0 &&
      afterReset.fiveHour.used === 1 &&
      afterReset.sevenDay.used === 2,
    'Epoch reset isolates one window even for pre-migration ledger rows',
  );
  check(
    db.prepare('SELECT COUNT(*) AS n FROM quota_usage').get().n === 2,
    'Legacy ledger rows remain available after resetting the new window',
  );
  const updated = await api('PATCH', 'admin/users/legacy-user', {
    quota1d: 2,
    quota1dEnabled: true,
  });
  check(
    updated.data.user.quota5h === 7 &&
      updated.data.user.quota7d === 17 &&
      updated.data.user.quota1d === 2,
    'Editing a newly introduced override cannot overwrite existing per-user limits',
  );
  check(
    (await api('GET', 'quota')).data.oneDay.remaining === 2,
    'Enabled new window begins from its explicitly reset epoch',
  );
  console.log(
    `Backend quota migration smoke: ${assertions} assertions passed (legacy limits, history, optional window and isolated reset).`,
  );
} finally {
  db.close();
}
