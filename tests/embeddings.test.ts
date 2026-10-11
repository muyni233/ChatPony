import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { cosineSimilarity, parseEmbeddings } from '../src/lib/ai/embeddings';

test('embedding vectors reject invalid indices, dimensions, zero and nonfinite values', () => {
  expect(
    parseEmbeddings(
      {
        data: [
          { index: 1, embedding: [0, 3] },
          { index: 0, embedding: [4, 0] },
        ],
      },
      2,
    ),
  ).toEqual([
    [1, 0],
    [0, 1],
  ]);
  expect(() => parseEmbeddings({ data: [{ index: 0, embedding: [0, 0] }] }, 1)).toThrow();
  expect(() => parseEmbeddings({ data: [{ index: 0, embedding: [Infinity, 1] }] }, 1)).toThrow();
  expect(() =>
    parseEmbeddings(
      {
        data: [
          { index: 0, embedding: [1, 0] },
          { index: 0, embedding: [0, 1] },
        ],
      },
      2,
    ),
  ).toThrow();
  expect(() =>
    parseEmbeddings(
      {
        data: [
          { index: 0, embedding: [1, 0] },
          { index: 1, embedding: [0, 1, 1] },
        ],
      },
      2,
    ),
  ).toThrow();
  expect(cosineSimilarity([2, 0], [10, 0])).toBe(1);
  expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  expect(cosineSimilarity([1, 0], [1])).toBeNull();
});

test('real HTTP embedding adapters and scoped vector RAG integration', async () => {
  const child = Bun.spawn(
    [process.execPath, 'run', resolve(import.meta.dir, 'fixtures/embeddings-integration.ts')],
    {
      env: {
        ...process.env,
        DATABASE_PATH: ':memory:',
        ENCRYPTION_KEY: '48'.repeat(32),
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
  if (code !== 0) throw new Error(`Embedding integration failed:\n${stdout}\n${stderr}`);
  expect(stdout).toContain('EMBEDDINGS_INTEGRATION_OK');
}, 30_000);
