import type { BunPlugin } from 'bun';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

// Standalone Node fixtures must not depend on Bun's per-test tsconfig discovery.
export const projectAliasPlugin: BunPlugin = {
  name: 'chatpony-source-alias',
  setup(build) {
    build.onResolve({ filter: /^@\// }, ({ path }) => ({
      path: Bun.resolveSync(resolve(sourceRoot, path.slice(2)), sourceRoot),
    }));
  },
};
