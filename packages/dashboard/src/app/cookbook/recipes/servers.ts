import type { Section } from './types';

export const servers: Section = {
  id: 'servers',
  title: 'Servers & Frameworks',
  icon: '🌐',
  description:
    'Serve agents over REST, SSE and WebSocket from Express, Fastify, Hono, Koa, Next.js and Tetsu, or behind the OpenAI and AI SDK interfaces.',
  recipes: [
    {
      id: 'express-server',
      title: 'Express',
      difficulty: 'easy',
      time: '5 min',
      problem: 'You want your agent behind a REST API with streaming in an existing Express app.',
      points: ['Mount `CogitatorServer` on a router under `/cogitator`'],
      file: 'express-server.ts',
      code: `import { Agent, Cogitator, calculator } from '@cogitator-ai/core';
import { CogitatorServer } from '@cogitator-ai/express';
import express from 'express';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });

const assistant = new Agent({
  name: 'assistant',
  description: 'General assistant with a calculator tool',
  model: 'google/gemini-3.5-flash-lite',
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
  config: { basePath: '/cogitator', enableSwagger: false },
});
await server.init();
app.use(router);

app.listen(3100, () => console.log('Listening on http://localhost:3100/cogitator'));`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/express express',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx express-server.ts',
      repoRun: 'npx tsx examples/integrations/01-express-server.ts',
      extra: [
        {
          title: 'Try it',
          language: 'bash',
          code: `curl http://localhost:3100/cogitator/agents
curl -X POST http://localhost:3100/cogitator/agents/assistant/run \\
  -H 'Content-Type: application/json' -d '{"input": "What is 123 * 456?"}'
curl -N -X POST http://localhost:3100/cogitator/agents/assistant/stream \\
  -H 'Content-Type: application/json' -d '{"input": "Explain recursion in one sentence"}'`,
        },
      ],
      example: 'integrations/01-express-server.ts',
      docs: [
        {
          href: '/docs/server-adapters/express',
          label: 'Express Adapter',
        },
      ],
    },
    {
      id: 'fastify-server',
      title: 'Fastify',
      difficulty: 'easy',
      time: '5 min',
      problem: 'Same API, but your service runs on Fastify.',
      points: ['Register `cogitatorPlugin` with a prefix'],
      file: 'fastify-server.ts',
      code: `import { Agent, Cogitator, calculator } from '@cogitator-ai/core';
import { cogitatorPlugin } from '@cogitator-ai/fastify';
import Fastify from 'fastify';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });

const assistant = new Agent({
  name: 'assistant',
  description: 'General assistant with a calculator tool',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are a helpful assistant. Use tools when appropriate. Be concise.',
  tools: [calculator],
  temperature: 0.3,
});

const fastify = Fastify({ logger: false });

await fastify.register(cogitatorPlugin, {
  cogitator: cog,
  agents: { assistant },
  prefix: '/cogitator',
  enableSwagger: false,
});

await fastify.listen({ port: 3101, host: '0.0.0.0' });
console.log('Listening on http://localhost:3101/cogitator');`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/fastify fastify',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx fastify-server.ts',
      repoRun: 'npx tsx examples/integrations/02-fastify-server.ts',
      extra: [
        {
          title: 'Try it',
          language: 'bash',
          code: `curl -X POST http://localhost:3101/cogitator/agents/assistant/run \\
  -H 'Content-Type: application/json' -d '{"input": "What is 123 * 456?"}'`,
        },
      ],
      example: 'integrations/02-fastify-server.ts',
      docs: [
        {
          href: '/docs/server-adapters/fastify',
          label: 'Fastify Adapter',
        },
      ],
    },
    {
      id: 'hono-server',
      title: 'Hono',
      difficulty: 'easy',
      time: '5 min',
      problem: 'You want a small, fetch-based server that you can later move to an edge runtime.',
      points: [
        'Mount `cogitatorApp()` as a Hono sub-app and serve it on Node with `@hono/node-server`',
      ],
      file: 'hono-server.ts',
      code: `import { Agent, Cogitator, calculator } from '@cogitator-ai/core';
import { cogitatorApp } from '@cogitator-ai/hono';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });

const assistant = new Agent({
  name: 'assistant',
  description: 'General assistant with a calculator tool',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are a helpful assistant. Use tools when appropriate. Be concise.',
  tools: [calculator],
  temperature: 0.3,
});

const app = new Hono();
app.route('/cogitator', cogitatorApp({ cogitator: cog, agents: { assistant }, enableSwagger: false }));

serve({ fetch: app.fetch, port: 3102 }, () => console.log('Listening on http://localhost:3102/cogitator'));`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/hono @hono/node-server hono',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx hono-server.ts',
      repoRun: 'npx tsx examples/integrations/03-hono-server.ts',
      extra: [
        {
          title: 'Try it',
          language: 'bash',
          code: `curl -X POST http://localhost:3102/cogitator/agents/assistant/run \\
  -H 'Content-Type: application/json' -d '{"input": "What is 123 * 456?"}'`,
        },
      ],
      example: 'integrations/03-hono-server.ts',
      docs: [
        {
          href: '/docs/server-adapters/hono',
          label: 'Hono Adapter',
        },
      ],
    },
    {
      id: 'koa-server',
      title: 'Koa with WebSocket',
      difficulty: 'easy',
      time: '5 min',
      problem: 'Your app is on Koa and clients want a WebSocket as well as REST.',
      points: [
        'Use the `cogitatorApp()` router',
        'Attach the WebSocket endpoint with `setupWebSocket()`',
      ],
      file: 'koa-server.ts',
      code: `import { Agent, Cogitator, calculator } from '@cogitator-ai/core';
import { cogitatorApp, setupWebSocket } from '@cogitator-ai/koa';
import Koa from 'koa';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });

const assistant = new Agent({
  name: 'assistant',
  description: 'General assistant with a calculator tool',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are a helpful assistant. Use tools when appropriate. Be concise.',
  tools: [calculator],
  temperature: 0.3,
});

const router = cogitatorApp({ cogitator: cog, agents: { assistant }, enableSwagger: false });

const app = new Koa();
app.use(router.routes());
app.use(router.allowedMethods());

const server = app.listen(3103, () => console.log('Listening on http://localhost:3103'));

await setupWebSocket(server, {
  runtime: cog,
  agents: { assistant },
  workflows: {},
  swarms: {},
});`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/koa koa',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx koa-server.ts',
      repoRun: 'npx tsx examples/integrations/04-koa-server.ts',
      extra: [
        {
          title: 'Try it',
          language: 'bash',
          code: `curl -X POST http://localhost:3103/agents/assistant/run \\
  -H 'Content-Type: application/json' -d '{"input": "What is 123 * 456?"}'

npx wscat -c ws://localhost:3103/ws
> {"type":"run","payload":{"type":"agent","name":"assistant","input":"Hi"}}`,
        },
      ],
      example: 'integrations/04-koa-server.ts',
      docs: [
        {
          href: '/docs/server-adapters/koa',
          label: 'Koa Adapter',
        },
      ],
    },
    {
      id: 'nextjs-handler',
      title: 'Next.js Route Handler',
      difficulty: 'easy',
      time: '10 min',
      problem: 'You want a streaming chat endpoint in a Next.js App Router project.',
      points: [
        'Export `createChatHandler()` as `POST` from a route file',
        'Authenticate in `beforeRun` and log usage in `afterRun`',
      ],
      file: 'app/api/chat/route.ts',
      code: `import { Agent, Cogitator, calculator } from '@cogitator-ai/core';
import { createChatHandler } from '@cogitator-ai/next';

const cogitator = new Cogitator({
  llm: { providers: { google: { apiKey: process.env.GOOGLE_API_KEY ?? '' } } },
  memory: { adapter: 'memory' },
});

const agent = new Agent({
  name: 'assistant',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are a helpful assistant. Use tools when appropriate. Be concise.',
  tools: [calculator],
  temperature: 0.3,
});

export const POST = createChatHandler(cogitator, agent, {
  beforeRun: async (req) => {
    const auth = req.headers.get('authorization');
    if (!auth) throw new Error('Unauthorized');
    return { userId: auth };
  },
  afterRun: async (result) => {
    console.log(\`Tokens used: \${result.usage.totalTokens}\`);
  },
});`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/next',
      env: ['GOOGLE_API_KEY'],
      run: 'pnpm next dev   # GOOGLE_API_KEY in .env.local',
      runNote:
        'The repo file is a reference for a Next.js project, not a script you run on its own.',
      notes: [
        {
          type: 'tip',
          text: 'Consume the stream on the client with `useCogitatorChat` from `@cogitator-ai/next/client`. For a JSON endpoint export `createAgentHandler(cogitator, agent)` as `POST` from another route file.',
        },
      ],
      example: 'integrations/05-nextjs-handler.ts',
      docs: [
        {
          href: '/docs/integrations/nextjs',
          label: 'Next.js',
        },
      ],
    },
    {
      id: 'tetsu-server',
      title: 'Tetsu on Bun',
      difficulty: 'medium',
      time: '15 min',
      problem:
        'Your API runs on Bun with Tetsu. Signed-in users talk to an agent that can only touch their own tasks and threads.',
      points: [
        'Mount `cogitatorController()` with an auth hook shared with your routes',
        'Tools read the caller from `context.userId`; `authorizeThread` keeps threads private',
        'Get OpenAPI docs for free at `/docs`',
      ],
      file: 'tetsu-server.ts',
      code: `import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { callerHook, cogitatorController, type AuthContext } from '@cogitator-ai/tetsu';
import { createApp, group, type BaseCtx } from '@tetsujs/core';
import { docs, secured } from '@tetsujs/openapi';
import { z } from 'zod';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const users = new Map([
  ['token-ada', { id: 'ada', name: 'Ada' }],
  ['token-grace', { id: 'grace', name: 'Grace' }],
]);

const tasks = [
  { id: 1, owner: 'ada', title: 'Review the analytical engine notes', done: false },
  { id: 2, owner: 'grace', title: 'Find the moth in relay 70', done: true },
];

function ownerOf(userId: string | undefined): string {
  if (!userId) throw new Error('Tasks are only available to a signed-in user');
  return userId;
}

const listMyTasks = tool({
  name: 'list_my_tasks',
  description: "List the signed-in user's tasks",
  parameters: z.object({}),
  execute: async (_args, context) => tasks.filter((task) => task.owner === ownerOf(context.userId)),
});

const addMyTask = tool({
  name: 'add_my_task',
  description: 'Add a task for the signed-in user',
  parameters: z.object({ title: z.string().min(1) }),
  execute: async ({ title }, context) => {
    const task = { id: tasks.length + 1, owner: ownerOf(context.userId), title, done: false };
    tasks.push(task);
    return task;
  },
});

function authenticate(ctx: BaseCtx): AuthContext | undefined {
  const token = ctx.req.headers.get('authorization')?.replace(/^Bearer /, '');
  const user = token ? users.get(token) : undefined;
  return user && { userId: user.id, metadata: { name: user.name } };
}

const signedIn = secured(callerHook(authenticate), {
  name: 'bearerAuth',
  scheme: { type: 'http', scheme: 'bearer' },
  error: 'UNAUTHORIZED',
});

const assistant = new Agent({
  name: 'assistant',
  description: 'Manages the tasks of the signed-in user',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You help the user with their tasks. Use the tools to read and add tasks. Be concise.',
  tools: [listMyTasks, addMyTask],
  temperature: 0.2,
});

const app = createApp({
  routes: [
    group('/api/agent', {
      children: [
        cogitatorController({
          cogitator: new Cogitator({
            llm: { providers: { google: { apiKey } } },
            memory: { adapter: 'memory' },
          }),
          agents: { assistant },
          auth: signedIn,
          authorizeThread: (auth, threadId) => threadId.startsWith(\`\${auth?.userId}:\`),
          websocket: true,
        }),
      ],
    }),
    docs({ info: { title: 'Tasks app', version: '1.0.0' } }),
  ],
});

Bun.serve({ ...app, port: 3104 });
console.log('Listening on http://localhost:3104 (API docs at /docs)');`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/tetsu @tetsujs/core @tetsujs/openapi zod',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key bun tetsu-server.ts',
      repoRun: 'bun examples/integrations/08-tetsu-server.ts',
      extra: [
        {
          title: 'Try it',
          language: 'bash',
          code: `curl -X POST http://localhost:3104/api/agent/agents/assistant/run \\
  -H 'Authorization: Bearer token-ada' -H 'Content-Type: application/json' \\
  -d '{"input": "What is on my list? Add: call Charles.", "threadId": "ada:1"}'`,
        },
      ],
      notes: [
        {
          type: 'info',
          text: 'Requests without a token get `401` before the body is read, and a `threadId` that does not start with the caller’s id gets `403`. The repo example also serves the tasks from its own MCP server.',
        },
      ],
      example: 'integrations/08-tetsu-server.ts',
      docs: [
        {
          href: '/docs/server-adapters/tetsu',
          label: 'Tetsu Adapter',
        },
      ],
    },
    {
      id: 'openai-compat',
      title: 'OpenAI-Compatible API',
      difficulty: 'medium',
      time: '10 min',
      problem:
        'Existing code uses the OpenAI SDK (Assistants API). You want it to run on Cogitator without rewriting it.',
      points: [
        'Start `createOpenAIServer()` with your tools',
        'Point the official `openai` client at it and use assistants, threads and runs',
      ],
      file: 'openai-compat.ts',
      code: `import { Cogitator, tool } from '@cogitator-ai/core';
import { createOpenAIServer } from '@cogitator-ai/openai-compat';
import OpenAI from 'openai';
import { z } from 'zod';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const multiply = tool({
  name: 'multiply',
  description: 'Multiply two numbers',
  parameters: z.object({ a: z.number(), b: z.number() }),
  execute: async ({ a, b }) => ({ product: a * b }),
});

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });
const server = createOpenAIServer(cog, {
  port: 8080,
  tools: [multiply],
  defaultModel: 'google/gemini-3.5-flash-lite',
  logging: false,
});
await server.start();

const openai = new OpenAI({ baseURL: 'http://localhost:8080/v1', apiKey: 'not-needed' });

try {
  const assistant = await openai.beta.assistants.create({
    name: 'math-helper',
    model: 'cogitator',
    instructions: 'You are a math helper. Use the multiply tool for products. Be concise.',
  });
  const thread = await openai.beta.threads.create();

  await openai.beta.threads.messages.create(thread.id, { role: 'user', content: 'What is 42 * 17?' });
  const run = await openai.beta.threads.runs.createAndPoll(thread.id, { assistant_id: assistant.id });
  console.log('Run status:', run.status);

  const messages = await openai.beta.threads.messages.list(thread.id);
  const reply = messages.data[0]?.content[0];
  if (reply?.type === 'text') console.log(reply.text.value);
} finally {
  await server.stop();
  await cog.close();
}`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/openai-compat openai zod',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx openai-compat.ts',
      repoRun: 'npx tsx examples/integrations/06-openai-compat.ts',
      example: 'integrations/06-openai-compat.ts',
      docs: [
        {
          href: '/docs/integrations/openai-compat',
          label: 'OpenAI Compatibility',
        },
      ],
    },
    {
      id: 'ai-sdk-adapter',
      title: 'Vercel AI SDK',
      difficulty: 'medium',
      time: '10 min',
      problem:
        'Your UI is built on the Vercel AI SDK. You want Cogitator agents as AI SDK models and tools shared both ways.',
      points: [
        'Use an agent as a model with `cogitatorModel()` in `generateText` and `streamText`',
        'Convert tools with `toAISDKTool()` and `fromAISDKTool()`',
      ],
      file: 'ai-sdk-adapter.ts',
      code: `import { Agent, Cogitator, calculator } from '@cogitator-ai/core';
import { cogitatorModel, fromAISDKTool, toAISDKTool } from '@cogitator-ai/ai-sdk';
import { generateText, streamText, tool as aiTool } from 'ai';
import { z } from 'zod';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });

const chat = new Agent({
  name: 'chat',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are a helpful assistant. Answer in one sentence.',
  temperature: 0.3,
});

const { text, usage } = await generateText({
  model: cogitatorModel(cog, chat),
  prompt: 'What is the capital of France?',
});
console.log(text, usage.inputTokens, usage.outputTokens);

const math = new Agent({
  name: 'math',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'Use the calculator tool for arithmetic, then answer in one sentence.',
  tools: [calculator],
  temperature: 0,
});

const stream = streamText({ model: cogitatorModel(cog, math), prompt: 'What is 1234 * 5678?' });
for await (const chunk of stream.textStream) process.stdout.write(chunk);
console.log();

const aiCalculator = toAISDKTool(calculator);
console.log('AI SDK tool:', aiCalculator.description);

const greet = aiTool({
  description: 'Generate a greeting',
  inputSchema: z.object({ name: z.string() }),
  execute: async ({ name }) => \`Hello, \${name}!\`,
});
const greetForCogitator = fromAISDKTool(greet, 'greet');
console.log('Cogitator tool:', greetForCogitator.name, greetForCogitator.toJSON().parameters);

await cog.close();`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/ai-sdk ai zod',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx ai-sdk-adapter.ts',
      repoRun: 'npx tsx examples/integrations/07-ai-sdk-adapter.ts',
      example: 'integrations/07-ai-sdk-adapter.ts',
      docs: [
        {
          href: '/docs/integrations/ai-sdk',
          label: 'AI SDK',
        },
      ],
    },
  ],
};
