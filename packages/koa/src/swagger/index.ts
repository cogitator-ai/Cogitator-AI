import Router from '@koa/router';
import type { CogitatorState } from '../types.js';
import {
  generateOpenAPISpec,
  generateSwaggerHTML,
  type SwaggerConfig,
  type OpenAPIContext,
} from '@cogitator-ai/server-shared';

/** Where the Cogitator app is mounted, read from the path of a request to one of its own routes. */
function mountPath(requestPath: string, route: '/openapi.json' | '/docs'): string {
  const prefix = requestPath.endsWith(route) ? requestPath.slice(0, -route.length) : '';
  return prefix || '/';
}

export function createSwaggerRoutes(config?: SwaggerConfig): Router<CogitatorState> {
  const router = new Router<CogitatorState>();

  function getSpec(
    routeCtx: {
      agents: OpenAPIContext['agents'];
      workflows: OpenAPIContext['workflows'];
      swarms: OpenAPIContext['swarms'];
    },
    basePath: string
  ) {
    const openAPICtx: OpenAPIContext = {
      agents: routeCtx.agents,
      workflows: routeCtx.workflows,
      swarms: routeCtx.swarms,
    };
    return generateOpenAPISpec(openAPICtx, {
      ...config,
      servers: config?.servers ?? [{ url: basePath }],
    });
  }

  router.get('/openapi.json', (ctx) => {
    const spec = getSpec(ctx.state.cogitator, mountPath(ctx.path, '/openapi.json'));
    ctx.type = 'application/json';
    ctx.body = spec;
  });

  router.get('/docs', (ctx) => {
    const spec = getSpec(ctx.state.cogitator, mountPath(ctx.path, '/docs'));
    ctx.type = 'text/html';
    ctx.body = generateSwaggerHTML(spec);
  });

  return router;
}
