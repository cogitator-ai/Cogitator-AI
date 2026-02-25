import { createCogitator, DEFAULT_MODEL, header } from '../_shared/setup.js';
import { Agent, tool } from '@cogitator-ai/core';
import { cogitatorApp, setupWebSocket } from '@cogitator-ai/koa';
import Koa from 'koa';
import { z } from 'zod';

const PORT = 3103;

const calculator = tool({
  name: 'calculator',
  description: 'Evaluate a math expression',
  parameters: z.object({
    expression: z.string().describe('Math expression to evaluate'),
  }),
  execute: async ({ expression }) => {
    const result = new Function(`return (${expression})`)() as number;
    return { expression, result };
  },
});

async function main() {
  header('04 — Koa Server Integration');

  const cog = createCogitator();

  const assistant = new Agent({
    name: 'assistant',
    model: DEFAULT_MODEL,
    instructions: 'You are a helpful assistant. Use tools when appropriate. Be concise.',
    tools: [calculator],
    temperature: 0.3,
  });

  const router = cogitatorApp({
    cogitator: cog,
    agents: { assistant },
    enableSwagger: false,
    enableWebSocket: true,
  });

  const app = new Koa();
  app.use(router.routes());
  app.use(router.allowedMethods());

  const server = app.listen(PORT, () => {
    console.log(`Koa server running on http://localhost:${PORT}`);
    console.log();
    console.log('Try these curl commands:');
    console.log();
    console.log(`  curl http://localhost:${PORT}/health`);
    console.log(`  curl http://localhost:${PORT}/agents`);
    console.log(`  curl -X POST http://localhost:${PORT}/agents/assistant/run \\`);
    console.log(`    -H 'Content-Type: application/json' \\`);
    console.log(`    -d '{"input": "What is 123 * 456?"}'`);
    console.log();
    console.log('WebSocket:');
    console.log(`  wscat -c ws://localhost:${PORT}/ws`);
    console.log(`  > {"type":"run","payload":{"type":"agent","name":"assistant","input":"Hi"}}`);
    console.log();
  });

  await setupWebSocket(server, {
    runtime: cog,
    agents: { assistant },
    workflows: {},
    swarms: {},
  });

  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    server.close();
    cog.close();
    process.exit(0);
  });
}

main();
