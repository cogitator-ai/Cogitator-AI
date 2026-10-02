import { createCogitator, DEFAULT_MODEL, header } from '../_shared/setup.js';
import { Agent, tool } from '@cogitator-ai/core';
import type { Tool } from '@cogitator-ai/core';
import { MCPClient, MCPServer } from '@cogitator-ai/mcp';
import { callerHook, cogitatorController } from '@cogitator-ai/tetsu';
import type { AuthContext } from '@cogitator-ai/tetsu';
import { controller, createApp, group, httpError, route } from '@tetsujs/core';
import type { BaseCtx } from '@tetsujs/core';
import { docs, secured } from '@tetsujs/openapi';
import { z } from 'zod';

const PORT = 3104;

const users = new Map<string, { id: string; name: string }>([
  ['token-ada', { id: 'ada', name: 'Ada' }],
  ['token-grace', { id: 'grace', name: 'Grace' }],
]);

interface Task {
  id: number;
  owner: string;
  title: string;
  done: boolean;
}

const tasks: Task[] = [
  { id: 1, owner: 'ada', title: 'Review the analytical engine notes', done: false },
  { id: 2, owner: 'grace', title: 'Find the moth in relay 70', done: true },
];

function tasksServer(): MCPServer {
  const server = new MCPServer({
    name: 'tasks',
    version: '1.0.0',
    transport: 'http',
    host: '127.0.0.1',
    port: 0,
  });
  server.registerTools([
    tool({
      name: 'list_tasks',
      description: 'List the tasks of a user',
      parameters: z.object({ owner: z.string() }),
      execute: async ({ owner }) => tasks.filter((task) => task.owner === owner),
    }),
    tool({
      name: 'add_task',
      description: 'Add a task for a user',
      parameters: z.object({ owner: z.string(), title: z.string().min(1) }),
      execute: async ({ owner, title }) => {
        const task = { id: tasks.length + 1, owner, title, done: false };
        tasks.push(task);
        return task;
      },
    }),
  ]);
  return server;
}

function userTools(client: MCPClient): Tool[] {
  const ownerOf = (userId: string | undefined) => {
    if (!userId) throw new Error('Tasks are only available to a signed-in user');
    return userId;
  };

  return [
    tool({
      name: 'list_my_tasks',
      description: "List the signed-in user's tasks",
      parameters: z.object({}),
      execute: async (_args, context) =>
        client.callTool('list_tasks', { owner: ownerOf(context.userId) }),
    }),
    tool({
      name: 'add_my_task',
      description: 'Add a task for the signed-in user',
      parameters: z.object({ title: z.string().min(1).describe('What needs to be done') }),
      execute: async ({ title }, context) =>
        client.callTool('add_task', { owner: ownerOf(context.userId), title }),
    }),
  ];
}

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

const meController = controller('Me', () => ({
  profile: route({
    method: 'GET',
    path: '/me',
    hooks: { beforeParse: [signedIn] },
    handler: (ctx) => {
      const userId = ctx.cogitatorAuth?.userId;
      const user = [...users.values()].find((candidate) => candidate.id === userId);
      if (!user) throw httpError(404, 'USER_NOT_FOUND');
      return user;
    },
  }),
}));

async function main() {
  header('08 — Tetsu Server on Bun: an app with its own MCP server and agent');

  if (typeof Bun === 'undefined') {
    console.error(
      'Tetsu runs on Bun. Start this example with: bun examples/integrations/08-tetsu-server.ts'
    );
    process.exit(1);
  }

  const mcp = tasksServer();
  await mcp.start();
  const client = await MCPClient.connect({
    transport: 'http',
    url: `http://127.0.0.1:${mcp.getPort()}/mcp`,
  });

  const cogitator = createCogitator({ memory: { adapter: 'memory' } });
  const assistant = new Agent({
    name: 'assistant',
    description: 'Manages the tasks of the signed-in user',
    model: DEFAULT_MODEL,
    instructions:
      'You help the user with their tasks. Use the tools to read and add tasks. Be concise.',
    tools: userTools(client),
    temperature: 0.2,
  });

  const app = createApp({
    routes: [
      group('/api', {
        children: [
          meController(),
          group('/agent', {
            children: [
              cogitatorController({
                cogitator,
                agents: { assistant },
                auth: signedIn,
                authorizeThread: (auth, threadId) => threadId.startsWith(`${auth?.userId}:`),
                websocket: true,
              }),
            ],
          }),
        ],
      }),
      docs({ info: { title: 'Tasks app', version: '1.0.0' } }),
    ],
  });

  const server = Bun.serve({ ...app, port: PORT });

  console.log(`Tetsu server running on http://localhost:${PORT}`);
  console.log(`API docs: http://localhost:${PORT}/docs`);
  console.log();
  console.log('Try these curl commands:');
  console.log();
  console.log(`  curl -H 'Authorization: Bearer token-ada' http://localhost:${PORT}/api/me`);
  console.log(`  curl -X POST http://localhost:${PORT}/api/agent/agents/assistant/run \\`);
  console.log(`    -H 'Authorization: Bearer token-ada' -H 'Content-Type: application/json' \\`);
  console.log(`    -d '{"input": "What is on my list? Add: call Charles.", "threadId": "ada:1"}'`);
  console.log(`  curl -N -X POST http://localhost:${PORT}/api/agent/agents/assistant/stream \\`);
  console.log(`    -H 'Authorization: Bearer token-grace' -H 'Content-Type: application/json' \\`);
  console.log(`    -d '{"input": "List my tasks"}'`);
  console.log();

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await server.stop();
    await client.close();
    await mcp.stop();
    await cogitator.close();
    process.exit(0);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
