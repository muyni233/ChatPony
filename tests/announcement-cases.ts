import assert from 'node:assert/strict';
import * as routes from '../src/app/api/[...path]/route';
import { getDb } from '../src/lib/server/db';

let assertions = 0;
function check(value: unknown, label: string) {
  assert.ok(value, label);
  assertions++;
}
const origin = 'http://localhost:3210';
async function api(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  cookie = '',
  body?: unknown,
  from = origin,
) {
  const response = await routes[method](
    new Request(`${origin}/api/${path}`, {
      method,
      headers: { Origin: from, Cookie: cookie, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0] || '',
  };
}
const password = 'Announcement-test-password-42!';
const bootstrap = await api('POST', 'auth/register', '', {
  username: 'NoticeAdmin',
  email: 'admin@example.test',
  password,
});
const admin = bootstrap.cookie;
check(
  bootstrap.status === 201 && bootstrap.data.user.role === 'admin',
  'first account is administrator',
);
await api('PATCH', 'admin/settings', admin, { requireEmailVerification: false });
const member = await api('POST', 'auth/register', '', {
  username: 'NoticeReader',
  email: 'reader@example.test',
  password,
});
const user = member.cookie;
check(member.status === 201 && member.data.user.role === 'user', 'regular reader registered');
check((await api('GET', 'announcements')).status === 401, 'anonymous cannot read announcements');
check(
  (await api('GET', 'admin/announcements', user)).status === 403,
  'reader cannot access admin list',
);
check(
  (await api('POST', 'admin/announcements', user, { title: 'x', body: 'x' })).status === 403,
  'reader cannot create',
);
check(
  (
    await api(
      'POST',
      'admin/announcements',
      admin,
      { title: 'x', body: 'x' },
      'https://outside.test',
    )
  ).status === 403,
  'cross-origin mutation denied',
);
check(
  (await api('POST', 'admin/announcements', admin, { title: ' ', body: 'x' })).status === 400,
  'empty title rejected',
);
check(
  (await api('POST', 'admin/announcements', admin, { title: 'x', body: 'x'.repeat(12001) }))
    .status === 400,
  'oversized body rejected',
);
check(
  (await api('POST', 'admin/announcements', admin, { title: 'x', body: 'x', status: 'secret' }))
    .status === 400,
  'unknown status rejected',
);
const draft = await api('POST', 'admin/announcements', admin, {
  title: '平台维护',
  body: '第一行\n第二行 <script>alert(1)</script>',
  status: 'draft',
  pinned: false,
});
const id = draft.data.announcement.id;
check(draft.status === 201 && draft.data.announcement.revision === 1, 'draft created');
check((await api('GET', 'admin/announcements', admin)).data.total === 1, 'admin sees draft');
check((await api('GET', 'announcements', user)).data.total === 0, 'draft hidden from feed');
check(
  (await api('GET', `announcements/${id}`, user)).status === 404,
  'draft hidden from direct link',
);
check(
  (await api('POST', `announcements/${id}/read`, user, { revision: 1 })).status === 404,
  'draft cannot be marked read',
);
const publish = await api('PATCH', `admin/announcements/${id}`, admin, {
  status: 'published',
  revision: 1,
});
check(
  publish.status === 200 &&
    publish.data.announcement.publishedAt &&
    publish.data.announcement.revision === 2,
  'publishing sets version and time',
);
let feed = await api('GET', 'announcements', user);
check(
  feed.data.unreadCount === 1 && feed.data.items[0].readAt === null,
  'published announcement is unread',
);
check(
  feed.data.items[0].body === draft.data.announcement.body,
  'plain text is preserved including markup as data',
);
check(
  (await api('POST', `announcements/${id}/read`, user, { revision: 1 })).status === 409,
  'stale view cannot mark current version read',
);
check(
  (await api('POST', `announcements/${id}/read`, user, { revision: 2 })).data.unreadCount === 0,
  'current version marked read',
);
check((await api('GET', 'announcements', user)).data.items[0].readAt, 'read persists in list');
check(
  (await api('GET', 'announcements/unread', admin)).data.unreadCount === 1,
  'read status is per user',
);
check(
  (await api('PATCH', `admin/announcements/${id}`, admin, { title: '竞争版本', revision: 1 }))
    .status === 409,
  'stale editor cannot overwrite',
);
check(
  (await api('PATCH', `admin/announcements/${id}`, admin, { title: '缺少版本' })).status === 400,
  'update requires explicit version',
);
check(
  (await api('PATCH', `admin/announcements/${id}`, admin, { revision: 2 })).data.announcement
    .revision === 2,
  'no-op save does not re-notify',
);
check(
  (await api('GET', 'announcements/unread', user)).data.unreadCount === 0,
  'no-op retains reads',
);
const edited = await api('PATCH', `admin/announcements/${id}`, admin, {
  title: '维护时间更新',
  revision: 2,
});
check(edited.data.announcement.revision === 3, 'content edits increase version');
check(
  (await api('GET', 'announcements/unread', user)).data.unreadCount === 1,
  'edited content becomes unread',
);
await api('POST', `announcements/${id}/read`, user, { revision: 3 });
const pinned = await api('POST', 'admin/announcements', admin, {
  title: '置顶说明',
  body: '使用帮助',
  status: 'published',
  pinned: true,
});
feed = await api('GET', 'announcements?pageSize=1', user);
check(
  feed.data.total === 2 &&
    feed.data.items.length === 1 &&
    feed.data.items[0].id === pinned.data.announcement.id,
  'pinned first with pagination',
);
check(
  (await api('GET', 'announcements?page=999&pageSize=1', user)).data.page === 2,
  'out-of-range page clamped',
);
check(
  (await api('GET', 'announcements?pageSize=9999', user)).status === 400,
  'page size bound enforced',
);
check(
  (await api('GET', 'announcements?page=-1', user)).status === 400,
  'negative pagination rejected',
);
check(
  (await api('PATCH', `admin/announcements/${id}`, user, { revision: 3, body: 'unauthorized' }))
    .status === 403,
  'reader cannot edit',
);
check(
  (await api('DELETE', `admin/announcements/${id}`, user)).status === 403,
  'reader cannot delete',
);
await api('PATCH', `admin/announcements/${id}`, admin, { revision: 3, status: 'draft' });
check(
  (await api('GET', `announcements/${id}`, user)).status === 404,
  'withdrawal hides published link',
);
check(
  (await api('POST', `announcements/${id}/read`, user, { revision: 3 })).status === 404,
  'withdrawn announcement cannot mark read',
);
await api('PATCH', `admin/announcements/${id}`, admin, { revision: 4, status: 'published' });
check(
  (await api('GET', 'announcements/unread', user)).data.unreadCount === 2,
  'republishing creates unread revision',
);
check(
  (
    getDb()
      .prepare('SELECT COUNT(*) AS n FROM announcement_reads WHERE announcement_id=?')
      .get(id) as { n: number }
  ).n === 1,
  'read history stored once per user',
);
check(
  (await api('DELETE', `admin/announcements/${id}`, admin)).data.ok,
  'admin deletes announcement',
);
check(
  (
    getDb()
      .prepare('SELECT COUNT(*) AS n FROM announcement_reads WHERE announcement_id=?')
      .get(id) as { n: number }
  ).n === 0,
  'deletion cascades stale read state',
);
check(
  (await api('GET', `announcements/${id}`, user)).status === 404,
  'deleted announcement inaccessible',
);
check(
  (await api('GET', 'announcements/unread', user)).data.unreadCount === 1,
  'deletion removes unread entry',
);
console.log(`Announcement integration: ${assertions} assertions passed.`);
