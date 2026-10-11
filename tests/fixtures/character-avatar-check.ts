import { strict as assert } from 'node:assert';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { GET, POST, PATCH } from '../../src/app/api/[...path]/route';
import { avatarDirectory } from '../../src/lib/avatars';
import { getDb, closeDb } from '../../src/lib/db';
import type { Row } from '../../src/lib/mappers';

const temp = process.env.CHATPONY_TEST_DIR;
assert.ok(temp);
process.env.DATABASE_PATH = join(temp, 'avatars.db');
process.env.ENCRYPTION_KEY = '8b'.repeat(32);

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
  const data = (await result.json()) as { data: Record<string, unknown>; error?: { code: string } };
  return { ...data, status: result.status, cookie: result.headers.get('set-cookie') || '' };
}
const imageUrl = (buffer: Buffer, mime = 'png') =>
  `data:image/${mime};base64,${buffer.toString('base64')}`;
const fileExists = (url: string) => existsSync(join(avatarDirectory(), basename(url)));
const fileCount = () => (existsSync(avatarDirectory()) ? readdirSync(avatarDirectory()).length : 0);
const characterCount = () =>
  Number((getDb().query('SELECT COUNT(*) AS count FROM characters').get() as Row).count);
const resetLimit = () => getDb().query('DELETE FROM rate_limits').run();

try {
  const db = getDb();
  const account = await call('POST', 'auth/register', {
    name: 'Avatar Admin',
    email: 'avatar-admin@example.test',
    password: 'avatar-test-password',
  });
  const member = await call('POST', 'auth/register', {
    name: 'Avatar Member',
    email: 'avatar-member@example.test',
    password: 'avatar-test-password',
  });
  assert.equal(account.status, 201);
  assert.equal(member.status, 201);
  db.query("UPDATE users SET role='admin' WHERE id=?").run(String(account.data.id));
  const png = await sharp({
    create: { width: 340, height: 160, channels: 4, background: '#678c71' },
  })
    .png()
    .toBuffer();
  const jpeg = await sharp(png)
    .withExif({ IFD0: { Artist: 'Private fixture metadata' } })
    .jpeg()
    .toBuffer();
  const webp = await sharp(png).webp().toBuffer();
  const draft = {
    name: 'Uploaded Avatar',
    slug: 'uploaded-avatar',
    personality: 'A plain test character.',
    active: false,
  };
  assert.equal(
    (await call('POST', 'admin/characters', { ...draft, avatarDataUrl: imageUrl(png) })).status,
    401,
  );
  assert.equal(
    (
      await call(
        'POST',
        'admin/characters',
        { ...draft, avatarDataUrl: imageUrl(png) },
        member.cookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        'POST',
        'admin/characters',
        { ...draft, avatarDataUrl: 'data:image/png;base64,ZmFrZQ==' },
        account.cookie,
      )
    ).status,
    400,
  );
  assert.equal(characterCount(), 0);
  assert.equal(fileCount(), 0);
  const saved = await call(
    'POST',
    'admin/characters',
    { ...draft, avatarDataUrl: imageUrl(jpeg, 'jpeg') },
    account.cookie,
  );
  assert.equal(saved.status, 201);
  const characterId = String(saved.data.id);
  const firstAvatar = String(saved.data.avatar);
  assert.ok(firstAvatar.startsWith(`/api/avatars/character-${characterId}-`));
  assert.equal(characterCount(), 1);
  assert.ok(fileExists(firstAvatar));
  const bytes = await response('GET', firstAvatar.slice('/api/'.length));
  assert.equal(bytes.status, 200);
  assert.equal(bytes.headers.get('content-type'), 'image/webp');
  const metadata = await sharp(Buffer.from(await bytes.arrayBuffer())).metadata();
  assert.equal(metadata.width, 256);
  assert.equal(metadata.height, 256);
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.icc, undefined);
  const renamed = await call(
    'PATCH',
    `admin/characters/${characterId}`,
    { name: 'Renamed Avatar', avatar: firstAvatar },
    account.cookie,
  );
  assert.equal(renamed.status, 200);
  assert.equal(renamed.data.avatar, firstAvatar);
  const oldFiles = fileCount();
  const failedValidation = await call(
    'POST',
    'admin/characters',
    { ...draft, avatarDataUrl: imageUrl(png) },
    account.cookie,
  );
  assert.equal(failedValidation.status, 409);
  assert.equal(fileCount(), oldFiles);
  assert.equal(characterCount(), 1);
  assert.equal(
    (
      await call(
        'PATCH',
        `admin/characters/${characterId}`,
        { personality: '', avatarDataUrl: imageUrl(png) },
        account.cookie,
      )
    ).status,
    400,
  );
  assert.ok(fileExists(firstAvatar));
  assert.equal(fileCount(), oldFiles);
  const replacement = await call(
    'PATCH',
    `admin/characters/${characterId}`,
    { avatarDataUrl: imageUrl(webp, 'webp') },
    account.cookie,
  );
  assert.equal(replacement.status, 200);
  assert.notEqual(replacement.data.avatar, firstAvatar);
  assert.equal(fileExists(firstAvatar), false);
  const secondAvatar = String(replacement.data.avatar);
  assert.ok(fileExists(secondAvatar));

  // A transaction failure after the new file was written removes the file and rolls back the role.
  db.exec(
    "CREATE TRIGGER reject_uploaded_avatar BEFORE UPDATE OF avatar ON characters WHEN NEW.avatar LIKE '/api/avatars/character-%' BEGIN SELECT RAISE(ABORT, 'fixture write rejected'); END;",
  );
  resetLimit();
  assert.equal(
    (
      await call(
        'POST',
        'admin/characters',
        { ...draft, slug: 'rollback-avatar', avatarDataUrl: imageUrl(png) },
        account.cookie,
      )
    ).status,
    500,
  );
  assert.equal(characterCount(), 1);
  assert.equal(fileCount(), 1);
  db.exec('DROP TRIGGER reject_uploaded_avatar;');
  const retried = await call(
    'POST',
    'admin/characters',
    { ...draft, slug: 'rollback-avatar', avatarDataUrl: imageUrl(png) },
    account.cookie,
  );
  assert.equal(retried.status, 201);
  assert.equal(characterCount(), 2);
  const otherAvatar = String(retried.data.avatar);
  assert.equal(
    (
      await call(
        'PATCH',
        `admin/characters/${characterId}`,
        { avatar: otherAvatar },
        account.cookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        'POST',
        'admin/characters',
        { ...draft, slug: 'foreign-avatar', avatar: secondAvatar },
        account.cookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        'PATCH',
        `admin/characters/${characterId}`,
        { avatar: '/api/avatars/../avatars.db' },
        account.cookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        'PATCH',
        `admin/characters/${characterId}`,
        { avatar: 'javascript:alert(1)' },
        account.cookie,
      )
    ).status,
    400,
  );
  assert.ok(fileExists(secondAvatar));
  assert.ok(fileExists(otherAvatar));
  const external = await call(
    'PATCH',
    `admin/characters/${characterId}`,
    { avatar: 'https://example.test/new-avatar.png' },
    account.cookie,
  );
  assert.equal(external.status, 200);
  assert.equal(fileExists(secondAvatar), false);
  assert.ok(fileExists(otherAvatar));
  assert.equal(
    (
      await call(
        'PATCH',
        `admin/characters/${String(retried.data.id)}`,
        { avatar: '' },
        account.cookie,
      )
    ).status,
    200,
  );
  assert.equal(fileExists(otherAvatar), false);
  resetLimit();
  const accountUpload = await call(
    'POST',
    'account/avatar',
    { dataUrl: imageUrl(png) },
    member.cookie,
  );
  assert.equal(accountUpload.status, 200);
  const accountAvatar = String(accountUpload.data.avatar);
  assert.ok(accountAvatar.startsWith(`/api/avatars/${member.data.id}-`));
  assert.equal(
    (
      await call(
        'PATCH',
        `admin/characters/${characterId}`,
        { avatar: accountAvatar },
        account.cookie,
      )
    ).status,
    400,
  );
  db.query('UPDATE characters SET avatar=? WHERE id=?').run(accountAvatar, characterId);
  assert.equal(
    (await call('PATCH', `admin/characters/${characterId}`, { avatar: '' }, account.cookie)).status,
    200,
  );
  assert.ok(fileExists(accountAvatar));

  for (const invalid of [
    imageUrl(png, 'jpeg'),
    imageUrl(Buffer.from('not png')),
    'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64'),
  ]) {
    resetLimit();
    assert.equal(
      (
        await call(
          'PATCH',
          `admin/characters/${characterId}`,
          { avatarDataUrl: invalid },
          account.cookie,
        )
      ).status,
      400,
    );
  }
  resetLimit();
  assert.equal(
    (
      await call(
        'PATCH',
        `admin/characters/${characterId}`,
        { avatarDataUrl: imageUrl(Buffer.alloc(2 * 1024 * 1024 + 1)) },
        account.cookie,
      )
    ).status,
    413,
  );
  assert.equal(
    (
      await call(
        'PATCH',
        `admin/characters/${characterId}`,
        { avatarDataUrl: 'x'.repeat(3 * 1024 * 1024 + 1) },
        account.cookie,
      )
    ).status,
    413,
  );
  const tooManyPixels = await sharp({
    create: { width: 4001, height: 4000, channels: 3, background: '#abcdef' },
  })
    .png()
    .toBuffer();
  resetLimit();
  assert.equal(
    (
      await call(
        'PATCH',
        `admin/characters/${characterId}`,
        { avatarDataUrl: imageUrl(tooManyPixels) },
        account.cookie,
      )
    ).status,
    400,
  );
  // Large valid forms are accepted only by the character upload endpoints.
  resetLimit();
  const final = await call(
    'PATCH',
    `admin/characters/${characterId}`,
    {
      personality: '角'.repeat(20000),
      greeting: '好'.repeat(4000),
      avatarDataUrl: imageUrl(jpeg, 'jpeg'),
    },
    account.cookie,
  );
  assert.equal(final.status, 200);
  assert.equal(String(final.data.personality).length, 20000);
  const persisted = String(final.data.avatar);
  resetLimit();
  for (let attempt = 0; attempt < 10; attempt++)
    assert.equal(
      (
        await call(
          'PATCH',
          `admin/characters/${characterId}`,
          { avatarDataUrl: 'invalid' },
          account.cookie,
        )
      ).status,
      400,
    );
  assert.equal(
    (
      await call(
        'PATCH',
        `admin/characters/${characterId}`,
        { avatarDataUrl: imageUrl(png) },
        account.cookie,
      )
    ).status,
    429,
  );
  closeDb();
  assert.equal(
    String(
      (getDb().query('SELECT avatar FROM characters WHERE id=?').get(characterId) as Row).avatar,
    ),
    persisted,
  );
  assert.equal((await response('GET', persisted.slice('/api/'.length))).status, 200);
  assert.equal(fileCount(), 2);
  console.log('Character avatar check passed');
} finally {
  closeDb();
}
