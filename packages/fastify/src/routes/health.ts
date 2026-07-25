import type { FastifyPluginAsync } from 'fastify';
import type { HealthResponse } from '../types.js';

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  const startTime = Date.now();

  fastify.get('/health', async () => {
    const response: HealthResponse = {
      status: 'ok',
      uptime: Date.now() - startTime,
      timestamp: Date.now(),
    };
    return response;
  });

  fastify.get('/ready', async () => {
    return { status: 'ok' };
  });
};
