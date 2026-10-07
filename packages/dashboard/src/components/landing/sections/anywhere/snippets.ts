/**
 * Integration snippets for the "Runs anywhere" section. Each one is compiled against the real
 * packages (see the section's doccheck notes) and follows the adapter's README and the matching
 * file in examples/integrations/.
 */

export const AGENT_TS = `
import { Agent, Cogitator, calculator } from '@cogitator-ai/core';

export const cogitator = new Cogitator({
  llm: {
    defaultModel: 'anthropic/claude-sonnet-5-5',
    providers: { anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! } },
  },
  memory: { adapter: 'memory' },
});

export const assistant = new Agent({
  name: 'assistant',
  instructions: 'Answer briefly. Use the calculator for arithmetic.',
  tools: [calculator],
});
`;

export const EXPRESS_TS = `
import express from 'express';
import { createServer } from 'node:http';
import { CogitatorServer } from '@cogitator-ai/express';
import { assistant, cogitator } from './agent';

const app = express();

const server = new CogitatorServer({
  app,
  cogitator,
  agents: { assistant },
  config: { basePath: '/cogitator', enableWebSocket: true },
});
await server.init();

const http = createServer(app);
await server.attachWebSocket(http);
http.listen(3000);
`;

export const FASTIFY_TS = `
import Fastify from 'fastify';
import { cogitatorPlugin } from '@cogitator-ai/fastify';
import { assistant, cogitator } from './agent';

const fastify = Fastify();

await fastify.register(cogitatorPlugin, {
  cogitator,
  agents: { assistant },
  prefix: '/cogitator',
  enableSwagger: true,
  enableWebSocket: true,
});

await fastify.listen({ port: 3000 });
`;

export const HONO_TS = `
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cogitatorApp } from '@cogitator-ai/hono';
import { assistant, cogitator } from './agent';

const app = new Hono();

app.route(
  '/cogitator',
  cogitatorApp({ cogitator, agents: { assistant }, enableSwagger: true })
);

serve({ fetch: app.fetch, port: 3000 });
`;

export const KOA_TS = `
import Koa from 'koa';
import { createServer } from 'node:http';
import { cogitatorApp, setupWebSocket } from '@cogitator-ai/koa';
import { assistant, cogitator } from './agent';

const agents = { assistant };
const router = cogitatorApp({ cogitator, agents, enableSwagger: true });

const app = new Koa();
app.use(router.routes());
app.use(router.allowedMethods());

const server = createServer(app.callback());
await setupWebSocket(server, {
  runtime: cogitator,
  agents,
  workflows: {},
  swarms: {},
});
server.listen(3000);
`;

export const NEXT_ROUTE_TS = `
import { createChatHandler } from '@cogitator-ai/next';
import { assistant, cogitator } from '@/lib/agent';

export const POST = createChatHandler(cogitator, assistant);
`;

export const NEXT_CHAT_TSX = `
'use client';

import { useCogitatorChat } from '@cogitator-ai/next/client';

export function Chat() {
  const { messages, input, setInput, send, isLoading } = useCogitatorChat({
    api: '/api/chat',
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {messages.map((message) => (
        <p key={message.id}>{message.content}</p>
      ))}
      <input
        value={input}
        onChange={(event) => setInput(event.target.value)}
        disabled={isLoading}
      />
    </form>
  );
}
`;

export const TETSU_TS = `
import { createApp, group } from '@tetsujs/core';
import { docs } from '@tetsujs/openapi';
import { cogitatorController } from '@cogitator-ai/tetsu';
import { assistant, cogitator } from './agent';

const app = createApp({
  routes: [
    group('/cogitator', {
      children: [
        cogitatorController({
          cogitator,
          agents: { assistant },
          websocket: true,
        }),
      ],
    }),
    docs({ info: { title: 'Agents', version: '1.0.0' } }),
  ],
});

Bun.serve({ ...app, port: 3000 });
`;

export const DENO_TS = `
import { Hono } from 'hono';
import { Agent, Cogitator, calculator } from '@cogitator-ai/core';
import { cogitatorApp } from '@cogitator-ai/hono';

const cogitator = new Cogitator({
  llm: {
    providers: { google: { apiKey: Deno.env.get('GOOGLE_API_KEY')! } },
  },
});

const assistant = new Agent({
  name: 'assistant',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'Answer briefly. Use the calculator for arithmetic.',
  tools: [calculator],
});

const app = new Hono();
app.route('/cogitator', cogitatorApp({ cogitator, agents: { assistant } }));

Deno.serve({ port: 3000 }, app.fetch);
`;

export const WORKER_TS = `
import { env } from 'cloudflare:workers';
import { Agent, Cogitator, calculator } from '@cogitator-ai/core';
import { cogitatorApp } from '@cogitator-ai/hono';

const cogitator = new Cogitator({
  llm: { providers: { google: { apiKey: env.GOOGLE_API_KEY } } },
});

const assistant = new Agent({
  name: 'assistant',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'Answer briefly. Use the calculator for arithmetic.',
  tools: [calculator],
});

export default cogitatorApp({ cogitator, agents: { assistant } });
`;

export const WRANGLER_JSONC = `
{
  "name": "cogitator-agent",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01"
}
`;

export const OPENAI_TS = `
import OpenAI from 'openai';
import { createOpenAIServer } from '@cogitator-ai/openai-compat';
import { assistant, cogitator } from './agent';

const server = createOpenAIServer(cogitator, {
  port: 8080,
  agents: { assistant },
});
await server.start();

const openai = new OpenAI({ baseURL: server.getBaseUrl(), apiKey: 'local' });

const stream = await openai.chat.completions.create({
  model: 'assistant',
  messages: [{ role: 'user', content: 'What is 123 * 456?' }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta.content ?? '');
}
`;

export const AI_SDK_TS = `
import { streamText } from 'ai';
import { cogitatorModel } from '@cogitator-ai/ai-sdk';
import { assistant, cogitator } from './agent';

const result = streamText({
  model: cogitatorModel(cogitator, assistant),
  prompt: 'What is 123 * 456?',
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}

console.log(await result.toolCalls);
`;
