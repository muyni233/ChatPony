import { expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';

test('Admin user directory: more than 1000 users, literal search, bounded pagination and access control', async () => {
  const root = resolve('.tmp'),
    folder = join(root, `admin-users-${randomUUID()}`);
  mkdirSync(folder, { recursive: true });
  try {
    const built = await Bun.build({
      entrypoints: ['tests/admin-user-cases.ts'],
      outdir: folder,
      naming: 'admin-users.mjs',
      target: 'node',
      format: 'esm',
      packages: 'external',
    });
    if (!built.success) throw new Error(built.logs.map((log) => log.message).join('\n'));
    const child = Bun.spawn(['node', join(folder, 'admin-users.mjs')], {
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
    if (!folder.startsWith(`${root}${sep}admin-users-`))
      throw new Error('Unexpected admin user fixture directory');
    rmSync(folder, { recursive: true, force: true });
  }
}, 60000);
