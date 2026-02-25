import { Hono } from 'hono';
import type { HonoEnv } from '../types.js';
import {
  generateOpenAPISpec,
  generateSwaggerHTML,
  type SwaggerConfig,
  type OpenAPIContext,
} from '@cogitator-ai/server-shared';

export function createSwaggerRoutes(config?: SwaggerConfig): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  let cachedSpec: ReturnType<typeof generateOpenAPISpec> | undefined;

  function getSpec(ctx: {
    agents: OpenAPIContext['agents'];
    workflows: OpenAPIContext['workflows'];
    swarms: OpenAPIContext['swarms'];
  }) {
    if (!cachedSpec) {
      const openAPICtx: OpenAPIContext = {
        agents: ctx.agents,
        workflows: ctx.workflows,
        swarms: ctx.swarms,
      };
      cachedSpec = generateOpenAPISpec(openAPICtx, config ?? {});
    }
    return cachedSpec;
  }

  app.get('/openapi.json', (c) => {
    const ctx = c.get('cogitator');
    return c.json(getSpec(ctx));
  });

  app.get('/docs', (c) => {
    const ctx = c.get('cogitator');
    return c.html(generateSwaggerHTML(getSpec(ctx)));
  });

  return app;
}
