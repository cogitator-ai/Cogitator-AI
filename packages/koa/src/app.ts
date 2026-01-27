import Router from '@koa/router';
import type { CogitatorAppOptions, CogitatorState } from './types.js';
import {
  createContextMiddleware,
  createAuthMiddleware,
  createBodyParser,
  createErrorHandler,
} from './middleware/index.js';
import {
  createHealthRoutes,
  createAgentRoutes,
  createThreadRoutes,
  createToolRoutes,
  createWorkflowRoutes,
  createSwarmRoutes,
} from './routes/index.js';
import { createSwaggerRoutes } from './swagger/index.js';

export function cogitatorApp(opts: CogitatorAppOptions): Router<CogitatorState> {
  const router = new Router<CogitatorState>();

  router.use(createErrorHandler());
  router.use(createBodyParser());
  router.use(createContextMiddleware(opts));

  if (opts.auth) {
    router.use(createAuthMiddleware(opts.auth));
  }

  const subrouters = [
    createHealthRoutes(),
    createAgentRoutes(),
    createThreadRoutes(),
    createToolRoutes(),
    createWorkflowRoutes(),
    createSwarmRoutes(),
  ];

  if (opts.enableSwagger) {
    subrouters.push(createSwaggerRoutes(opts.swagger));
  }

  for (const sub of subrouters) {
    router.use(sub.routes());
    router.use(sub.allowedMethods());
  }

  if (opts.enableWebSocket) {
    console.log(
      '[CogitatorKoa] WebSocket support enabled — call setupWebSocket() with your HTTP server'
    );
  }

  return router;
}
