import { defineConfig } from 'tsup';
import { scaffolderDefines } from './scripts/defines.ts';

const define = scaffolderDefines();

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: false,
    clean: true,
    sourcemap: true,
    define,
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  {
    entry: ['src/lib.ts'],
    format: ['esm'],
    dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
    sourcemap: true,
    define,
  },
]);
