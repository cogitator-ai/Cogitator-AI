import { Hono } from 'hono';
import type { HonoEnv, CogitatorAppOptions } from './types.js';
import { createContextMiddleware } from './middleware/context.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createBodyLimitMiddleware } from './middleware/body-limit.js';
import { errorHandler } from './middleware/error-handler.js';
import {
  createHealthRoutes,
  createAgentRoutes,
  createThreadRoutes,
  createToolRoutes,
  createWorkflowRoutes,
  createSwarmRoutes,
} from './routes/index.js';
import { createSwaggerRoutes } from './swagger/index.js';
import { createWebSocketRoutes } from './websocket/handler.js';

export function cogitatorApp(opts: CogitatorAppOptions): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.use('*', createContextMiddleware(opts));
  app.use('*', createBodyLimitMiddleware(opts.bodyLimit));

  if (opts.auth) {
    app.use('*', createAuthMiddleware(opts.auth));
  }

  app.route('/', createHealthRoutes());
  app.route('/', createAgentRoutes());
  app.route('/', createThreadRoutes());
  app.route('/', createToolRoutes());
  app.route('/', createWorkflowRoutes());
  app.route('/', createSwarmRoutes());

  if (opts.enableSwagger) {
    app.route(
      '/',
      createSwaggerRoutes({ ...opts.swagger, auth: opts.swagger?.auth ?? Boolean(opts.auth) })
    );
  }

  if (opts.enableWebSocket) {
    app.route('/', createWebSocketRoutes(opts.websocket));
  }

  app.onError(errorHandler);

  return app;
}
