import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { getDb, closeDb, id, now } from '../../src/lib/db';
import { createSession } from '../../src/lib/auth';
import { getSettings, updateUser } from '../../src/lib/repository';
import { finishCall, getQuota, reserveCall } from '../../src/lib/quota';
import { AppError } from '../../src/lib/errors';
import { GET, PATCH, POST } from '../../src/app/api/[...path]/route';
import type { Row } from '../../src/lib/mappers';

const directory = process.env.CHATPONY_TEST_DIR;
assert.ok(directory);
process.env.DATABASE_PATH = join(directory, 'global-quota.db');
process.env.ENCRYPTION_KEY = 'e2'.repeat(32);
let adminSession = '';

async function call(method: 'GET' | 'PATCH' | 'POST', path: string, input?: unknown) {
  const response = await { GET, PATCH, POST }[method](
    new Request(`http://quota.local/api/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: adminSession.split(';')[0] },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    }),
    { params: Promise.resolve({ path: path.split('/') }) },
  );
  const result = (await response.json()) as {
    data: Record<string, unknown>;
    error?: { code: string; message: string };
  };
  return { ...result, status: response.status };
}

try {
  const db = getDb();
  const adminId = id();
  const userId = id();
  const disabledId = id();
  const timestamp = now();
  const insert = db.query(
    'INSERT INTO users(id,email,name,password_hash,role,disabled,limit_5h,limit_7d,quota_reset_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
  );
  insert.run(
    adminId,
    'admin@example.test',
    'Admin',
    'unused',
    'admin',
    0,
    50,
    500,
    '2026-01-01T00:00:00.000Z',
    timestamp,
  );
  insert.run(
    userId,
    'user@example.test',
    'User',
    'unused',
    'user',
    0,
    9,
    90,
    '2026-01-02T00:00:00.000Z',
    timestamp,
  );
  insert.run(
    disabledId,
    'disabled@example.test',
    'Disabled',
    'unused',
    'user',
    1,
    11,
    110,
    '2026-01-03T00:00:00.000Z',
    timestamp,
  );
  adminSession = createSession(adminId);
  db.query(
    "INSERT INTO characters(id,name,slug,personality,created_at) VALUES('character','Character','character','Persona',?)",
  ).run(timestamp);
  db.query(
    "INSERT INTO conversations(id,user_id,title,kind,character_ids,created_at,updated_at) VALUES('conversation',?,'Quota','private','[\"character\"]',?,?)",
  ).run(userId, timestamp, timestamp);
  const pending = reserveCall(userId, 'conversation', 'character');
  const completed = reserveCall(userId, 'conversation', 'character');
  finishCall(completed, true);
  const usageBefore = db.query('SELECT * FROM api_calls ORDER BY id').all();
  const resetsBefore = db.query('SELECT id,quota_reset_at FROM users ORDER BY id').all();
  const limits = () =>
    db.query('SELECT id,limit_5h,limit_7d FROM users ORDER BY id').all() as Row[];
  const byId = (value: string) => limits().find((row) => row.id === value)!;

  assert.equal((await call('PATCH', 'admin/settings', { defaultLimit5h: 2 })).status, 200);
  assert.ok(limits().every((row) => row.limit_5h === 2));
  assert.equal(byId(adminId).limit_7d, 500);
  assert.equal(byId(userId).limit_7d, 90);
  assert.equal(byId(disabledId).limit_7d, 110);
  assert.equal(getSettings().defaultLimit5h, 2);
  assert.deepEqual(db.query('SELECT * FROM api_calls ORDER BY id').all(), usageBefore);
  assert.deepEqual(db.query('SELECT id,quota_reset_at FROM users ORDER BY id').all(), resetsBefore);
  assert.equal(getQuota(userId).fiveHour.used, 2);
  assert.equal(getQuota(userId).fiveHour.remaining, 0);
  assert.equal(
    (db.query('SELECT status FROM api_calls WHERE id=?').get(pending) as Row).status,
    'pending',
  );
  assert.throws(
    () => reserveCall(userId, 'conversation', 'character'),
    (error) => error instanceof AppError && error.code === 'QUOTA_EXCEEDED',
  );

  const newlyRegistered = await call('POST', 'auth/register', {
    name: 'New',
    email: 'new@example.test',
    password: 'global-quota-password',
  });
  assert.equal(newlyRegistered.status, 201);
  assert.equal(newlyRegistered.data.limit5h, 2);
  assert.equal(newlyRegistered.data.limit7d, 500);
  updateUser(userId, { limit5h: 6, limit7d: 91 });
  assert.equal(
    (await call('PATCH', 'admin/settings', { siteDescription: 'Unrelated update' })).status,
    200,
  );
  assert.equal(byId(userId).limit_5h, 6);
  assert.equal(byId(userId).limit_7d, 91);
  assert.equal(
    (
      await call('PATCH', 'admin/settings', {
        defaultLimit5h: 2,
        defaultLimit7d: 500,
        maxGroupRounds: 5,
      })
    ).status,
    200,
  );
  assert.equal(byId(userId).limit_5h, 6);
  assert.equal(byId(userId).limit_7d, 91);

  assert.equal((await call('PATCH', 'admin/settings', { defaultLimit7d: 20 })).status, 200);
  assert.ok(limits().every((row) => row.limit_7d === 20));
  assert.equal(byId(userId).limit_5h, 6);
  assert.equal(byId(disabledId).limit_5h, 2);
  assert.equal(byId(adminId).limit_5h, 2);
  updateUser(userId, { limit7d: 95 });
  assert.equal((await call('PATCH', 'admin/settings', { defaultLimit7d: 20 })).status, 200);
  assert.equal(byId(userId).limit_7d, 95);
  assert.equal(
    (await call('PATCH', 'admin/settings', { defaultLimit5h: 3, defaultLimit7d: 30 })).status,
    200,
  );
  assert.ok(limits().every((row) => row.limit_5h === 3 && row.limit_7d === 30));
  const secondNew = await call('POST', 'auth/register', {
    name: 'Latest',
    email: 'latest@example.test',
    password: 'global-quota-password',
  });
  assert.equal(secondNew.status, 201);
  assert.equal(secondNew.data.limit5h, 3);
  assert.equal(secondNew.data.limit7d, 30);

  const stableLimits = limits();
  assert.equal(
    (await call('PATCH', 'admin/settings', { defaultLimit5h: -1, defaultLimit7d: 40 })).status,
    400,
  );
  assert.equal(
    (
      await call('PATCH', 'admin/settings', {
        defaultLimit5h: 8,
        compressionTriggerRounds: 2,
        compressionKeepRounds: 8,
      })
    ).status,
    400,
  );
  assert.deepEqual(limits(), stableLimits);
  assert.equal(getSettings().defaultLimit5h, 3);
  assert.equal(getSettings().defaultLimit7d, 30);

  // Force a failure after the settings and first-axis writes to verify that
  // SQLite rolls back both global values and every already-updated account.
  db.exec(
    "CREATE TRIGGER test_quota_rollback BEFORE UPDATE OF limit_7d ON users WHEN NEW.limit_7d=777 BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;",
  );
  assert.equal(
    (await call('PATCH', 'admin/settings', { defaultLimit5h: 8, defaultLimit7d: 777 })).status,
    500,
  );
  assert.deepEqual(limits(), stableLimits);
  assert.equal(getSettings().defaultLimit5h, 3);
  assert.equal(getSettings().defaultLimit7d, 30);
  db.exec('DROP TRIGGER test_quota_rollback;');
  assert.deepEqual(db.query('SELECT * FROM api_calls ORDER BY id').all(), usageBefore);
  assert.equal(getQuota(userId).fiveHour.used, 2);
  assert.equal(getQuota(userId).sevenDay.used, 2);
  const userQuota = await call('GET', 'quota');
  assert.equal((userQuota.data.fiveHour as { limit: number }).limit, 3);
  assert.equal((userQuota.data.sevenDay as { limit: number }).limit, 30);
  console.log('Global quota check passed');
} finally {
  closeDb();
}
