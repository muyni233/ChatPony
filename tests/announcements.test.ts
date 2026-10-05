import { expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { projectAliasPlugin } from './fixture-build';

test('Announcements: permissions, draft visibility, per-user versioned reads and conflicting updates', async () => {
  const root = resolve('.tmp');
  const folder = join(root, `announcements-${randomUUID()}`);
  mkdirSync(folder, { recursive: true });
  try {
    const build = await Bun.build({
      entrypoints: ['tests/announcement-cases.ts'],
      tsconfig: resolve('tsconfig.json'),
      outdir: folder,
      naming: 'announcements.mjs',
      target: 'node',
      format: 'esm',
      external: ['nodemailer', 'lunar-javascript'],
      plugins: [projectAliasPlugin],
    });
    if (!build.success) throw new Error(build.logs.map((log) => log.message).join('\n'));
    const child = Bun.spawn(['node', join(folder, 'announcements.mjs')], {
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
    if (!resolve(folder).startsWith(`${root}${sep}announcements-`))
      throw new Error('Unexpected announcements fixture directory');
    rmSync(folder, { recursive: true, force: true });
  }
}, 60000);
