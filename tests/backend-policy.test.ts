import { expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';

test('Three-window quotas and registration domains: migrations, switches, resets, reservations and atomic refunds', async () => {
  const root = resolve('.tmp');
  const folder = join(root, `policy-${randomUUID()}`);
  mkdirSync(folder, { recursive: true });
  try {
    const built = await Bun.build({
      entrypoints: ['src/app/api/[...path]/route.ts'],
      tsconfig: resolve('tsconfig.json'),
      outdir: folder,
      naming: 'route.mjs',
      target: 'node',
      format: 'esm',
      packages: 'external',
    });
    if (!built.success) throw new Error(built.logs.map((log) => log.message).join('\n'));
    for (const script of ['backend-policy-smoke', 'backend-quota-migration-smoke']) {
      const process = Bun.spawn(['node', `scripts/${script}.mjs`, join(folder, 'route.mjs')], {
        env: {
          ...Object.fromEntries(
            Object.entries(Bun.env)
              .filter(([, value]) => value !== undefined)
              .map(([key, value]) => [key, String(value)]),
          ),
          DATABASE_PATH: join(folder, `${script}.sqlite`),
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
    }
  } finally {
    if (!folder.startsWith(`${root}${sep}policy-`)) throw new Error('Unexpected test directory');
    rmSync(folder, { recursive: true, force: true });
  }
}, 120000);
