import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createAuditStore,
  type BeginAuditInput,
  type FinishAuditInput,
} from '../src/lib/server/audit';
import { getDb } from '../src/lib/server/db';

// This fixture is launched only with a fresh test directory by audit.test.ts.
const databasePath = process.env.DATABASE_PATH || '';
assert.ok(
  resolve(databasePath).startsWith(`${resolve('.tmp')}${sep}audit-`),
  'Refusing to use a non-test database',
);
const db = getDb();
const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.parse('2026-10-05T02:00:00.000Z');
let timestamp = BASE;
let retentionDays = 90;
let checks = 0;
const store = createAuditStore({ db, now: () => timestamp, retentionDays: () => retentionDays });
const input: BeginAuditInput = {
  userId: 'user-alice',
  username: 'Alice',
  conversationId: 'conversation-one',
  conversationTitle: '图书馆的约定',
  kind: 'group',
  provider: { id: 'provider-one', name: 'Gateway One', protocol: 'openai-chat', model: 'model-X' },
  characterNames: ['角色甲', '角色乙'],
};
function check(condition: unknown, message: string): asserts condition {
  assert.ok(condition, message);
  checks++;
}
function equal(actual: unknown, expected: unknown, message: string) {
  assert.deepEqual(actual, expected, message);
  checks++;
}
function reset() {
  db.exec('DELETE FROM request_audit');
  timestamp = BASE;
  retentionDays = 90;
}
function read(query = '') {
  return store.readAudit(new URLSearchParams(query));
}
function add(
  status: FinishAuditInput['status'],
  age: number,
  duration = 0,
  replies = 0,
  charged: 0 | 1 = 0,
) {
  timestamp = BASE - age;
  const id = store.beginAudit(input);
  timestamp += duration;
  store.finishAudit(id, {
    status,
    replyCount: replies,
    outputCharacters: replies * 30,
    quotaCharged: charged,
  });
  return id;
}

try {
  // Privacy: structurally compatible objects may contain secrets, but only picked metadata is stored.
  const extended = {
    ...input,
    prompt: 'PRIVATE_PROMPT_SENTINEL',
    messages: [{ content: 'PRIVATE_MESSAGE_SENTINEL' }],
    email: 'PRIVATE_EMAIL_SENTINEL',
    provider: {
      ...input.provider!,
      apiKey: 'PRIVATE_KEY_SENTINEL',
      baseUrl: 'PRIVATE_ENDPOINT_SENTINEL',
    },
  };
  const privateId = store.beginAudit(extended);
  let entry = read().entries.items[0];
  equal(
    [entry.status, entry.durationMs, entry.finishedAt],
    ['pending', null, null],
    'Begun requests are pending',
  );
  timestamp += 1250;
  check(
    store.finishAudit(privateId, {
      status: 'error',
      replyCount: 1,
      outputCharacters: 75,
      quotaCharged: 1,
      errorCode: 'PRIVATE_KEY_SENTINEL',
      errorMessage: 'PRIVATE_PROMPT_SENTINEL Authorization: Bearer PRIVATE_KEY_SENTINEL',
    }),
    'First terminal transition succeeds',
  );
  entry = read().entries.items[0];
  equal(
    [
      entry.errorCode,
      entry.durationMs,
      entry.replyCount,
      entry.outputCharacters,
      entry.quotaCharged,
    ],
    ['GENERATION_FAILED', 1250, 1, 75, 0],
    'Failures preserve numeric diagnostics without charging quota',
  );
  const raw = JSON.stringify(db.prepare('SELECT * FROM request_audit').all());
  for (const sentinel of [
    'PRIVATE_PROMPT_SENTINEL',
    'PRIVATE_MESSAGE_SENTINEL',
    'PRIVATE_EMAIL_SENTINEL',
    'PRIVATE_KEY_SENTINEL',
    'PRIVATE_ENDPOINT_SENTINEL',
  ]) {
    check(!raw.includes(sentinel), `${sentinel} must never enter audit storage`);
  }
  check(
    !store.finishAudit(privateId, { status: 'success', quotaCharged: 1 }),
    'A finished request cannot be overwritten',
  );
  equal(read().entries.items[0].status, 'error', 'First terminal result remains authoritative');
  check(
    !store.finishAudit('missing-request', { status: 'cancelled' }),
    'Missing audit ID is harmless',
  );

  reset();
  const actualProviderId = store.beginAudit(input);
  store.finishAudit(actualProviderId, {
    status: 'success',
    provider: {
      id: 'provider-two',
      name: 'Actual Gateway',
      protocol: 'anthropic',
      model: 'actual-model',
    },
    characterNames: ['角色乙', '角色乙', ' 角色丙 '],
    replyCount: 2,
    outputCharacters: 100,
    quotaCharged: 1,
  });
  entry = read().entries.items[0];
  equal(
    [entry.providerId, entry.providerName, entry.protocol, entry.model],
    ['provider-two', 'Actual Gateway', 'anthropic', 'actual-model'],
    'Actual provider overrides the initial snapshot',
  );
  equal(entry.characterNames, ['角色乙', '角色丙'], 'Final cast is normalized and deduplicated');
  const cleared = store.beginAudit(input);
  store.finishAudit(cleared, {
    status: 'rejected',
    provider: null,
    errorCode: 'PROVIDER_NOT_CONFIGURED',
    errorMessage: 'DO_NOT_STORE_THIS',
  });
  const clearedRow = read(`query=${cleared}`).entries.items[0];
  equal(
    [clearedRow.providerId, clearedRow.providerName, clearedRow.protocol, clearedRow.model],
    [null, null, null, null],
    'Explicit null clears an unused provider',
  );
  equal(
    clearedRow.errorMessage,
    '尚未配置可用的模型服务。',
    'Known codes use a curated friendly message',
  );

  reset();
  const unmetered = store.beginAudit(input);
  store.finishAudit(unmetered, {
    status: 'success',
    quotaCharged: 0,
    replyCount: 1,
    outputCharacters: 10,
  });
  equal(
    [read().stats.success, read().stats.chargedTurns, read().stats.replies],
    [1, 0, 1],
    'A successful turn with all quota windows disabled is not charged',
  );

  reset();
  add('success', 25 * 60 * 60 * 1000, 0, 99, 1);
  add('success', DAY, 0, 99, 1);
  add('replayed', 6 * 60 * 60 * 1000, 0, 99, 1);
  add('rejected', 5 * 60 * 60 * 1000, 0, 99, 1);
  add('cancelled', 4 * 60 * 60 * 1000, 4000, 1, 1);
  add('error', 3 * 60 * 60 * 1000, 2000, 1, 1);
  add('success', 2 * 60 * 60 * 1000, 3000, 1, 1);
  add('success', 1 * 60 * 60 * 1000, 1000, 2, 1);
  timestamp = BASE;
  store.beginAudit(input);
  let result = read('days=1');
  equal(
    [
      result.stats.requests,
      result.stats.success,
      result.stats.error,
      result.stats.cancelled,
      result.stats.rejected,
      result.stats.replayed,
      result.stats.pending,
    ],
    [7, 2, 1, 1, 1, 1, 1],
    '24-hour rolling window excludes its exact boundary and older rows',
  );
  equal(
    [result.stats.chargedTurns, result.stats.replies, result.stats.averageDurationMs],
    [2, 3, 2500],
    'Charges and committed replies exclude replay/failure; average excludes rejected/replayed/pending',
  );
  equal(
    result.stats.daily.map((day) => day.date),
    ['2026-10-04', '2026-10-05'],
    'Daily buckets explicitly use UTC across midnight',
  );
  equal(
    result.stats.daily.reduce((sum, day) => sum + day.requests, 0),
    result.stats.requests,
    'Daily requests add up to the filtered total',
  );
  equal(
    result.stats.daily.reduce((sum, day) => sum + day.success, 0),
    result.stats.success,
    'Daily successes add up to the filtered total',
  );
  const replay = result.entries.items.find((item) => item.status === 'replayed')!;
  equal(
    [replay.replyCount, replay.outputCharacters, replay.quotaCharged],
    [0, 0, 0],
    'Replays never count as new output or quota',
  );
  result = read('days=1&status=error');
  equal(
    [result.entries.total, result.stats.requests, result.stats.error, result.stats.success],
    [1, 1, 1, 0],
    'Status filter applies consistently to list and statistics',
  );

  reset();
  for (let index = 0; index < 45; index++) {
    timestamp = BASE + index;
    const id = store.beginAudit({
      ...input,
      username: index === 22 ? 'Literal_%Name' : `User ${index}`,
      conversationTitle: index === 22 ? 'Unique needle' : input.conversationTitle,
    });
    store.finishAudit(id, { status: 'success', quotaCharged: 1 });
  }
  timestamp = BASE + 50;
  result = read('page=1');
  equal(
    [
      result.entries.items.length,
      result.entries.total,
      result.entries.page,
      result.entries.pageSize,
    ],
    [20, 45, 1, 20],
    'Default pagination is bounded',
  );
  equal(result.entries.items[0].username, 'User 44', 'Newest entry is first');
  equal(read('page=3').entries.items.length, 5, 'Last page contains the remainder');
  equal(read('page=99').entries.items.length, 0, 'Out-of-range pages remain empty');
  equal(
    read('pageSize=7&page=2').entries.items[0].username,
    'User 37',
    'Custom page size and offset match',
  );
  for (const needle of ['%', '_', 'Unique needle'])
    equal(
      read(`query=${encodeURIComponent(needle)}`).entries.total,
      1,
      'Search uses literal wildcard characters',
    );
  equal(
    read(`query=${encodeURIComponent("' OR 1=1 --")}`).entries.total,
    0,
    'SQL-like input cannot alter query scope',
  );
  equal(read('query=GATEWAY').entries.total, 45, 'Provider search is case insensitive for ASCII');
  equal(
    read(`query=${encodeURIComponent('角色乙')}`).entries.total,
    45,
    'Character names are searchable',
  );
  equal(read('query=model-X').entries.total, 45, 'Model names are searchable');
  for (const query of [
    'days=0',
    'days=366',
    'days=1.5',
    'page=0',
    'pageSize=101',
    'status=unknown',
    `query=${'x'.repeat(101)}`,
    'query=%00',
  ]) {
    assert.throws(
      () => read(query),
      (error: unknown) =>
        !!error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'INVALID_AUDIT_FILTER',
    );
    checks++;
  }

  reset();
  add('success', 91 * DAY, 0, 1, 1);
  add('success', 89 * DAY, 0, 1, 1);
  add('success', 8 * DAY, 0, 1, 1);
  add('success', 6 * DAY, 0, 1, 1);
  timestamp = BASE;
  result = read('days=365');
  equal(
    [result.retentionDays, result.filters.days, result.entries.total],
    [90, 90, 3],
    'Default retention removes only records older than 90 days',
  );
  equal(
    (db.prepare('SELECT COUNT(*) AS n FROM request_audit').get() as { n: number }).n,
    3,
    'Retention actually removes expired audit data',
  );
  retentionDays = 7;
  result = read('days=30');
  equal(
    [result.retentionDays, result.filters.days, result.entries.total],
    [7, 7, 1],
    'Reduced retention is applied and reported instead of displaying fictitious old zeroes',
  );
  retentionDays = 365;
  equal(read('days=365').filters.days, 365, 'Maximum supported retention is valid');

  reset();
  timestamp = BASE - 15 * 60 * 1000;
  const abandoned = store.beginAudit(input);
  timestamp = BASE;
  const active = store.beginAudit(input);
  result = read();
  const recovered = result.entries.items.find((item) => item.id === abandoned)!;
  equal(
    [recovered.status, recovered.errorCode, recovered.durationMs, recovered.quotaCharged],
    ['error', 'GENERATION_INTERRUPTED', 15 * 60 * 1000, 0],
    'Expired pending requests become non-charged interrupted results',
  );
  equal(
    result.entries.items.find((item) => item.id === active)?.status,
    'pending',
    'Current requests remain pending',
  );

  reset();
  const transactional = store.beginAudit(input);
  db.exec('BEGIN IMMEDIATE');
  store.finishAudit(transactional, { status: 'success', quotaCharged: 1, replyCount: 2 });
  equal(read().stats.chargedTurns, 1, 'Audit reading works inside the caller transaction');
  db.exec('ROLLBACK');
  equal(
    [read().entries.items[0].status, read().stats.chargedTurns],
    ['pending', 0],
    'Audit success rolls back together with a failed caller transaction',
  );

  reset();
  add('success', 0, 0, 1, 1);
  const concurrent = new DatabaseSync(databasePath);
  try {
    let inserted = false;
    const intercepted = {
      exec(sql: string) {
        return db.exec(sql);
      },
      prepare(sql: string) {
        const statement = db.prepare(sql);
        if (!sql.trimStart().startsWith('SELECT COUNT(*) AS requests,')) return statement;
        return {
          get(...values: (string | number)[]) {
            const row = statement.get(...values);
            if (!inserted) {
              inserted = true;
              concurrent
                .prepare(
                  `INSERT INTO request_audit(id,created_at,status,user_id,username,conversation_id,conversation_title,kind)
                VALUES ('parallel-record',?,'pending','parallel-user','Parallel','parallel-conversation','Parallel','direct')`,
                )
                .run(timestamp);
            }
            return row;
          },
        };
      },
    } as unknown as DatabaseSync;
    const snapshotStore = createAuditStore({
      db: intercepted,
      now: () => timestamp,
      retentionDays: () => 90,
    });
    const snapshot = snapshotStore.readAudit(new URLSearchParams());
    equal(
      [
        snapshot.stats.requests,
        snapshot.entries.total,
        snapshot.entries.items.length,
        snapshot.stats.daily.reduce((sum, day) => sum + day.requests, 0),
      ],
      [1, 1, 1, 1],
      'List, counters and daily trend share one snapshot across concurrent commits',
    );
    equal(read().stats.requests, 2, 'The next read sees the newly committed audit');
  } finally {
    concurrent.close();
  }

  console.log(
    `Audit store: ${checks} assertions passed (isolated SQLite, privacy, filters, pagination, retention, counters, rollback and concurrent read snapshots).`,
  );
} finally {
  db.close();
}
