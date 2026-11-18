import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['**/node_modules/**', '**/dist/**'],
    },
    testTimeout: 30000,
    dangerouslyIgnoreUnhandledErrors: true,
    server: {
      deps: {
        /**
         * Workspace packages resolve to packages/<name>/dist, outside node_modules, so vitest
         * would run every built file through its own module runner. Node loads them much faster.
         */
        external: [/\/packages\/[^/]+\/dist\//],
      },
    },
  },
  esbuild: {
    target: 'node20',
  },
});
