import { expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';

test('Prompt metadata: admin API, ephemeral context injection, budget and shared turn clock', async () => {
  const root = resolve('.tmp'),
    folder = join(root, `prompt-metadata-${randomUUID()}`);
  mkdirSync(folder, { recursive: true });
  try {
    const built = await Bun.build({
      entrypoints: ['tests/prompt-metadata-backend-cases.ts'],
      outdir: folder,
      naming: 'prompt-metadata.mjs',
      target: 'node',
      format: 'esm',
      packages: 'external',
    });
    if (!built.success) throw new Error(built.logs.map((log) => log.message).join('\n'));
    const child = Bun.spawn(['node', join(folder, 'prompt-metadata.mjs')], {
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
    if (!folder.startsWith(`${root}${sep}prompt-metadata-`))
      throw new Error('Unexpected prompt metadata fixture directory');
    rmSync(folder, { recursive: true, force: true });
  }
}, 60000);
