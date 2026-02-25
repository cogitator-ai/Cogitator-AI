import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyError } from 'fastify';
import type { CogitatorPluginOptions, CogitatorContext } from './types.js';
import { createAuthHook, errorHandler } from './hooks/index.js';
import {
  healthRoutes,
  agentRoutes,
  threadRoutes,
  toolRoutes,
  workflowRoutes,
  swarmRoutes,
} from './routes/index.js';

const cogitatorPluginImpl: FastifyPluginAsync<CogitatorPluginOptions> = async (fastify, opts) => {
  const context: CogitatorContext = {
    runtime: opts.cogitator,
    agents: opts.agents ?? {},
    workflows: opts.workflows ?? {},
    swarms: opts.swarms ?? {},
  };

  fastify.decorate('cogitator', context);

  fastify.decorateRequest('cogitatorAuth', undefined);
  fastify.decorateRequest('cogitatorRequestId', '');
  fastify.decorateRequest('cogitatorStartTime', 0);

  fastify.addHook('onRequest', createAuthHook(opts.auth));

  if (opts.rateLimit) {
    try {
      const rateLimitModule = await import('@fastify/rate-limit');
      await fastify.register(rateLimitModule.default, {
        max: opts.rateLimit.max,
        timeWindow: opts.rateLimit.timeWindow,
        keyGenerator: opts.rateLimit.keyGenerator,
        errorResponseBuilder: opts.rateLimit.errorResponseBuilder,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
        fastify.log.warn('@fastify/rate-limit not installed, skipping rate limiting');
      } else {
        throw err;
      }
    }
  }

  const prefix = opts.prefix ?? '/cogitator';

  await fastify.register(
    async (instance) => {
      if (opts.enableSwagger) {
        try {
          const swaggerModule = await import('@fastify/swagger');
          const swaggerUiModule = await import('@fastify/swagger-ui');

          await instance.register(swaggerModule.default, {
            openapi: {
              info: {
                title: opts.swagger?.title ?? 'Cogitator API',
                description: opts.swagger?.description ?? 'AI Agent Runtime API',
                version: opts.swagger?.version ?? '1.0.0',
                contact: opts.swagger?.contact,
                license: opts.swagger?.license,
              },
              servers: opts.swagger?.servers ?? [{ url: '/', description: 'Current server' }],
              tags: [
                { name: 'agents', description: 'Agent operations' },
                { name: 'threads', description: 'Thread/memory operations' },
                { name: 'tools', description: 'Tool operations' },
                { name: 'workflows', description: 'Workflow operations' },
                { name: 'swarms', description: 'Swarm operations' },
                { name: 'health', description: 'Health check endpoints' },
              ],
            },
          });

          await instance.register(swaggerUiModule.default, {
            routePrefix: '/docs',
          });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
            fastify.log.warn('@fastify/swagger not installed, skipping Swagger UI');
          } else {
            throw err;
          }
        }
      }

      await instance.register(healthRoutes);
      await instance.register(agentRoutes);
      await instance.register(threadRoutes);
      await instance.register(toolRoutes);
      await instance.register(workflowRoutes);
      await instance.register(swarmRoutes);

      if (opts.enableWebSocket) {
        try {
          const websocketModule = await import('@fastify/websocket');
          await instance.register(websocketModule.default);

          const { websocketRoutes } = await import('./websocket/handler.js');
          await instance.register(websocketRoutes, { path: opts.websocket?.path });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
            fastify.log.warn('@fastify/websocket not installed, skipping WebSocket support');
          } else {
            throw err;
          }
        }
      }
    },
    { prefix }
  );

  fastify.setErrorHandler((error: FastifyError, request, reply) => {
    errorHandler(error, request, reply);
  });
};

export const cogitatorPlugin = fp(cogitatorPluginImpl, {
  fastify: '5.x',
  name: '@cogitator-ai/fastify',
});
