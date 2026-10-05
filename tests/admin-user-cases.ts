import assert from 'node:assert/strict';
import * as routes from '../src/app/api/[...path]/route';
import { getDb, transaction } from '../src/lib/server/db';

const origin = 'http://localhost:3000';
let assertions = 0;
function check(value: unknown, message: string) {
  assert.ok(value, message);
  assertions++;
}
async function api(method: 'GET' | 'POST' | 'PATCH', path: string, cookie = '', body?: unknown) {
  const response = await routes[method](
    new Request(`${origin}/api/${path}`, {
      method,
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0] || '',
  };
}
const password = 'Isolated-directory-password-2026';
const bootstrap = await api('POST', 'auth/register', '', {
  username: 'InitialAdmin%',
  email: 'earliest@example.test',
  password,
});
const admin = bootstrap.cookie;
check(bootstrap.status === 201, 'An isolated directory administrator is created normally');
await api('PATCH', 'admin/settings', admin, { requireEmailVerification: false });
const member = await api('POST', 'auth/register', '', {
  username: 'DirectoryReader',
  email: 'reader@example.test',
  password,
});
const db = getDb();
const encoded = (
  db.prepare('SELECT password_hash FROM users WHERE id=?').get(bootstrap.data.user.id) as {
    password_hash: string;
  }
).password_hash;
const later = new Date(Date.parse(bootstrap.data.user.createdAt) + 1000).toISOString();
transaction(() => {
  const insert = db.prepare(
    'INSERT INTO users(id,username,email,password_hash,role,email_verified,created_at) VALUES (?,?,?,?,?,?,?)',
  );
  for (let index = 0; index < 1005; index++) {
    const suffix = String(index).padStart(5, '0');
    insert.run(
      `bulk-${suffix}`,
      `bulk_${suffix}`,
      `bulk-${suffix}@example.test`,
      encoded,
      'user',
      1,
      later,
    );
  }
  insert.run(
    'literal-underscore-control',
    'bulkXcontrol',
    'underscore-control@example.test',
    encoded,
    'user',
    1,
    later,
  );
  insert.run(
    'literal-backslash',
    'slash\\name',
    'backslash@example.test',
    encoded,
    'user',
    1,
    later,
  );
});
const total = 1009;
const list = await api('GET', 'admin/users', admin);
check(
  list.status === 200 &&
    list.data.total === total &&
    list.data.users.length === 50 &&
    list.data.page === 1 &&
    list.data.pageSize === 50,
  'Default page is bounded and reports all users rather than silently capping at 1000',
);
check(
  !list.data.users.some((user: { id: string }) => user.id === bootstrap.data.user.id),
  'The initial administrator is genuinely beyond the first-page test fixture',
);
const first = await api('GET', 'admin/users?query=InitialAdmin', admin);
check(
  first.data.total === 1 && first.data.users[0].id === bootstrap.data.user.id,
  'Server-side name search can find the earliest user after more than 1000 later registrations',
);
const email = await api('GET', 'admin/users?query=EARLIEST%40EXAMPLE', admin);
check(
  email.data.total === 1 && email.data.users[0].id === bootstrap.data.user.id,
  'Email lookup supports case-insensitive literal substrings',
);
const id = await api(
  'GET',
  `admin/users?query=${encodeURIComponent(bootstrap.data.user.id.slice(0, 20))}`,
  admin,
);
check(
  id.data.total === 1 && id.data.users[0].id === bootstrap.data.user.id,
  'User identifiers are searchable by substring',
);
check(
  (await api('GET', 'admin/users?query=%25', admin)).data.total === 1,
  'A percent sign in a search term is literal, not a match-all wildcard',
);
check(
  (await api('GET', 'admin/users?query=bulk_', admin)).data.total === 1005,
  'An underscore matches a literal underscore rather than any character',
);
check(
  (await api('GET', `admin/users?query=${encodeURIComponent('slash\\name')}`, admin)).data.users[0]
    .id === 'literal-backslash',
  'A backslash remains searchable as literal data',
);
check(
  (await api('GET', `admin/users?query=${encodeURIComponent("%' OR 1=1 --")}`, admin)).data
    .total === 0,
  'SQL-looking search text is always a bound literal value',
);
const pages = await Promise.all(
  [1, 2].map((page) => api('GET', `admin/users?query=bulk_&pageSize=100&page=${page}`, admin)),
);
const firstIds = pages[0].data.users.map((user: { id: string }) => user.id),
  secondIds = pages[1].data.users.map((user: { id: string }) => user.id);
check(
  firstIds.length === 100 &&
    secondIds.length === 100 &&
    !secondIds.some((value: string) => firstIds.includes(value)),
  'Adjacent pages have bounded, distinct results',
);
check(
  firstIds[0] === 'bulk-01004' && firstIds.at(-1) === 'bulk-00905' && secondIds[0] === 'bulk-00904',
  'Equal timestamps have a deterministic descending ID tiebreaker',
);
const last = await api('GET', 'admin/users?page=9999&pageSize=50', admin);
check(
  last.data.page === Math.ceil(total / 50) &&
    last.data.users.length === total % 50 &&
    last.data.users.some((user: { id: string }) => user.id === bootstrap.data.user.id),
  'Out-of-range pages clamp to the final page including old accounts',
);
const empty = await api('GET', 'admin/users?page=9999&query=NoSuchUser-unique', admin);
check(
  empty.data.total === 0 && empty.data.page === 1 && empty.data.users.length === 0,
  'An empty search still has a stable page-one response',
);
for (const params of [
  'page=0',
  'page=-1',
  'page=1.5',
  'page=1000001',
  'pageSize=0',
  'pageSize=101',
  `query=${'x'.repeat(101)}`,
  'query=line%0Abreak',
]) {
  const rejected = await api('GET', `admin/users?${params}`, admin);
  check(
    rejected.status === 400 && rejected.data.error.code === 'INVALID_USER_FILTER',
    `Invalid directory input is rejected: ${params.slice(0, 40)}`,
  );
}
const anonymous = await api(
  'GET',
  `admin/users?query=${encodeURIComponent(bootstrap.data.user.email)}`,
);
const forbidden = await api(
  'GET',
  `admin/users?query=${encodeURIComponent(bootstrap.data.user.email)}`,
  member.cookie,
);
check(
  anonymous.status === 401 &&
    forbidden.status === 403 &&
    !('users' in anonymous.data) &&
    !('users' in forbidden.data),
  'Anonymous and ordinary accounts cannot infer any user rows or totals',
);
check(
  !JSON.stringify(list.data).includes('password_hash') &&
    !JSON.stringify(list.data).includes(encoded) &&
    !JSON.stringify(list.data).includes('token_hash'),
  'Directory responses contain profile metadata without credentials or session material',
);
const edited = await api('PATCH', `admin/users/${first.data.users[0].id}`, admin, {
  quota1d: 15,
  quota1dEnabled: true,
});
check(
  edited.status === 200 &&
    edited.data.user.quota1d === 15 &&
    edited.data.user.quota1dEnabled === true,
  'An old user found through search remains editable through the existing endpoint',
);
console.log(
  `Admin user directory: ${assertions} assertions passed (1009 users, literal search, pagination and permissions).`,
);
