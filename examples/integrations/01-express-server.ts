import { createCogitator, DEFAULT_MODEL, header } from '../_shared/setup.js';
import { Agent, tool } from '@cogitator-ai/core';
import { CogitatorServer } from '@cogitator-ai/express';
import express from 'express';
import { z } from 'zod';

const PORT = 3100;

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
  header('01 — Express Server Integration');

  const cog = createCogitator();

  const assistant = new Agent({
    name: 'assistant',
    model: DEFAULT_MODEL,
    instructions: 'You are a helpful assistant. Use tools when appropriate. Be concise.',
    tools: [calculator],
    temperature: 0.3,
  });

  const app = express();
  const router = express.Router();

  const server = new CogitatorServer({
    app: router,
    cogitator: cog,
    agents: { assistant },
    config: {
      basePath: '/cogitator',
      enableSwagger: false,
    },
  });

  await server.init();
  app.use(router);

  const httpServer = app.listen(PORT, () => {
    console.log(`Express server running on http://localhost:${PORT}`);
    console.log();
    console.log('Try these curl commands:');
    console.log();
    console.log(`  curl http://localhost:${PORT}/cogitator/health`);
    console.log(`  curl http://localhost:${PORT}/cogitator/agents`);
    console.log(`  curl -X POST http://localhost:${PORT}/cogitator/agents/assistant/run \\`);
    console.log(`    -H 'Content-Type: application/json' \\`);
    console.log(`    -d '{"input": "What is 123 * 456?"}'`);
    console.log();
  });

  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    httpServer.close();
    cog.close();
    process.exit(0);
  });
}

main();
