import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

test('configured compression and periodic memory summaries: models, scopes, locks, cooldown and billing', async () => {
  const child = Bun.spawn(
    [process.execPath, 'run', resolve(import.meta.dir, 'fixtures/maintenance-integration.ts')],
    {
      env: {
        ...process.env,
        DATABASE_PATH: ':memory:',
        ENCRYPTION_KEY: '50'.repeat(32),
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
  if (code !== 0) throw new Error(`Maintenance integration failed:\n${stdout}\n${stderr}`);
  expect(stdout).toContain('MAINTENANCE_INTEGRATION_OK');
}, 30_000);
