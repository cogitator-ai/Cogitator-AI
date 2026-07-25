import { Router } from 'express';
import type { RouteContext, ToolListResponse } from '../types.js';

export function createToolRoutes(ctx: RouteContext): Router {
  const router = Router();

  router.get('/tools', (_req, res) => {
    const toolsSet = new Map<string, { name: string; description?: string; parameters: unknown }>();

    for (const agent of Object.values(ctx.agents)) {
      const tools = agent.config.tools || [];
      for (const tool of tools) {
        if (!toolsSet.has(tool.name)) {
          const schema = tool.toJSON();
          toolsSet.set(tool.name, {
            name: schema.name,
            description: schema.description,
            parameters: schema.parameters,
          });
        }
      }
    }

    const response: ToolListResponse = {
      tools: Array.from(toolsSet.values()).map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
      })),
    };

    res.json(response);
  });

  return router;
}
