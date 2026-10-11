import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

async function runFixture(fixture: string, successMessage: string): Promise<void> {
  // A child process isolates SQLite and environment variables from engine tests.
  const temp = mkdtempSync(join(tmpdir(), 'chatpony-backend-'));
  try {
    const child = Bun.spawn([Bun.which('bun') || 'bun', resolve(`tests/fixtures/${fixture}`)], {
      cwd: resolve('.'),
      env: { ...process.env, CHATPONY_TEST_DIR: temp },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`Backend integration failed:\n${stdout}\n${stderr}`);
    expect(stdout).toContain(successMessage);
  } finally {
    const target = resolve(temp);
    if (target.startsWith(resolve(tmpdir()) + sep) && target.includes('chatpony-backend-'))
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test(
  'backend authentication, authorization, CRUD and quota integration',
  () => runFixture('backend-check.ts', 'Backend integration passed'),
  60_000,
);
test(
  'legacy model migration preserves credentials, IDs and role bindings',
  () => runFixture('migration-check.ts', 'Migration check passed'),
  20_000,
);
test(
  'registration email verification, domain policy and local SMTP integration',
  () => runFixture('mail-check.ts', 'Mail check passed'),
  60_000,
);
test(
  'user persona ownership and sanitized avatar upload integration',
  () => runFixture('account-check.ts', 'Account check passed'),
  60_000,
);
test(
  'supplier protocol and standalone embedding migration preserve existing configurations',
  () => runFixture('supplier-protocol-migration-check.ts', 'Supplier protocol migration passed'),
  20_000,
);
test(
  'maintenance event migration excludes greetings and preserves a monotonic cursor after deletes',
  () => runFixture('maintenance-migration-check.ts', 'Maintenance migration passed'),
  20_000,
);
test(
  'model registry kinds, capabilities, reasoning and reference constraints',
  () => runFixture('model-registry-check.ts', 'Model registry check passed'),
  20_000,
);
test(
  'global quota changes synchronize every account atomically without resetting usage',
  () => runFixture('global-quota-check.ts', 'Global quota check passed'),
  20_000,
);
