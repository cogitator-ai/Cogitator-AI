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

  let cachedSpec: ReturnType<typeof generateOpenAPISpec> | undefined;

  function getSpec(routeCtx: {
    agents: OpenAPIContext['agents'];
    workflows: OpenAPIContext['workflows'];
    swarms: OpenAPIContext['swarms'];
  }) {
    if (!cachedSpec) {
      const openAPICtx: OpenAPIContext = {
        agents: routeCtx.agents,
        workflows: routeCtx.workflows,
        swarms: routeCtx.swarms,
      };
      cachedSpec = generateOpenAPISpec(openAPICtx, config ?? {});
    }
    return cachedSpec;
  }

  router.get('/openapi.json', (ctx) => {
    const spec = getSpec(ctx.state.cogitator);
    ctx.type = 'application/json';
    ctx.body = spec;
  });

  router.get('/docs', (ctx) => {
    const spec = getSpec(ctx.state.cogitator);
    ctx.type = 'text/html';
    ctx.body = generateSwaggerHTML(spec);
  });

  return router;
}
