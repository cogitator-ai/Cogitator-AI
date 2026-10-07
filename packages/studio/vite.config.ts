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
    rollupOptions: {
      onwarn: (warning, warn) => {
        if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning);
      },
      output: {
        manualChunks: (id) => {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
          if (id.includes('lucide-react')) return 'icons';
          return 'markdown';
        },
      },
    },
  },
});
