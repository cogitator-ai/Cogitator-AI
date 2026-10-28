import { createCogitator, header, section } from '../_shared/setup.js';
import { HttpAgent } from '@ag-ui/client';
import { Agent, tool } from '@cogitator-ai/core';
import { CogitatorServer } from '@cogitator-ai/express';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';

const MODEL = process.env.EXAMPLE_MODEL ?? `ollama/${process.env.OLLAMA_MODEL ?? 'qwen2.5:0.5b'}`;

interface Cart {
  items: string[];
}

function cartOf(state: unknown): Cart {
  return typeof state === 'object' && state !== null && 'items' in state
    ? { items: (state as Cart).items }
    : { items: [] };
}

const addToCart = tool({
  name: 'add_to_cart',
  description: 'Adds an item to the shopping cart. Asks the user for the size first.',
  parameters: z.object({ item: z.string().describe('What to add, such as "shirt"') }),
  execute: async ({ item }, context) => {
    const size = await context.interrupt?.({
      reason: 'pick_size',
      message: `Which size of ${item}?`,
      responseSchema: z.enum(['S', 'M', 'L']),
    });
    const cart = cartOf(context.state?.get());
    const items = [...cart.items, `${item} (${String(size)})`];
    context.state?.set({ items });
    context.data?.({ id: 'receipt', name: 'receipt', data: { items, count: items.length } });
    return { added: item, size };
  },
});

const shop = new Agent({
  name: 'shop',
  model: MODEL,
  instructions:
    'You run a clothing shop. When the user wants an item, call add_to_cart with it right away: never ask for the size yourself, the tool asks. Then confirm in one short sentence.',
  tools: [addToCart],
  temperature: 0,
});

const cogitator = createCogitator({ memory: { adapter: 'memory' } });
const app = express();
const server = new CogitatorServer({
  app,
  cogitator,
  agents: { shop },
  config: { basePath: '/cogitator', enableSwagger: false },
});
await server.init();

const listening = app.listen(0, '127.0.0.1');
await new Promise((resolve) => listening.once('listening', resolve));
const { port } = listening.address() as AddressInfo;
const url = `http://127.0.0.1:${port}/cogitator/agents/shop/agui`;

header('AG-UI endpoint');
console.log(`POST ${url}`);

const agent = new HttpAgent({ url, threadId: `shop_${Date.now()}`, initialState: { items: [] } });
const printEvents = {
  onEvent: ({ event }: { event: { type: string; message?: unknown } }) =>
    console.log(`  ${event.type}${event.type === 'RUN_ERROR' ? `: ${String(event.message)}` : ''}`),
};

section('Run: the tool asks for a size');
agent.addMessage({ id: 'u1', role: 'user', content: 'I would like a shirt, please.' });
await agent.runAgent({}, printEvents);

const pending = agent.pendingInterrupts;
console.log('\nInterrupts:', pending.map((entry) => `${entry.id}: ${entry.message}`).join(', '));

if (pending.length > 0) {
  section('Resume: answer every interrupt at once');
  await agent.runAgent(
    {
      resume: pending.map((entry) => ({
        interruptId: entry.id,
        status: 'resolved' as const,
        payload: entry.toolCallId ? 'M' : { approved: true },
      })),
    },
    printEvents
  );
}

section('What the client holds');
console.log('State:', JSON.stringify(agent.state));
for (const message of agent.messages) {
  const content = 'content' in message ? message.content : '';
  console.log(
    `  ${message.role}: ${typeof content === 'string' ? content : JSON.stringify(content)}`
  );
}

listening.close();
await cogitator.close();
