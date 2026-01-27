import { Hono } from 'hono';
import type { HonoEnv, HealthResponse } from '../types.js';

const startTime = Date.now();

export function createHealthRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.get('/health', (c) => {
    const response: HealthResponse = {
      status: 'ok',
      uptime: Date.now() - startTime,
      timestamp: Date.now(),
    };
    return c.json(response);
  });

  app.get('/ready', (c) => {
    return c.json({ status: 'ok' });
  });

  return app;
}
