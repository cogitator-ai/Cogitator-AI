import { Hono } from 'hono';
import type { HonoEnv } from '../types.js';
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

export function createSwaggerRoutes(config?: SwaggerConfig): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  let cachedSpec: ReturnType<typeof generateOpenAPISpec> | undefined;

  function getSpec(
    ctx: {
      agents: OpenAPIContext['agents'];
      workflows: OpenAPIContext['workflows'];
      swarms: OpenAPIContext['swarms'];
    },
    basePath: string
  ) {
    if (!cachedSpec) {
      const openAPICtx: OpenAPIContext = {
        agents: ctx.agents,
        workflows: ctx.workflows,
        swarms: ctx.swarms,
      };
      cachedSpec = generateOpenAPISpec(openAPICtx, {
        ...config,
        servers: config?.servers ?? [{ url: basePath }],
      });
    }
    return cachedSpec;
  }

  app.get('/openapi.json', (c) => {
    const ctx = c.get('cogitator');
    return c.json(getSpec(ctx, mountPath(c.req.path, '/openapi.json')));
  });

  app.get('/docs', (c) => {
    const ctx = c.get('cogitator');
    return c.html(generateSwaggerHTML(getSpec(ctx, mountPath(c.req.path, '/docs'))));
  });

  return app;
}
