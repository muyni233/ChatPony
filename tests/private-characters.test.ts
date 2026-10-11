import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

test('private characters enforce owner access, atomic slots, avatar lifecycle and legacy compatibility', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'chatpony-private-roles-'));
  try {
    const child = Bun.spawn(
      [Bun.which('bun') || 'bun', resolve('tests/fixtures/private-characters-check.ts')],
      {
        cwd: resolve('.'),
        env: { ...process.env, CHATPONY_TEST_DIR: temp },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Private character integration failed:\n${stdout}\n${stderr}`);
    expect(stdout).toContain('Private character check passed');
  } finally {
    const target = resolve(temp);
    if (target.startsWith(resolve(tmpdir()) + sep) && target.includes('chatpony-private-roles-'))
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 60_000);
