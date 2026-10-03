import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent, CogitatorError, ErrorCode, tool } from '@cogitator-ai/core';
import { MCPClient, MCPServer, type MCPAuthFunction } from '@cogitator-ai/mcp';
import { z } from 'zod';

interface Order {
  id: string;
  item: string;
  status: 'processing' | 'shipped' | 'cancelled';
}

const accessTokens: Record<string, string> = {
  'tok-alice-7f3a': 'alice',
  'tok-bob-91c2': 'bob',
};

const ordersByUser: Record<string, Order[]> = {
  alice: [{ id: 'A-1001', item: 'standing desk', status: 'shipped' }],
  bob: [
    { id: 'B-2001', item: 'mechanical keyboard', status: 'processing' },
    { id: 'B-2002', item: 'USB-C dock', status: 'shipped' },
  ],
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
  parameters: z.object({ orderId: z.string().describe('Order id, e.g. "B-2001"') }),
  execute: async ({ orderId }, context) => {
    const order = ordersByUser[context.userId ?? '']?.find((o) => o.id === orderId);
    if (!order) throw new Error(`No order ${orderId} for this customer`);
    if (order.status !== 'processing') throw new Error(`Order ${orderId} has already shipped`);
    order.status = 'cancelled';
    return order;
  },
});

async function main() {
  header('03 — An Agent on Your Own MCP Server, per User');

  section('1. The shop exposes its API as an MCP server with bearer tokens');

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
  const shopUrl = `http://127.0.0.1:${shop.getPort()}/mcp`;
  console.log(`  MCP server: ${shopUrl}`);

  const cog = createCogitator({ memory: { adapter: 'memory' } });
  const support = new Agent({
    name: 'support',
    model: DEFAULT_MODEL,
    instructions:
      "You are the support agent of an online shop. Use the tools to look up and change the customer's orders. Answer briefly.",
    temperature: 0.2,
  });

  const clients: MCPClient[] = [];

  /** The support agent with the shop's tools, acting with this user's own token. */
  async function supportFor(token: string): Promise<Agent> {
    const client = await MCPClient.connect({
      transport: 'http',
      url: shopUrl,
      headers: { Authorization: `Bearer ${token}` },
    });
    clients.push(client);
    return support.clone({ id: support.id, tools: await client.getTools() });
  }

  try {
    section('2. Each customer talks to the agent with their own token and thread');

    const forAlice = await supportFor('tok-alice-7f3a');
    const forBob = await supportFor('tok-bob-91c2');

    const alice = await cog.run(forAlice, {
      input: 'What did I order?',
      userId: 'alice',
      threadId: 'chat-alice',
    });
    console.log(`  Alice: ${alice.output.trim()}`);

    const bob = await cog.run(forBob, {
      input: 'What did I order?',
      userId: 'bob',
      threadId: 'chat-bob',
    });
    console.log(`  Bob:   ${bob.output.trim()}`);

    section('3. Tool calls act for the user whose token the agent holds');

    const cancel = await cog.run(forBob, {
      input: 'Please cancel the order that has not shipped yet.',
      userId: 'bob',
      threadId: 'chat-bob',
    });
    console.log(`  Bob:   ${cancel.output.trim()}`);
    console.log(
      `  Tools: ${cancel.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.arguments)})`).join(', ')}`
    );
    console.log(`  B-2001 is now: ${ordersByUser.bob[0].status}`);

    section("4. Nobody continues someone else's conversation");

    try {
      await cog.run(forBob, {
        input: 'Remind me what we talked about.',
        userId: 'bob',
        threadId: 'chat-alice',
      });
    } catch (error) {
      if (error instanceof CogitatorError && error.code === ErrorCode.THREAD_ACCESS_DENIED) {
        console.log(`  Refused: ${error.message} (HTTP ${error.statusCode})`);
      } else {
        throw error;
      }
    }

    section('5. The MCP server refuses a token it does not know');

    try {
      await MCPClient.connect({
        transport: 'http',
        url: shopUrl,
        headers: { Authorization: 'Bearer tok-stolen' },
      });
    } catch (error) {
      console.log(`  Refused: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await shop.stop();
    await cog.close();
  }

  console.log('\nDone.');
}

main();
