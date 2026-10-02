import Router from '@koa/router';
import type { CogitatorState, ToolListResponse } from '../types.js';

export function createToolRoutes(): Router<CogitatorState> {
  const router = new Router<CogitatorState>();

  router.get('/tools', (ctx) => {
    const { agents } = ctx.state.cogitator;
    const tools = new Map<string, ToolListResponse['tools'][number]>();

    for (const agent of Object.values(agents)) {
      for (const tool of agent.config.tools ?? []) {
        if (tools.has(tool.name)) continue;
        const schema = tool.toJSON();
        tools.set(tool.name, {
          name: schema.name,
          description: schema.description,
          parameters: schema.parameters,
        });
      }
    }

    const response: ToolListResponse = { tools: Array.from(tools.values()) };
    ctx.body = response;
  });

  return router;
}
