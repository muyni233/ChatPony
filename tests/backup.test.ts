import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

test('live SQLite backup includes committed WAL pages and preserves rowids', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'chatpony-backup-'));
  try {
    const child = Bun.spawn(
      [Bun.which('bun') || 'bun', resolve('tests/fixtures/backup-check.ts')],
      { env: { ...process.env, CHATPONY_TEST_DIR: temp }, stdout: 'pipe', stderr: 'pipe' },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Backup check failed:\n${stdout}\n${stderr}`);
    expect(stdout).toContain('Backup check passed');
  } finally {
    const target = resolve(temp);
    if (target.startsWith(resolve(tmpdir()) + sep) && target.includes('chatpony-backup-'))
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 20_000);
