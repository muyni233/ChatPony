import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import sharp from 'sharp';
import { getDb, closeDb } from '../../src/lib/db';
import { avatarDirectory } from '../../src/lib/avatars';
import { GET, POST, PATCH } from '../../src/app/api/[...path]/route';
import type { Row } from '../../src/lib/mappers';

const temp = process.env.CHATPONY_TEST_DIR;
assert.ok(temp);
process.env.DATABASE_PATH = join(temp, 'account.db');
process.env.ENCRYPTION_KEY = 'a3'.repeat(32);

async function response(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  input?: unknown,
  cookie = '',
) {
  return await { GET, POST, PATCH }[method](
    new Request(`http://test.local/api/${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie.split(';')[0] } : {}),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    }),
    { params: Promise.resolve({ path: path.split('/') }) },
  );
}
async function call(method: 'GET' | 'POST' | 'PATCH', path: string, input?: unknown, cookie = '') {
  const result = await response(method, path, input, cookie);
  const json = (await result.json()) as {
    data: Record<string, unknown>;
    error?: { code: string; message: string };
  };
  return { ...json, status: result.status, cookie: result.headers.get('set-cookie') || '' };
}
const dataUrl = (buffer: Buffer, format: string) =>
  `data:image/${format};base64,${buffer.toString('base64')}`;

try {
  const db = getDb();
  const first = await call('POST', 'auth/register', {
    name: 'One',
    email: 'one@example.test',
    password: 'account-test-password',
  });
  const second = await call('POST', 'auth/register', {
    name: 'Two',
    email: 'two@example.test',
    password: 'account-test-password',
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const userId = String(first.data.id);
  assert.equal(first.data.avatar, '');
  assert.equal((first.data.persona as { enabled: boolean }).enabled, false);
  assert.equal((await call('GET', 'account/persona')).status, 401);
  assert.equal((await call('PATCH', 'account/persona', { name: 'Denied' })).status, 401);
  const persona = {
    enabled: true,
    name: 'Cloud',
    species: 'Pegasus',
    pronouns: 'they/them',
    appearance: 'A pale scarf.',
    personality: 'Thoughtful and curious.',
    background: 'A traveler who likes quiet libraries.',
  };
  assert.equal((await call('PATCH', 'account/persona', persona, first.cookie)).status, 200);
  assert.deepEqual((await call('GET', 'account/persona', undefined, first.cookie)).data, persona);
  assert.equal((await call('GET', 'account/persona', undefined, second.cookie)).data.name, '');
  db.query("UPDATE users SET role='admin' WHERE id=?").run(second.data.id as string);
  const adminList = await call('GET', 'admin/users', undefined, second.cookie);
  assert.equal(adminList.status, 200);
  assert.equal(
    (adminList.data as unknown as Record<string, unknown>[]).some((item) => 'persona' in item),
    false,
  );
  const adminUpdate = await call('PATCH', `admin/users/${userId}`, { limit5h: 49 }, second.cookie);
  assert.equal(adminUpdate.status, 200);
  assert.equal('persona' in adminUpdate.data, false);
  assert.deepEqual((await call('GET', 'account/persona', undefined, first.cookie)).data, persona);
  assert.equal(
    (
      await call(
        'PATCH',
        'account/persona',
        { userId: second.data.id, name: 'Other' },
        first.cookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (await call('PATCH', 'account/persona', { providerId: 'anything' }, first.cookie)).status,
    400,
  );
  assert.equal(
    (await call('PATCH', 'account/persona', { name: 'x'.repeat(61) }, first.cookie)).status,
    400,
  );
  assert.equal(
    (
      await call(
        'PATCH',
        'account/persona',
        {
          name: 'x'.repeat(60),
          species: 'x'.repeat(60),
          pronouns: 'x'.repeat(40),
          appearance: 'x'.repeat(1500),
          personality: 'x'.repeat(1500),
          background: 'x'.repeat(3000),
        },
        first.cookie,
      )
    ).error?.code,
    'PERSONA_TOO_LONG',
  );
  assert.equal((db.query('SELECT COUNT(*) AS count FROM characters').get() as Row).count, 0);
  assert.equal(
    (await call('POST', 'admin/characters', { name: 'Forbidden' }, first.cookie)).status,
    403,
  );
  const bootstrap = await call('GET', 'bootstrap', undefined, first.cookie);
  assert.deepEqual((bootstrap.data.user as { persona: unknown }).persona, persona);

  const jpeg = await sharp({
    create: { width: 320, height: 160, channels: 3, background: '#769977' },
  })
    .withExif({ IFD0: { Artist: 'Fixture private metadata' } })
    .jpeg()
    .toBuffer();
  const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#aa7799' } })
    .png()
    .toBuffer();
  const webp = await sharp(png).webp().toBuffer();
  assert.equal(
    (await call('POST', 'account/avatar', { dataUrl: dataUrl(jpeg, 'jpeg') })).status,
    401,
  );
  const upload = await call(
    'POST',
    'account/avatar',
    { dataUrl: dataUrl(jpeg, 'jpeg') },
    first.cookie,
  );
  assert.equal(upload.status, 200);
  const avatar = String(upload.data.avatar);
  assert.ok(avatar.startsWith(`/api/avatars/${userId}-`));
  assert.ok(existsSync(join(avatarDirectory(), basename(avatar))));
  const image = await response('GET', avatar.slice('/api/'.length));
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/webp');
  assert.ok(image.headers.get('cache-control')?.includes('immutable'));
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  const metadata = await sharp(Buffer.from(await image.arrayBuffer())).metadata();
  assert.equal(metadata.width, 256);
  assert.equal(metadata.height, 256);
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.icc, undefined);
  assert.equal(
    (await call('PATCH', 'account', { name: 'Renamed' }, first.cookie)).data.avatar,
    avatar,
  );
  const otherUpload = await call(
    'POST',
    'account/avatar',
    { dataUrl: dataUrl(png, 'png') },
    second.cookie,
  );
  assert.equal(otherUpload.status, 200);
  const otherAvatar = String(otherUpload.data.avatar);
  assert.equal((await call('PATCH', 'account', { avatar: otherAvatar }, first.cookie)).status, 400);
  assert.equal(
    (await call('PATCH', 'account', { avatar: '/api/avatars/../../database.db' }, first.cookie))
      .status,
    400,
  );
  assert.equal(
    (await call('PATCH', 'account', { avatar: 'javascript:alert(1)' }, first.cookie)).status,
    400,
  );
  const replacement = await call(
    'POST',
    'account/avatar',
    { dataUrl: dataUrl(webp, 'webp') },
    first.cookie,
  );
  assert.equal(replacement.status, 200);
  assert.notEqual(replacement.data.avatar, avatar);
  assert.equal(existsSync(join(avatarDirectory(), basename(avatar))), false);
  assert.equal((await response('GET', otherAvatar.slice('/api/'.length))).status, 200);
  const external = await call(
    'PATCH',
    'account',
    { avatar: 'https://images.example.test/user.png' },
    first.cookie,
  );
  assert.equal(external.status, 200);
  assert.equal(external.data.avatar, 'https://images.example.test/user.png');
  assert.equal(
    existsSync(join(avatarDirectory(), basename(String(replacement.data.avatar)))),
    false,
  );
  // Even legacy/corrupted foreign references must never remove another user's asset.
  db.query('UPDATE users SET avatar=? WHERE id=?').run(otherAvatar, userId);
  assert.equal((await call('PATCH', 'account', { avatar: '' }, first.cookie)).status, 200);
  assert.equal((await response('GET', otherAvatar.slice('/api/'.length))).status, 200);
  for (const filename of ['..%2Faccount.db', '../account.db', 'not-an-avatar.webp', 'x.svg']) {
    const invalid = await GET(new Request('http://test.local/api/avatars/invalid'), {
      params: Promise.resolve({ path: ['avatars', filename] }),
    });
    assert.equal(invalid.status, 404);
  }
  const invalidUpload = async (value: string, expected: number) => {
    db.query('DELETE FROM rate_limits').run();
    assert.equal(
      (await call('POST', 'account/avatar', { dataUrl: value }, first.cookie)).status,
      expected,
    );
  };
  await invalidUpload(
    'data:image/svg+xml;base64,' +
      Buffer.from('<svg><script>bad()</script></svg>').toString('base64'),
    400,
  );
  await invalidUpload(dataUrl(png, 'jpeg'), 400);
  await invalidUpload(dataUrl(Buffer.from('not an image'), 'png'), 400);
  await invalidUpload('data:image/png;base64,not-valid!', 400);
  const oversized = Buffer.alloc(2 * 1024 * 1024 + 1);
  png.copy(oversized, 0, 0, 8);
  await invalidUpload(dataUrl(oversized, 'png'), 413);
  const oversizedPixels = await sharp({
    create: { width: 4001, height: 4000, channels: 3, background: '#eeeeee' },
  })
    .png()
    .toBuffer();
  assert.ok(oversizedPixels.length < 2 * 1024 * 1024);
  await invalidUpload(dataUrl(oversizedPixels, 'png'), 400);
  await invalidUpload('x'.repeat(3 * 1024 * 1024 + 1), 413);
  db.query('DELETE FROM rate_limits').run();
  for (let attempt = 0; attempt < 3; attempt++)
    assert.equal(
      (await call('POST', 'account/avatar', { dataUrl: 'invalid' }, first.cookie)).status,
      400,
    );
  assert.equal(
    (await call('POST', 'account/avatar', { dataUrl: dataUrl(png, 'png') }, first.cookie)).status,
    429,
  );
  closeDb();
  assert.deepEqual(
    JSON.parse(
      String((getDb().query('SELECT persona FROM users WHERE id=?').get(userId) as Row).persona),
    ),
    persona,
  );
  console.log('Account check passed');
} finally {
  closeDb();
}
