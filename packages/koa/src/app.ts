import Router from '@koa/router';
import type { CogitatorAppOptions, CogitatorState } from './types.js';
import {
  createContextMiddleware,
  createAnonymousMiddleware,
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
import { forRoutes, routeUnmatched } from './middleware/unmatched.js';

/**
 * The Cogitator API as a Koa router. A request no route serves passes on to the middleware
 * after the router, and what is left unanswered gets `404 NOT_FOUND` in the error envelope, or
 * `401 UNAUTHORIZED` for an anonymous caller under `anonymous: 'deny'`.
 *
 * @throws Error when `opts.limits` holds a limit that is not a positive integer
 */
export function cogitatorApp(opts: CogitatorAppOptions): Router<CogitatorState> {
  const router = new Router<CogitatorState>();
  const errorHandler = createErrorHandler();
  const context = createContextMiddleware(opts);
  const authenticate = opts.auth ? [createAuthMiddleware(opts.auth)] : [];
  const anonymous = createAnonymousMiddleware(opts.anonymous);

  router.use(forRoutes(errorHandler));
  router.use(forRoutes(createBodyParser({ limit: opts.bodyLimit })));
  router.use(forRoutes(context));
  for (const middleware of authenticate) router.use(forRoutes(middleware));

  const publicRouters = [createHealthRoutes()];
  if (opts.enableSwagger) {
    publicRouters.push(
      createSwaggerRoutes({
        ...opts.swagger,
        auth: opts.swagger?.auth ?? Boolean(opts.auth),
        ...(opts.limits && { limits: opts.limits }),
        ...(opts.resumableStreams && { resumableStreams: true }),
      })
    );
  }

  const apiRouters = [
    createAgentRoutes(),
    createThreadRoutes(),
    createToolRoutes(),
    createWorkflowRoutes(),
    createSwarmRoutes(),
  ];

  for (const sub of publicRouters) router.use(sub.routes());
  router.use(forRoutes(anonymous));
  for (const sub of apiRouters) router.use(sub.routes());

  routeUnmatched(router, [errorHandler, context, ...authenticate, anonymous]);

  return router;
}
