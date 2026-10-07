import type { DeployConfig, DeployServer } from '@cogitator-ai/types';

/** Where the server adapters (express, fastify, hono, koa) answer health checks when mounted at their default `/cogitator` base path. */
export const DEFAULT_HEALTH_PATH = '/cogitator/health';

const SERVER_HEALTH_PATHS: Partial<Record<DeployServer, string>> = {
  express: DEFAULT_HEALTH_PATH,
  fastify: DEFAULT_HEALTH_PATH,
  hono: DEFAULT_HEALTH_PATH,
  koa: DEFAULT_HEALTH_PATH,
  tetsu: '/health',
};

/**
 * The health check path of `config`, always starting with a slash:
 * `health.path`, else the path the detected server adapter answers on. A
 * worker has none, and neither has a server whose path is unknown (a Next.js
 * app, a plain HTTP framework), which then gets no health check.
 */
export function healthPath(config: DeployConfig): string | undefined {
  if ((config.kind ?? 'server') === 'worker') return undefined;
  const path =
    config.health?.path ??
    (config.server ? SERVER_HEALTH_PATHS[config.server] : undefined) ??
    (config.kind === undefined ? DEFAULT_HEALTH_PATH : undefined);
  if (!path) return undefined;
  return path.startsWith('/') ? path : `/${path}`;
}

/** Whether the deployment answers HTTP: every server, and a worker that sets a port. */
export function servesHttp(config: DeployConfig): boolean {
  return (config.kind ?? 'server') === 'server' || config.port !== undefined;
}
