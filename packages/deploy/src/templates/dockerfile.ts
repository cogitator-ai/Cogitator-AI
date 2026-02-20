import type { DeployConfig } from '@cogitator-ai/types';

interface DockerfileOptions {
  config: DeployConfig;
  hasTypeScript: boolean;
}

export function generateDockerfile({ config, hasTypeScript }: DockerfileOptions): string {
  const port = config.port ?? 3000;

  if (!hasTypeScript) {
    return `FROM node:20-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
COPY . .
EXPOSE ${port}
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q --spider http://localhost:${port}/health || exit 1
CMD ["node", "src/server.js"]
`;
  }

  return `FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:20-alpine AS runtime
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
EXPOSE ${port}
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q --spider http://localhost:${port}/health || exit 1
CMD ["node", "dist/server.js"]
`;
}
