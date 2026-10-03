/**
 * Cogitator on Deno: the Hono adapter served by `Deno.serve`.
 *
 *   deno run --allow-net --allow-env=GOOGLE_API_KEY,PORT examples/integrations/09-deno-server.ts
 *
 * The runtime needs network access to the model provider and the variables it
 * reads, nothing else — no file system, no subprocesses.
 */
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { cogitatorApp } from '@cogitator-ai/hono';
import { Hono } from 'hono';
import { z } from 'zod';

const apiKey = Deno.env.get('GOOGLE_API_KEY');
if (!apiKey) {
  console.error('Set GOOGLE_API_KEY to run this example');
  Deno.exit(1);
}
const port = Number(Deno.env.get('PORT') ?? 3105);

const calculator = tool({
  name: 'calculator',
  description: 'Add, subtract, multiply or divide two numbers',
  parameters: z.object({
    a: z.number(),
    b: z.number(),
    op: z.enum(['+', '-', '*', '/']),
  }),
  execute: async ({ a, b, op }) => {
    const result = op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : a / b;
    return { result };
  },
});

const assistant = new Agent({
  name: 'assistant',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are a helpful assistant. Use the calculator for arithmetic. Be concise.',
  tools: [calculator],
  temperature: 0.3,
});

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });

const app = new Hono();
app.route('/cogitator', cogitatorApp({ cogitator: cog, agents: { assistant } }));

const server = Deno.serve({ port, onListen: () => {} }, app.fetch);
console.log(`Deno server running on http://localhost:${port}`);
console.log(`  curl -X POST http://localhost:${port}/cogitator/agents/assistant/run \\`);
console.log(`    -H 'Content-Type: application/json' -d '{"input": "What is 123 * 456?"}'`);

Deno.addSignalListener('SIGINT', async () => {
  await server.shutdown();
  await cog.close();
  Deno.exit(0);
});
