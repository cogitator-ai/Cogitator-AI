import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: join(tmpdir(), 'cogitator-evals-describe-eval-vite'),
  test: {
    root: import.meta.dirname,
    include: ['*.eval.ts'],
    pool: 'threads',
    maxWorkers: 1,
  },
});
