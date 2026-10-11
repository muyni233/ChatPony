import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

test('character forms atomically save sanitized avatars and retain account upload isolation', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'chatpony-character-avatar-'));
  try {
    const child = Bun.spawn(
      [Bun.which('bun') || 'bun', resolve('tests/fixtures/character-avatar-check.ts')],
      {
        cwd: resolve('.'),
        env: { ...process.env, CHATPONY_TEST_DIR: temp },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (status !== 0) throw new Error(`Character avatar integration failed:\n${stdout}\n${stderr}`);
    expect(stdout).toContain('Character avatar check passed');
  } finally {
    const target = resolve(temp);
    if (target.startsWith(resolve(tmpdir()) + sep) && target.includes('chatpony-character-avatar-'))
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 60_000);
