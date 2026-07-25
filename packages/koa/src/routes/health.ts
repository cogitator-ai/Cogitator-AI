import Router from '@koa/router';
import type { CogitatorState, HealthResponse } from '../types.js';

export function createHealthRoutes(): Router<CogitatorState> {
  const router = new Router<CogitatorState>();

  router.get('/health', (ctx) => {
    const response: HealthResponse = {
      status: 'ok',
      uptime: Math.round(process.uptime() * 1000),
      timestamp: Date.now(),
    };
    ctx.body = response;
  });

  router.get('/ready', (ctx) => {
    ctx.body = { status: 'ok' };
  });

  return router;
}
