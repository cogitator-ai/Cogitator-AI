import type { RouteContext } from '../types.js';
import {
  generateOpenAPISpec as generateSpec,
  type SwaggerConfig,
  type OpenAPISpec,
} from '@cogitator-ai/server-shared';

export function generateOpenAPISpec(ctx: RouteContext, config: SwaggerConfig): OpenAPISpec {
  return generateSpec(
    {
      agents: ctx.agents,
      workflows: ctx.workflows,
      swarms: ctx.swarms,
    },
    config
  );
}
