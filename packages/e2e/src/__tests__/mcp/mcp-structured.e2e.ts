import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tool, type Cogitator } from '@cogitator-ai/core';
import { MCPClient, MCPServer } from '@cogitator-ai/mcp';
import type { RunResult, Tool } from '@cogitator-ai/types';
import { createTestAgent, createTestCogitator, ollamaSkipReason } from '../../helpers/setup';

const describeE2E = describe.skipIf((await ollamaSkipReason()) !== null);

describeE2E('structured results of an MCP tool reach the model (Ollama)', () => {
  let client: MCPClient;
  let server: MCPServer;
  let cog: Cogitator;
  const asked: string[] = [];

  beforeAll(async () => {
    const teamScores = tool({
      name: 'team_scores',
      description: 'The scores of the last games of a team, newest first.',
      parameters: z.object({ team: z.string().describe('Team name, e.g. "Hawks"') }),
      outputSchema: z.array(z.object({ game: z.number(), points: z.number() })),
      execute: async ({ team }) => {
        asked.push(team);
        return [
          { game: 3, points: 71 },
          { game: 2, points: 64 },
        ];
      },
    }) as Tool;
    server = new MCPServer({
      name: 'scores',
      version: '1.0.0',
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
    });
    server.registerTool(teamScores);
    await server.start();
    client = await MCPClient.connect({
      transport: 'http',
      url: `http://127.0.0.1:${server.getPort()}/mcp`,
    });
    cog = createTestCogitator();
  });

  afterAll(async () => {
    await client?.close();
    await server?.stop();
    await cog?.close();
  });

  it('calls a tool whose output schema is an array and gets its structured result', async () => {
    expect(client.era).toBe('modern');
    const tools = await client.getTools();
    expect(tools[0]?.toJSON().outputSchema).toMatchObject({ type: 'array' });

    const agent = createTestAgent({
      instructions:
        'You report game scores. You MUST call the team_scores tool, then answer with the points it returned.',
      tools,
      maxIterations: 4,
    });
    let result: RunResult | undefined;
    for (let attempt = 0; attempt < 4 && asked.length === 0; attempt++) {
      result = await cog.run(agent, {
        input: 'What were the scores of the Hawks? Call team_scores with team "Hawks".',
      });
    }

    expect(asked.length).toBeGreaterThan(0);
    const toolMessage = result?.messages.find((message) => message.role === 'tool');
    const content = String(toolMessage?.content);
    expect(JSON.parse(content)).toEqual([
      { game: 3, points: 71 },
      { game: 2, points: 64 },
    ]);
  });
});
