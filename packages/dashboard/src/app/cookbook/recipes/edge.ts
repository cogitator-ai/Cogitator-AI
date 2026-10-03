import type { Section } from './types';

export const edge: Section = {
  id: 'edge',
  title: 'Deno & Edge',
  icon: '☁️',
  description: 'The Hono adapter on Deno and on Cloudflare Workers.',
  recipes: [
    {
      id: 'deno-server',
      title: 'Deno',
      difficulty: 'easy',
      time: '5 min',
      problem:
        'You want to serve an agent from Deno with only network and environment permissions.',
      points: ['Serve the Hono adapter with `Deno.serve`', 'Shut down cleanly on SIGINT'],
      file: 'deno-server.ts',
      code: `import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { cogitatorApp } from '@cogitator-ai/hono';
import { Hono } from 'hono';
import { z } from 'zod';

const apiKey = Deno.env.get('GOOGLE_API_KEY');
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const calculator = tool({
  name: 'calculator',
  description: 'Add, subtract, multiply or divide two numbers',
  parameters: z.object({ a: z.number(), b: z.number(), op: z.enum(['+', '-', '*', '/']) }),
  execute: async ({ a, b, op }) => ({
    result: op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : a / b,
  }),
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

const server = Deno.serve({ port: Number(Deno.env.get('PORT') ?? 3105) }, app.fetch);

Deno.addSignalListener('SIGINT', async () => {
  await server.shutdown();
  await cog.close();
  Deno.exit(0);
});`,
      install: 'deno add npm:@cogitator-ai/core npm:@cogitator-ai/hono npm:hono npm:zod',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key deno run --allow-net --allow-env=GOOGLE_API_KEY,PORT deno-server.ts',
      repoRun:
        'deno run --allow-net --allow-env=GOOGLE_API_KEY,PORT examples/integrations/09-deno-server.ts',
      extra: [
        {
          title: 'Try it',
          language: 'bash',
          code: `curl -X POST http://localhost:3105/cogitator/agents/assistant/run \\
  -H 'Content-Type: application/json' -d '{"input": "What is 123 * 456?"}'`,
        },
      ],
      example: 'integrations/09-deno-server.ts',
      docs: [
        {
          href: '/docs/deployment/edge',
          label: 'Edge Runtimes',
        },
      ],
    },
    {
      id: 'cloudflare-worker',
      title: 'Cloudflare Workers',
      difficulty: 'medium',
      time: '10 min',
      problem:
        'You want the agent API on Cloudflare’s edge, with the API key kept as a Worker secret.',
      points: [
        'Read secrets from `env` in `cloudflare:workers`',
        'Export `cogitatorApp()` as the Worker',
      ],
      file: 'src/index.ts',
      code: `import { env } from 'cloudflare:workers';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { cogitatorApp } from '@cogitator-ai/hono';
import { z } from 'zod';

interface Env {
  GOOGLE_API_KEY: string;
}

const calculator = tool({
  name: 'calculator',
  description: 'Add, subtract, multiply or divide two numbers',
  parameters: z.object({ a: z.number(), b: z.number(), op: z.enum(['+', '-', '*', '/']) }),
  execute: async ({ a, b, op }) => ({
    result: op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : a / b,
  }),
});

const assistant = new Agent({
  name: 'assistant',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are a helpful assistant. Use the calculator for arithmetic. Be concise.',
  tools: [calculator],
  temperature: 0.3,
});

const cogitator = new Cogitator({
  llm: { providers: { google: { apiKey: (env as Env).GOOGLE_API_KEY } } },
});

export default cogitatorApp({ cogitator, agents: { assistant } });`,
      install:
        'npm install @cogitator-ai/core @cogitator-ai/hono hono zod\nnpm install -D wrangler @cloudflare/workers-types',
      env: ['GOOGLE_API_KEY'],
      run: 'echo "GOOGLE_API_KEY=your-key" > .dev.vars\nnpx wrangler dev',
      repoRun: 'cd examples/integrations/10-cloudflare-worker && npm install && npm run dev',
      extra: [
        {
          title: 'wrangler.jsonc',
          language: 'jsonc',
          code: `{
  "name": "cogitator-agent",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01"
}`,
        },
        {
          title: 'Deploy',
          language: 'bash',
          code: `npx wrangler secret put GOOGLE_API_KEY
npx wrangler deploy`,
        },
      ],
      notes: [
        {
          type: 'warning',
          text: 'Threads live in the isolate’s memory, which Workers recycle at will. For lasting conversations use the Postgres memory adapter and create the `Cogitator` per request — see the example’s README.',
        },
      ],
      example: 'integrations/10-cloudflare-worker/src/index.ts',
      docs: [
        {
          href: '/docs/deployment/edge',
          label: 'Edge Runtimes',
        },
      ],
    },
  ],
};
