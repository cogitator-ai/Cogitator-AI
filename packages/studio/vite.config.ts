import { defineConfig, type Plugin } from 'vite';

/**
 * KaTeX's stylesheet lists every font as woff2, woff and ttf. Browsers the
 * studio supports all load woff2, so the other two are left out of the bundle.
 */
function katexWoff2Only(): Plugin {
  return {
    name: 'katex-woff2-only',
    enforce: 'pre',
    transform(code, id) {
      if (!/katex(\.min)?\.css$/.test(id)) return undefined;
      return code.replace(/,\s*url\([^)]*\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g, '');
    },
  };
}

export default defineConfig({
  root: 'src/ui',
  base: './',
  esbuild: { jsx: 'automatic' },
  plugins: [katexWoff2Only()],
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
          if (/[\\/]katex[\\/]/.test(id)) return 'math';
          return 'markdown';
        },
      },
    },
  },
});
