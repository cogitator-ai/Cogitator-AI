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
  },
  esbuild: {
    target: 'node20',
  },
});
