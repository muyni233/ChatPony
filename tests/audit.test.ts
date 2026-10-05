import { expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { projectAliasPlugin } from './fixture-build';

test('Node 24 audit metadata and statistics use an isolated SQLite database', async () => {
  const root = resolve('.tmp');
  const folder = join(root, `audit-${randomUUID()}`);
  mkdirSync(folder, { recursive: true });
  try {
    const built = await Bun.build({
      entrypoints: ['tests/audit-cases.ts'],
      tsconfig: resolve('tsconfig.json'),
      outdir: folder,
      naming: 'audit.mjs',
      target: 'node',
      format: 'esm',
      external: ['nodemailer', 'lunar-javascript'],
      plugins: [projectAliasPlugin],
    });
    if (!built.success) throw new Error(built.logs.map((log) => log.message).join('\n'));
    const child = Bun.spawn(['node', join(folder, 'audit.mjs')], {
      env: { ...process.env, DATABASE_PATH: join(folder, 'test.sqlite'), NODE_ENV: 'test' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${output}\n${errors}`);
    expect(output).toContain('assertions passed');
    console.log(output.trim());
  } finally {
    // Only this newly-created audit fixture is removed; never application or QA data.
    if (!resolve(folder).startsWith(`${root}${sep}audit-`))
      throw new Error('Unexpected audit fixture directory');
    rmSync(folder, { recursive: true, force: true });
  }
}, 60000);
