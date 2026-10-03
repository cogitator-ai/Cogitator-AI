import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent, tool } from '@cogitator-ai/core';
import { MCPClient, serveAgents } from '@cogitator-ai/mcp';
import { z } from 'zod';

const exchangeRates: Record<string, number> = { EUR: 0.92, GBP: 0.79, JPY: 151.3 };

const convert = tool({
  name: 'convert_currency',
  description: 'Convert an amount of US dollars into another currency.',
  parameters: z.object({
    amount: z.number().describe('Amount in USD'),
    to: z.enum(['EUR', 'GBP', 'JPY']).describe('Target currency'),
  }),
  execute: async ({ amount, to }) => ({
    amount: Math.round(amount * exchangeRates[to] * 100) / 100,
    currency: to,
  }),
});

async function main() {
  header('04 — A Cogitator Agent as an MCP Server');

  const cog = createCogitator({ memory: { adapter: 'memory' } });
  const travel = new Agent({
    name: 'travel_planner',
    description: 'Plans trips and budgets, converting prices between currencies.',
    model: DEFAULT_MODEL,
    instructions:
      'You plan trips. Use convert_currency for any currency question. Answer in two sentences at most.',
    tools: [convert],
    temperature: 0.2,
  });

  section('1. Serve the agent (one line)');

  const server = await serveAgents(cog, travel, { transport: 'http', host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${server.getPort()}/mcp`;
  console.log(`  MCP server: ${url}`);

  const client = await MCPClient.connect({ transport: 'http', url });
  try {
    section('2. Any MCP client sees it as a tool');

    for (const definition of await client.listToolDefinitions()) {
      console.log(`  ${definition.name}: ${definition.description}`);
    }

    section('3. Call it like any other tool');

    const first = (await client.callTool('travel_planner', {
      task: 'My hotel in Lisbon costs $180 a night. How much is that in euros?',
    })) as { output: string; threadId: string };
    console.log(`  ${first.output.trim()}`);

    const followUp = (await client.callTool('travel_planner', {
      task: 'And for 4 nights?',
      threadId: first.threadId,
    })) as { output: string };
    console.log(`  ${followUp.output.trim()}`);
  } finally {
    await client.close();
    await server.stop();
    await cog.close();
  }

  section('4. In Claude Desktop or Cursor');
  console.log(`  Serve over stdio from a script:

    await serveAgents(cog, [travel]);

  and add it to the client's MCP config:

    { "mcpServers": { "cogitator": { "command": "npx", "args": ["tsx", "my-agents.ts"] } } }`);

  console.log('\nDone.');
}

main();
