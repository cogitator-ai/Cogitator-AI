import { header, section } from '../_shared/setup.js';
import { z } from 'zod';
import { Agent, Cogitator, tool, type ToolContext } from '@cogitator-ai/core';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:0.5b';

async function ollamaIsUp(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

interface Order {
  id: string;
  status: string;
}

class OrderStore {
  constructor(private readonly orders: Record<string, Order[]>) {}

  forUser(userId: string): Order[] {
    return this.orders[userId] ?? [];
  }
}

interface ShopDeps {
  store: OrderStore;
  userId: string;
}

const listOrders = tool({
  name: 'list_orders',
  description: "List the signed-in customer's orders with their status",
  parameters: z.object({}),
  execute: async (_params, { deps }: ToolContext<ShopDeps>) => deps.store.forUser(deps.userId),
});

async function main() {
  header('20 - Tool deps: per-request values for tools, never shown to the model');

  if (!(await ollamaIsUp())) {
    console.error(`  Ollama is not answering at ${OLLAMA_URL}.`);
    console.error(`  Start it with \`ollama serve\` and pull the model: ollama pull ${MODEL}\n`);
    process.exit(1);
  }

  const cog = new Cogitator({ llm: { providers: { ollama: { baseUrl: OLLAMA_URL } } } });
  const store = new OrderStore({
    alice: [{ id: 'A-1', status: 'shipped' }],
    bob: [{ id: 'B-7', status: 'packing' }],
  });

  const agent = new Agent<ShopDeps>({
    name: 'shop',
    model: `ollama/${MODEL}`,
    instructions:
      'You answer questions about orders. You do not know any order until you call the ' +
      'list_orders tool, so call it before every answer and report what it returns.',
    tools: [listOrders],
  });

  for (const userId of ['alice', 'bob']) {
    section(`A request from ${userId}`);
    const result = await cog.run(agent, {
      input: 'Check my orders with list_orders and tell me their status.',
      deps: { store, userId },
      toolChoice: 'required',
      onToolResult: ({ result: orders }) =>
        console.log(`  list_orders -> ${JSON.stringify(orders)}`),
    });
    console.log(`  ${result.output.trim()}`);
  }

  section('The same tool outside a run');
  const direct = await cog.invokeTool(listOrders, {}, { deps: { store, userId: 'alice' } });
  console.log(`  ${JSON.stringify(direct.result)}`);

  await cog.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
