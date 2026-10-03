import type { Section } from './types';

export const protocols: Section = {
  id: 'protocols',
  title: 'MCP & A2A',
  icon: '🔌',
  description:
    'Use MCP servers, expose your tools and agents over MCP, and talk to other agents over A2A.',
  recipes: [
    {
      id: 'mcp-client',
      title: 'Use an MCP Server',
      difficulty: 'medium',
      time: '10 min',
      problem:
        'There is already an MCP server for what you need — here the filesystem one. Your agent should use its tools.',
      points: [
        'Connect over stdio with `MCPClient.connect()`',
        'Call tools directly, or convert them with `getTools()` and give them to an agent',
      ],
      file: 'mcp-client.ts',
      code: `import { Agent, Cogitator } from '@cogitator-ai/core';
import { MCPClient } from '@cogitator-ai/mcp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const allowedDir = join(process.cwd(), 'mcp-files');
mkdirSync(allowedDir, { recursive: true });
writeFileSync(
  join(allowedDir, 'inventory.json'),
  JSON.stringify({ items: [{ name: 'Hoverboard', qty: 12, price: 499.99 }, { name: 'Flux Capacitor', qty: 3, price: 1955 }] })
);

const client = await MCPClient.connect({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', allowedDir],
  timeout: 30_000,
});

try {
  for (const definition of await client.listToolDefinitions()) {
    console.log(\`\${definition.name}: \${definition.description}\`);
  }

  console.log(await client.callTool('list_directory', { path: allowedDir }));

  const tools = (await client.getTools()).filter((t) =>
    ['read_text_file', 'read_file', 'list_directory'].includes(t.name)
  );

  const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });
  const agent = new Agent({
    name: 'fs-assistant',
    model: 'google/gemini-3.5-flash-lite',
    instructions: \`You can read and list files in \${allowedDir}. Be concise.\`,
    tools,
    temperature: 0.2,
    maxIterations: 10,
  });

  const result = await cog.run(agent, {
    input: \`Read inventory.json in \${allowedDir} and tell me the total stock value (qty * price).\`,
  });
  console.log(result.output);
  await cog.close();
} finally {
  await client.close();
}`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/mcp',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx mcp-client.ts',
      repoRun: 'npx tsx examples/mcp/01-mcp-client.ts',
      notes: [
        {
          type: 'info',
          text: 'The first run downloads `@modelcontextprotocol/server-filesystem` through `npx`.',
        },
      ],
      example: 'mcp/01-mcp-client.ts',
      docs: [
        {
          href: '/docs/integrations/mcp',
          label: 'MCP',
        },
      ],
    },
    {
      id: 'mcp-server',
      title: 'Expose Tools over MCP',
      difficulty: 'medium',
      time: '10 min',
      problem:
        'Your inventory tools should be usable from any MCP client — Claude Desktop, Cursor or another agent.',
      points: [
        'Register Cogitator tools and a resource template on `MCPServer`',
        'Serve over HTTP; a thrown error reaches the client as `MCPToolError`',
      ],
      file: 'mcp-server.ts',
      code: `import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { MCPClient, MCPServer, MCPToolError } from '@cogitator-ai/mcp';
import { z } from 'zod';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const stock: Record<string, number> = { 'SKU-42': 137, 'SKU-7': 12 };

const lookupStock = tool({
  name: 'lookup_stock',
  description: 'Look up how many units of a product SKU are in stock.',
  parameters: z.object({ sku: z.string().describe('Product SKU, e.g. "SKU-42"') }),
  execute: async ({ sku }) => ({ sku, units: stock[sku] ?? 0 }),
});

const reserveUnits = tool({
  name: 'reserve_units',
  description: 'Reserve units of a product. Fails if not enough stock is available.',
  parameters: z.object({ sku: z.string(), units: z.number().int().positive() }),
  execute: async ({ sku, units }) => {
    const available = stock[sku] ?? 0;
    if (units > available) throw new Error(\`Only \${available} units of \${sku} available\`);
    stock[sku] = available - units;
    return { sku, reserved: units, remaining: stock[sku] };
  },
});

const server = new MCPServer({
  name: 'inventory',
  version: '1.0.0',
  transport: 'http',
  host: '127.0.0.1',
  port: 0,
});
server.registerTools([lookupStock, reserveUnits]);
server.registerResource({
  uri: 'inventory://sku/{sku}',
  name: 'sku',
  mimeType: 'application/json',
  read: async ({ sku }) => ({
    uri: \`inventory://sku/\${sku}\`,
    text: JSON.stringify({ sku, units: stock[sku] ?? 0 }),
  }),
});
await server.start();

const client = await MCPClient.connect({
  transport: 'http',
  url: \`http://127.0.0.1:\${server.getPort()}/mcp\`,
});

try {
  console.log(await client.callTool('lookup_stock', { sku: 'SKU-42' }));
  console.log((await client.readResource('inventory://sku/SKU-7')).text);

  try {
    await client.callTool('reserve_units', { sku: 'SKU-7', units: 999 });
  } catch (error) {
    if (!(error instanceof MCPToolError)) throw error;
    console.log('Refused:', error.message);
  }

  const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });
  const agent = new Agent({
    name: 'inventory-assistant',
    model: 'google/gemini-3.5-flash-lite',
    instructions: 'You manage inventory. Use the tools to check stock and reserve units. Be concise.',
    tools: await client.getTools(),
    temperature: 0.2,
  });
  const result = await cog.run(agent, { input: 'Reserve 40 units of SKU-42 and tell me what remains.' });
  console.log(result.output);
  await cog.close();
} finally {
  await client.close();
  await server.stop();
}`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/mcp zod',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx mcp-server.ts',
      repoRun: 'npx tsx examples/mcp/02-mcp-server.ts',
      example: 'mcp/02-mcp-server.ts',
      docs: [
        {
          href: '/docs/integrations/mcp',
          label: 'MCP',
        },
      ],
    },
    {
      id: 'per-user-mcp',
      title: 'Per-User MCP Access',
      difficulty: 'advanced',
      time: '20 min',
      problem:
        'One support agent serves many customers. Each must only see and change their own orders, and nobody may read another’s chat.',
      points: [
        'Authenticate MCP requests with an `MCPAuthFunction`; tools read `context.userId`',
        'Clone the agent per user with that user’s MCP client',
        'Get `THREAD_ACCESS_DENIED` when a user opens someone else’s thread',
      ],
      file: 'per-user-mcp.ts',
      code: `import { Agent, Cogitator, CogitatorError, ErrorCode, tool } from '@cogitator-ai/core';
import { MCPClient, MCPServer, type MCPAuthFunction } from '@cogitator-ai/mcp';
import { z } from 'zod';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

interface Order {
  id: string;
  item: string;
  status: 'processing' | 'shipped' | 'cancelled';
}

const accessTokens: Record<string, string> = { 'tok-alice-7f3a': 'alice', 'tok-bob-91c2': 'bob' };
const ordersByUser: Record<string, Order[]> = {
  alice: [{ id: 'A-1001', item: 'standing desk', status: 'shipped' }],
  bob: [{ id: 'B-2001', item: 'mechanical keyboard', status: 'processing' }],
};

const bearerAuth: MCPAuthFunction = (request) => {
  const token = request.headers.authorization?.replace(/^Bearer /, '');
  const userId = token ? accessTokens[token] : undefined;
  return userId ? { userId } : undefined;
};

const listMyOrders = tool({
  name: 'list_my_orders',
  description: "List the calling customer's orders with their status.",
  parameters: z.object({}),
  execute: async (_args, context) => ordersByUser[context.userId ?? ''] ?? [],
});

const cancelOrder = tool({
  name: 'cancel_order',
  description: "Cancel one of the calling customer's orders that has not shipped yet.",
  parameters: z.object({ orderId: z.string() }),
  execute: async ({ orderId }, context) => {
    const order = ordersByUser[context.userId ?? '']?.find((o) => o.id === orderId);
    if (!order) throw new Error(\`No order \${orderId} for this customer\`);
    if (order.status !== 'processing') throw new Error(\`Order \${orderId} has already shipped\`);
    order.status = 'cancelled';
    return order;
  },
});

const shop = new MCPServer({
  name: 'shop',
  version: '1.0.0',
  transport: 'http',
  host: '127.0.0.1',
  port: 0,
  auth: bearerAuth,
});
shop.registerTools([listMyOrders, cancelOrder]);
await shop.start();
const shopUrl = \`http://127.0.0.1:\${shop.getPort()}/mcp\`;

const cog = new Cogitator({
  llm: { providers: { google: { apiKey } } },
  memory: { adapter: 'memory' },
});
const support = new Agent({
  name: 'support',
  model: 'google/gemini-3.5-flash-lite',
  instructions: "You are a shop's support agent. Use the tools to look up and change orders. Be brief.",
  temperature: 0.2,
});

const clients: MCPClient[] = [];

/** The support agent with the shop's tools, acting with this user's own token. */
async function supportFor(token: string): Promise<Agent> {
  const client = await MCPClient.connect({
    transport: 'http',
    url: shopUrl,
    headers: { Authorization: \`Bearer \${token}\` },
  });
  clients.push(client);
  return support.clone({ id: support.id, tools: await client.getTools() });
}

try {
  const forAlice = await supportFor('tok-alice-7f3a');
  const forBob = await supportFor('tok-bob-91c2');

  const alice = await cog.run(forAlice, { input: 'What did I order?', userId: 'alice', threadId: 'chat-alice' });
  console.log('Alice:', alice.output);

  const cancel = await cog.run(forBob, {
    input: 'Please cancel the order that has not shipped yet.',
    userId: 'bob',
    threadId: 'chat-bob',
  });
  console.log('Bob:', cancel.output, \`(B-2001 is now \${ordersByUser.bob[0].status})\`);

  try {
    await cog.run(forBob, { input: 'What did we talk about?', userId: 'bob', threadId: 'chat-alice' });
  } catch (error) {
    if (!(error instanceof CogitatorError && error.code === ErrorCode.THREAD_ACCESS_DENIED)) throw error;
    console.log(\`Refused: \${error.message} (HTTP \${error.statusCode})\`);
  }
} finally {
  await Promise.all(clients.map((client) => client.close()));
  await shop.stop();
  await cog.close();
}`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/mcp zod',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx per-user-mcp.ts',
      repoRun: 'npx tsx examples/mcp/03-per-user-mcp.ts',
      example: 'mcp/03-per-user-mcp.ts',
      docs: [
        {
          href: '/docs/integrations/mcp',
          label: 'MCP',
        },
        {
          href: '/docs/advanced/multi-user',
          label: 'Multi-User',
        },
      ],
    },
    {
      id: 'agent-as-mcp-server',
      title: 'Agent as an MCP Tool',
      difficulty: 'easy',
      time: '5 min',
      problem:
        'You want your whole agent — not just its tools — callable from an MCP client, with follow-up questions in the same thread.',
      points: [
        'Serve agents with `serveAgents()`',
        'Continue a conversation by passing the returned `threadId`',
      ],
      file: 'agent-as-mcp-server.ts',
      code: `import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { MCPClient, serveAgents } from '@cogitator-ai/mcp';
import { z } from 'zod';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const rates: Record<string, number> = { EUR: 0.92, GBP: 0.79, JPY: 151.3 };

const convert = tool({
  name: 'convert_currency',
  description: 'Convert an amount of US dollars into another currency.',
  parameters: z.object({
    amount: z.number().describe('Amount in USD'),
    to: z.enum(['EUR', 'GBP', 'JPY']).describe('Target currency'),
  }),
  execute: async ({ amount, to }) => ({ amount: Math.round(amount * rates[to] * 100) / 100, currency: to }),
});

const cog = new Cogitator({
  llm: { providers: { google: { apiKey } } },
  memory: { adapter: 'memory' },
});

const travel = new Agent({
  name: 'travel_planner',
  description: 'Plans trips and budgets, converting prices between currencies.',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You plan trips. Use convert_currency for currency questions. Two sentences at most.',
  tools: [convert],
  temperature: 0.2,
});

const server = await serveAgents(cog, travel, { transport: 'http', host: '127.0.0.1', port: 0 });
const client = await MCPClient.connect({
  transport: 'http',
  url: \`http://127.0.0.1:\${server.getPort()}/mcp\`,
});

try {
  const first = (await client.callTool('travel_planner', {
    task: 'My hotel in Lisbon costs $180 a night. How much is that in euros?',
  })) as { output: string; threadId: string };
  console.log(first.output);

  const followUp = (await client.callTool('travel_planner', {
    task: 'And for 4 nights?',
    threadId: first.threadId,
  })) as { output: string };
  console.log(followUp.output);
} finally {
  await client.close();
  await server.stop();
  await cog.close();
}`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/mcp zod',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx agent-as-mcp-server.ts',
      repoRun: 'npx tsx examples/mcp/04-agent-as-mcp-server.ts',
      notes: [
        {
          type: 'tip',
          text: 'For Claude Desktop or Cursor call `serveAgents(cog, [travel])` without options to serve over stdio, and point the client’s MCP config at `npx tsx my-agents.ts`.',
        },
      ],
      example: 'mcp/04-agent-as-mcp-server.ts',
      docs: [
        {
          href: '/docs/integrations/mcp',
          label: 'MCP',
        },
      ],
    },
    {
      id: 'a2a-server',
      title: 'A2A Server',
      difficulty: 'medium',
      time: '10 min',
      problem:
        'Other teams’ agents should discover and call your agent through the Agent-to-Agent protocol.',
      points: [
        'Wrap agents in `A2AServer` and mount it on Express with `a2aExpress()`',
        'Publish the agent card',
      ],
      file: 'a2a-server.ts',
      code: `import { A2AServer } from '@cogitator-ai/a2a';
import { a2aExpress } from '@cogitator-ai/a2a/express';
import { Agent, Cogitator } from '@cogitator-ai/core';
import express from 'express';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const PORT = 3100;

const writingAssistant = new Agent({
  name: 'writing-assistant',
  description: 'Improves text, suggests edits and answers questions about writing.',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are a professional writing assistant. Keep responses concise and actionable.',
  temperature: 0.5,
  maxIterations: 3,
});

const a2a = new A2AServer({
  agents: { 'writing-assistant': writingAssistant },
  cogitator: new Cogitator({ llm: { providers: { google: { apiKey } } } }),
  cardUrl: \`http://localhost:\${PORT}\`,
});

const app = express();
app.use(a2aExpress(a2a));

app.listen(PORT, () => {
  console.log(JSON.stringify(a2a.getAgentCard(), null, 2));
  console.log(\`Agent card:   http://localhost:\${PORT}/.well-known/agent.json\`);
  console.log(\`RPC endpoint: http://localhost:\${PORT}/a2a\`);
});`,
      install: 'pnpm add @cogitator-ai/a2a @cogitator-ai/core express',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx a2a-server.ts',
      repoRun: 'npx tsx examples/a2a/01-a2a-server.ts',
      extra: [
        {
          title: 'Try it',
          language: 'bash',
          code: `curl http://localhost:3100/.well-known/agent.json`,
        },
      ],
      example: 'a2a/01-a2a-server.ts',
      docs: [
        {
          href: '/docs/integrations/a2a',
          label: 'A2A',
        },
      ],
    },
    {
      id: 'a2a-client',
      title: 'A2A Client',
      difficulty: 'medium',
      time: '10 min',
      problem: 'Your agent should delegate to a remote A2A agent as if it were a local tool.',
      points: [
        'Read the agent card and send a message with `A2AClient`',
        'Turn the remote agent into a tool with `asTool()`',
      ],
      file: 'a2a-client.ts',
      code: `import { A2AClient } from '@cogitator-ai/a2a';
import { Agent, Cogitator } from '@cogitator-ai/core';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const client = new A2AClient('http://localhost:3100');

const card = await client.agentCard();
console.log(\`\${card.name}: \${card.description} (streaming: \${card.capabilities.streaming})\`);

const task = await client.sendMessage({
  role: 'user',
  parts: [{ type: 'text', text: 'Make this concise: "In my personal opinion, I think it is very cold today."' }],
});
console.log('Task', task.id, task.status.state);
const reply = task.artifacts[0]?.parts.find((part) => part.type === 'text');
if (reply?.type === 'text') console.log(reply.text);

const fetched = await client.getTask(task.id);
console.log('History length:', fetched.history.length);

const orchestrator = new Agent({
  name: 'orchestrator',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'Delegate writing tasks to the writing_assistant tool. Forward the request as-is.',
  tools: [
    client.asTool({
      name: 'writing_assistant',
      description: 'Remote writing assistant reachable over A2A',
    }),
  ],
  maxIterations: 3,
});

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });
const result = await cog.run(orchestrator, {
  input: 'Fix the grammar: "Me and him goes to the store yesterday for buy some foods."',
});
console.log(result.output);

await cog.close();`,
      install: 'pnpm add @cogitator-ai/a2a @cogitator-ai/core',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx a2a-client.ts',
      repoRun: 'npx tsx examples/a2a/02-a2a-client.ts',
      runNote: 'Start the A2A server recipe first; the client talks to http://localhost:3100.',
      example: 'a2a/02-a2a-client.ts',
      docs: [
        {
          href: '/docs/integrations/a2a',
          label: 'A2A',
        },
      ],
    },
  ],
};
