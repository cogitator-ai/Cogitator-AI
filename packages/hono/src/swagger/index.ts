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

  app.get('/openapi.json', (c) => {
    const ctx = c.get('cogitator');
    const openAPICtx: OpenAPIContext = {
      agents: ctx.agents,
      workflows: ctx.workflows,
      swarms: ctx.swarms,
    };
    const spec = generateOpenAPISpec(openAPICtx, config ?? {});
    return c.json(spec);
  });

  app.get('/docs', (c) => {
    const ctx = c.get('cogitator');
    const openAPICtx: OpenAPIContext = {
      agents: ctx.agents,
      workflows: ctx.workflows,
      swarms: ctx.swarms,
    };
    const spec = generateOpenAPISpec(openAPICtx, config ?? {});
    return c.html(generateSwaggerHTML(spec));
  });

  return app;
}
