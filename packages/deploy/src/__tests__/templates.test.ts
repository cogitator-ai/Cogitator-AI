import { describe, it, expect } from 'vitest';
import { generateDockerfile } from '../templates/dockerfile';
import { generateDockerCompose, imageTag } from '../templates/docker-compose';
import { generateFlyToml, parseMemoryMb } from '../templates/fly-toml';

describe('generateDockerfile', () => {
  it('probes health on the IPv4 loopback, which servers bound to 0.0.0.0 answer', () => {
    const df = generateDockerfile({
      config: { port: 3000, health: { path: '/api/health' } },
      hasTypeScript: false,
      hasBuildScript: false,
    });

    expect(df).toContain('wget -q --spider http://127.0.0.1:3000/api/health');
    expect(df).not.toContain('localhost');
  });

  it('uses npm ci when a package-lock exists', () => {
    const df = generateDockerfile({
      config: { port: 3000 },
      hasTypeScript: true,
      packageManager: 'npm',
      hasLockfile: true,
      startCommand: ['npm', 'start'],
    });
    expect(df).toContain('target=/root/.npm npm ci');
    expect(df).toContain('RUN npm run build');
    expect(df).toContain('CMD ["npm","start"]');
    expect(df).not.toContain('pnpm');
  });

  it('does not use --frozen-lockfile without a lockfile', () => {
    const df = generateDockerfile({
      config: {},
      hasTypeScript: false,
      packageManager: 'pnpm',
      hasLockfile: false,
    });
    expect(df).not.toContain('--frozen-lockfile');
    expect(df).toContain('pnpm install --prod');
  });

  it('skips the build step when there is no build script', () => {
    const df = generateDockerfile({ config: {}, hasTypeScript: true, hasBuildScript: false });
    expect(df).not.toContain('run build');
  });

  it('copies the full builder output so non-dist start commands work', () => {
    const df = generateDockerfile({ config: {}, hasTypeScript: true });
    expect(df).toContain('COPY --from=builder --chown=node:node /app ./');
  });

  it('drops the dev dependencies of the build before the runtime copies it', () => {
    const pnpm = generateDockerfile({ config: {}, hasTypeScript: true, packageManager: 'pnpm' });
    expect(pnpm.indexOf('pnpm prune --prod')).toBeGreaterThan(pnpm.indexOf('RUN pnpm run build'));
    expect(pnpm.indexOf('pnpm prune --prod')).toBeLessThan(pnpm.indexOf('FROM base AS runtime'));

    const npm = generateDockerfile({ config: {}, hasTypeScript: true, packageManager: 'npm' });
    expect(npm).toContain('npm prune --omit=dev');
  });

  it('runs as the unprivileged user of the image under tini', () => {
    const node = generateDockerfile({
      config: {},
      hasTypeScript: true,
      startCommand: ['node', 'dist/index.js'],
    });
    expect(node).toContain('USER node');
    expect(node).toContain('ENTRYPOINT ["/sbin/tini", "--"]');
    expect(node).toContain('CMD ["node","dist/index.js"]');
    expect(node.indexOf('USER node')).toBeGreaterThan(node.indexOf('FROM base AS runtime'));

    const bun = generateDockerfile({ config: {}, hasTypeScript: true, packageManager: 'bun' });
    expect(bun).toContain('FROM oven/bun:1-alpine AS base');
    expect(bun).toContain('USER bun');
  });

  it('runs a Node app managed by Bun on Node, with Bun and node-gyp for native builds', () => {
    const dockerfile = generateDockerfile({
      config: { port: 3000 },
      hasTypeScript: true,
      packageManager: 'bun',
      hasLockfile: true,
      startCommand: ['node', 'dist/index.js'],
    });
    expect(dockerfile).toContain('FROM node:24-alpine AS base');
    expect(dockerfile).toContain(
      'COPY --from=oven/bun:1-alpine /usr/local/bin/bun /usr/local/bin/bun'
    );
    expect(dockerfile).toContain('npm install -g node-gyp');
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('CMD ["node","dist/index.js"]');
    expect(dockerfile).not.toContain('--ignore-scripts');
  });

  it('keeps the package manager cache between builds', () => {
    const df = generateDockerfile({ config: {}, hasTypeScript: true, packageManager: 'pnpm' });
    expect(df.startsWith('# syntax=docker/dockerfile:1\n')).toBe(true);
    expect(df).toContain(
      'RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile'
    );
  });

  it('installs only production dependencies for a JavaScript project', () => {
    const df = generateDockerfile({ config: {}, hasTypeScript: false, packageManager: 'npm' });
    expect(df).toContain('npm ci --omit=dev');
    expect(df).not.toContain('AS builder');
    expect(df).toContain('COPY --chown=node:node . .');
  });

  it('honours health check settings', () => {
    const df = generateDockerfile({
      config: { port: 8080, health: { path: 'ready', interval: '10s', timeout: '2s' } },
      hasTypeScript: false,
    });
    expect(df).toContain('--interval=10s --timeout=2s');
    expect(df).toContain('http://127.0.0.1:8080/ready');
  });

  it('checks the health route the server adapters serve by default', () => {
    const df = generateDockerfile({ config: { port: 3000 }, hasTypeScript: false });
    expect(df).toContain('http://127.0.0.1:3000/cogitator/health');
  });
});

describe('generateDockerCompose', () => {
  it('builds from the project root and tags the image', () => {
    const compose = generateDockerCompose({ image: 'bot', registry: 'ghcr.io/acme/' });
    expect(compose).toContain('context: ..');
    expect(compose).toContain('dockerfile: .cogitator/Dockerfile');
    expect(compose).toContain('image: "ghcr.io/acme/bot:latest"');
  });

  it('passes secrets through from the host environment and escapes env values', () => {
    const compose = generateDockerCompose({
      secrets: ['OPENAI_API_KEY'],
      env: { GREETING: 'cost $5' },
    });
    expect(compose).toContain('OPENAI_API_KEY: ${OPENAI_API_KEY:-}');
    expect(compose).toContain('GREETING: "cost $$5"');
  });

  it('wires redis and postgres with health-gated dependencies', () => {
    const compose = generateDockerCompose({ services: { redis: true, postgres: true } });
    expect(compose).toContain('REDIS_URL: "redis://redis:6379"');
    expect(compose).toContain('condition: service_healthy');
    expect(compose).toContain('postgres-data:');
  });

  it('writes each environment key once, letting env and secrets override service URLs', () => {
    const compose = generateDockerCompose({
      services: { redis: true, postgres: true },
      env: { REDIS_URL: 'redis://cache.internal:6379', PORT: '3000' },
      secrets: ['DATABASE_URL', 'REDIS_URL'],
    });
    const appEnvironment = compose.split('    environment:\n')[1].split('    restart:')[0];
    const keys = [...appEnvironment.matchAll(/^ {6}([A-Z_]+):/gm)].map((m) => m[1]);
    expect(keys).toEqual(['NODE_ENV', 'PORT', 'REDIS_URL', 'DATABASE_URL']);
    expect(compose).toContain('REDIS_URL: "redis://cache.internal:6379"');
    expect(compose).toContain(
      'DATABASE_URL: ${DATABASE_URL:-postgresql://cogitator:cogitator@postgres:5432/cogitator}'
    );
  });
});

describe('imageTag', () => {
  it('defaults to cogitator-app', () => {
    expect(imageTag({})).toBe('cogitator-app:latest');
  });
});

describe('generateFlyToml', () => {
  it('renders env, health path and instance count', () => {
    const toml = generateFlyToml({
      image: 'bot',
      port: 3000,
      instances: 2,
      env: { LOG_LEVEL: 'debug' },
      health: { path: '/healthz' },
    });
    expect(toml).toContain('[env]');
    expect(toml).toContain('LOG_LEVEL = "debug"');
    expect(toml).toContain('min_machines_running = 2');
    expect(toml).toContain('path = "/healthz"');
  });

  it('checks the health route the server adapters serve by default', () => {
    expect(generateFlyToml({})).toContain('path = "/cogitator/health"');
  });

  it('parses memory sizes', () => {
    expect(parseMemoryMb('1gb')).toBe(1024);
    expect(parseMemoryMb('2G')).toBe(2048);
    expect(parseMemoryMb('512mb')).toBe(512);
    expect(parseMemoryMb('weird')).toBe(256);
  });
});
