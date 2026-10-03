import { createMDX } from 'fumadocs-mdx/next';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const monorepoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  outputFileTracingRoot: monorepoRoot,
  turbopack: {
    root: monorepoRoot,
  },
  async rewrites() {
    return [
      { source: '/docs.mdx', destination: '/llms.mdx/docs' },
      { source: '/docs.md', destination: '/llms.mdx/docs' },
      { source: '/docs/:path*.mdx', destination: '/llms.mdx/docs/:path*' },
      { source: '/docs/:path*.md', destination: '/llms.mdx/docs/:path*' },
    ];
  },
};

const withMDX = createMDX();

export default withMDX(nextConfig);
