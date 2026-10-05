import { expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { projectAliasPlugin } from './fixture-build';

test('Node 24 backend integration: bootstrap, permissions, memory, encrypted providers and atomic SSE turns', async () => {
  const root = resolve('.tmp');
  const folder = join(root, `backend-${randomUUID()}`);
  mkdirSync(folder, { recursive: true });
  try {
    const built = await Bun.build({
      entrypoints: ['src/app/api/[...path]/route.ts'],
      tsconfig: resolve('tsconfig.json'),
      outdir: folder,
      naming: 'route.mjs',
      target: 'node',
      format: 'esm',
      external: ['nodemailer', 'lunar-javascript'],
      plugins: [projectAliasPlugin],
    });
    if (!built.success) throw new Error(built.logs.map((log) => log.message).join('\n'));
    const process = Bun.spawn(['node', 'scripts/backend-smoke.mjs', join(folder, 'route.mjs')], {
      env: {
        ...Object.fromEntries(
          Object.entries(Bun.env)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, String(value)]),
        ),
        DATABASE_PATH: join(folder, 'test.sqlite'),
        NODE_ENV: 'development',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [output, errors, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (code !== 0) throw new Error(`${output}\n${errors}`);
    expect(output).toContain('assertions passed');
    console.log(output.trim());
  } finally {
    // Only delete this test's newly-created isolated workspace directory.
    if (!folder.startsWith(`${root}${sep}backend-`)) throw new Error('Unexpected test directory');
    rmSync(folder, { recursive: true, force: true });
  }
}, 120000);
