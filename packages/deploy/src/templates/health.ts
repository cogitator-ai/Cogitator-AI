import type { DeployConfig } from '@cogitator-ai/types';

/** Where the server adapters (express, fastify, hono, koa) answer health checks when mounted at their default `/cogitator` base path. */
export const DEFAULT_HEALTH_PATH = '/cogitator/health';

/** The health check path for `config`, always starting with a slash. */
export function healthPath(config: DeployConfig): string {
  const path = config.health?.path ?? DEFAULT_HEALTH_PATH;
  return path.startsWith('/') ? path : `/${path}`;
}
