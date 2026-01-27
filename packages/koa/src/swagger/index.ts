import Router from '@koa/router';
import type { CogitatorState } from '../types.js';
import {
  generateOpenAPISpec,
  generateSwaggerHTML,
  type SwaggerConfig,
  type OpenAPIContext,
} from '@cogitator-ai/server-shared';

export function createSwaggerRoutes(config?: SwaggerConfig): Router<CogitatorState> {
  const router = new Router<CogitatorState>();

  router.get('/openapi.json', (ctx) => {
    const routeCtx = ctx.state.cogitator;
    const openAPICtx: OpenAPIContext = {
      agents: routeCtx.agents,
      workflows: routeCtx.workflows,
      swarms: routeCtx.swarms,
    };
    const spec = generateOpenAPISpec(openAPICtx, config ?? {});
    ctx.type = 'application/json';
    ctx.body = spec;
  });

  router.get('/docs', (ctx) => {
    const routeCtx = ctx.state.cogitator;
    const openAPICtx: OpenAPIContext = {
      agents: routeCtx.agents,
      workflows: routeCtx.workflows,
      swarms: routeCtx.swarms,
    };
    const spec = generateOpenAPISpec(openAPICtx, config ?? {});
    ctx.type = 'text/html';
    ctx.body = generateSwaggerHTML(spec);
  });

  return router;
}
