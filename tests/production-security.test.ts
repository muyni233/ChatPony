import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

function isolatedDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'chatpony-production-security-'));
}

function removeFixture(directory: string): void {
  const target = resolve(directory);
  if (
    !target.startsWith(resolve(tmpdir()) + sep) ||
    !target.includes('chatpony-production-security-')
  )
    throw new Error('Refusing to remove a non-fixture directory');
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function runFixture(
  file: string,
  directory: string,
  mode: string,
  environment: Record<string, string> = {},
): Promise<string> {
  const child = Bun.spawn([Bun.which('bun') || 'bun', resolve(`tests/fixtures/${file}`), mode], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ENCRYPTION_KEY: '',
      DATABASE_PATH: join(directory, 'isolated.db'),
      CHATPONY_TEST_DIR: directory,
      ...environment,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(`Production regression fixture failed (${mode}):\n${stdout}\n${stderr}`);
  return stdout;
}

test('development credentials survive production edits and a fresh process restart', async () => {
  const directory = isolatedDirectory();
  try {
    expect(
      await runFixture('production-crypto-check.ts', directory, 'create', {
        NODE_ENV: 'development',
      }),
    ).toContain('Crypto create passed');
    expect(await runFixture('production-crypto-check.ts', directory, 'update')).toContain(
      'Crypto update passed',
    );
    expect(await runFixture('production-crypto-check.ts', directory, 'restart')).toContain(
      'Crypto restart passed',
    );
  } finally {
    removeFixture(directory);
  }
}, 20_000);

test('simultaneous production first-use processes publish one complete persistent key', async () => {
  const directory = isolatedDirectory();
  try {
    const shared = join(directory, 'shared');
    mkdirSync(shared);
    const barrier = String(Date.now() + 1500);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        runFixture('production-crypto-check.ts', shared, 'concurrent', {
          CHATPONY_CRYPTO_WORKER: String(index),
          CHATPONY_CRYPTO_BARRIER: barrier,
        }),
      ),
    );
    expect(results.every((result) => result.includes('Concurrent crypto worker passed'))).toBe(
      true,
    );
    expect(await runFixture('production-crypto-check.ts', shared, 'verify-concurrent')).toContain(
      'Concurrent crypto verification passed',
    );
  } finally {
    removeFixture(directory);
  }
}, 20_000);

test('damaged persistent keys and invalid environment formats fail safely without replacement', async () => {
  const directory = isolatedDirectory();
  try {
    expect(await runFixture('production-crypto-check.ts', directory, 'invalid')).toContain(
      'Crypto invalid-key checks passed',
    );
  } finally {
    removeFixture(directory);
  }
}, 20_000);

test('production auth cookie transport rules and sessions survive process restarts', async () => {
  const directory = isolatedDirectory();
  try {
    expect(await runFixture('production-auth-check.ts', directory, 'create')).toContain(
      'Production auth create passed',
    );
    expect(await runFixture('production-auth-check.ts', directory, 'restart')).toContain(
      'Production auth restart passed',
    );
  } finally {
    removeFixture(directory);
  }
}, 30_000);
