import { defineConfig } from 'vitest/config';
import { scaffolderDefines } from './scripts/defines.ts';

export default defineConfig({
  define: scaffolderDefines(),
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 10000,
  },
});
