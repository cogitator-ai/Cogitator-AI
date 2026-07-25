import { Router } from 'express';
import type { RouteContext, HealthResponse } from '../types.js';

export function createHealthRoutes(_ctx: RouteContext, startTime: number = Date.now()): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    const response: HealthResponse = {
      status: 'ok',
      uptime: Date.now() - startTime,
      timestamp: Date.now(),
    };
    res.json(response);
  });

  router.get('/ready', (_req, res) => {
    res.json({ status: 'ok' });
  });

  return router;
}
