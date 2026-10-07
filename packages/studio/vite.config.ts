import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/ui',
  base: './',
  esbuild: { jsx: 'automatic' },
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
});
