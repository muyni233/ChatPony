import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

test('RP engine integration: persistence, quota, loops, locks, replay, cancellation and compression', async () => {
  const child = Bun.spawn(
    [process.execPath, 'run', resolve(import.meta.dir, 'fixtures/chat-integration.ts')],
    {
      env: {
        ...process.env,
        DATABASE_PATH: ':memory:',
        ENCRYPTION_KEY: '47'.repeat(32),
        NODE_ENV: 'test',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`Chat integration failed:\n${stdout}\n${stderr}`);
  expect(stdout).toContain('CHAT_INTEGRATION_OK');
}, 30_000);
