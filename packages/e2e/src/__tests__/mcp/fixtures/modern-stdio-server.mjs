import { serveMCPTools } from '@cogitator-ai/mcp';
import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

const scores = tool({
  name: 'scores',
  description: 'Scores of the last games, newest first.',
  parameters: z.object({}),
  outputSchema: z.array(z.number()),
  execute: async () => [7, 3, 9],
});

const archive = tool({
  name: 'archive_project',
  description: 'Archive a project.',
  parameters: z.object({ project: z.string() }),
  requiresApproval: true,
  execute: async ({ project }) => `archived ${project}`,
});

const paint = tool({
  name: 'paint_wall',
  description: 'Paint the wall in the color the user picks.',
  parameters: z.object({}),
  execute: async (_params, context) => {
    const reply = await context.elicit({
      message: 'Which color?',
      schema: { type: 'object', properties: { color: { type: 'string' } }, required: ['color'] },
    });
    return reply?.action === 'accept' ? `painted ${reply.content.color}` : 'left as it is';
  },
});

await serveMCPTools([scores, archive, paint], {
  name: 'e2e-modern-stdio',
  version: '1.0.0',
  transport: 'stdio',
});
