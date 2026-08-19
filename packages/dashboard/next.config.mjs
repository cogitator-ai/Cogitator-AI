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
  serverExternalPackages: [
    'dockerode',
    'ssh2',
    '@extism/extism',
    'langfuse',
    'mongodb',
    'nodemailer',
    'isolated-vm',
    '@aws-sdk/client-bedrock-runtime',
    '@qdrant/js-client-rest',
    'better-sqlite3',
  ],
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  transpilePackages: [
    '@cogitator-ai/config',
    '@cogitator-ai/core',
    '@cogitator-ai/mcp',
    '@cogitator-ai/memory',
    '@cogitator-ai/models',
    '@cogitator-ai/openai-compat',
    '@cogitator-ai/redis',
    '@cogitator-ai/sandbox',
    '@cogitator-ai/swarms',
    '@cogitator-ai/types',
    '@cogitator-ai/workflows',
  ],
};

const withMDX = createMDX();

export default withMDX(nextConfig);
