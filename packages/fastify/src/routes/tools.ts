import type { FastifyPluginAsync } from 'fastify';
import type { ToolListResponse } from '../types.js';

export const toolRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/tools', async () => {
    const seen = new Set<string>();
    const tools: ToolListResponse['tools'] = [];

    for (const agent of Object.values(fastify.cogitator.agents)) {
      for (const tool of agent.config.tools || []) {
        if (!seen.has(tool.name)) {
          seen.add(tool.name);
          const schema = tool.toJSON();
          tools.push({
            name: schema.name,
            description: schema.description,
            parameters: schema.parameters,
          });
        }
      }
    }

    const response: ToolListResponse = { tools };
    return response;
  });
};
