import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

test('request auditing: every attempt, privacy, tokens, attribution, retention and admin access', async () => {
  const child = Bun.spawn(
    [process.execPath, 'run', resolve(import.meta.dir, 'fixtures/audit-integration.ts')],
    {
      env: {
        ...process.env,
        DATABASE_PATH: ':memory:',
        ENCRYPTION_KEY: '49'.repeat(32),
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
  if (code !== 0) throw new Error(`Audit integration failed:\n${stdout}\n${stderr}`);
  expect(stdout).toContain('AUDIT_INTEGRATION_OK');
}, 30_000);
