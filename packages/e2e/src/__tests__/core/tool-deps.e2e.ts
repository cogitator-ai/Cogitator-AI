import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { Agent, Cogitator, tool, type Tool, type ToolContext } from '@cogitator-ai/core';
import { startFakeOllama, type FakeMessage, type FakeOllama } from '../../helpers/fake-ollama';

const MODEL = 'qwen2.5:0.5b';
const SECRET = 'sk_live_e2e_deps_never_reach_the_model';

interface ShopDeps {
  apiKey: string;
  orders: Map<string, string>;
}

let fake: FakeOllama | undefined;
let cogitator: Cogitator | undefined;

afterEach(async () => {
  await cogitator?.close();
  await fake?.close();
  cogitator = undefined;
  fake = undefined;
});

const seen: ShopDeps[] = [];

const orderStatus = tool({
  name: 'order_status',
  description: 'Status of an order',
  parameters: z.object({ id: z.string() }),
  execute: async ({ id }, { deps }: ToolContext<ShopDeps>) => {
    seen.push(deps);
    if (deps.apiKey !== SECRET) throw new Error('unauthorized');
    return { id, status: deps.orders.get(id) ?? 'unknown' };
  },
});

const cancelOrder = tool({
  name: 'cancel_order',
  description: 'Cancel an order',
  parameters: z.object({ id: z.string() }),
  requiresApproval: true,
  execute: async ({ id }, { deps }: ToolContext<ShopDeps>) => {
    seen.push(deps);
    deps.orders.set(id, 'cancelled');
    return { id, cancelled: true };
  },
});

function callsOnce(name: string, args: Record<string, unknown>) {
  return (messages: FakeMessage[]) =>
    messages.some((m) => m.role === 'tool')
      ? {
          content: `Done: ${messages
            .filter((m) => m.role === 'tool')
            .map((m) => m.content)
            .join(' ')}`,
        }
      : { toolCalls: [{ name, arguments: args }] };
}

async function fakeCogitator(reply: Parameters<typeof startFakeOllama>[0]): Promise<Cogitator> {
  fake = await startFakeOllama(reply, [MODEL]);
  cogitator = new Cogitator({
    llm: { providers: { ollama: { baseUrl: fake.url } } },
    memory: { adapter: 'memory' },
  });
  return cogitator;
}

const shop = (tools: Tool<unknown, unknown, ShopDeps>[] = [orderStatus]) =>
  new Agent<ShopDeps>({
    name: 'shop',
    model: `ollama/${MODEL}`,
    instructions: 'Help with orders.',
    tools,
  });

describe('Core: tool deps over the Ollama API', () => {
  it('gives tools the run deps and never sends them to the model', async () => {
    seen.length = 0;
    const cog = await fakeCogitator(callsOnce('order_status', { id: 'A-7' }));
    const deps: ShopDeps = { apiKey: SECRET, orders: new Map([['A-7', 'shipped']]) };

    const result = await cog.run(shop(), { input: 'Where is A-7?', deps });

    expect(seen).toEqual([deps]);
    expect(result.output).toContain('shipped');
    expect(fake!.requests.length).toBe(2);
    expect(JSON.stringify(fake!.requests)).not.toContain(SECRET);
    const entries = await cog.memory!.getEntries({ threadId: result.threadId });
    expect(JSON.stringify(entries)).not.toContain(SECRET);
  });

  it('keeps deps out of a paused run and takes them again on resume', async () => {
    seen.length = 0;
    const cog = await fakeCogitator(callsOnce('cancel_order', { id: 'B-2' }));
    const agent = shop([cancelOrder]);
    const orders = new Map([['B-2', 'packing']]);

    const paused = await cog.run(agent, { input: 'Cancel B-2', deps: { apiKey: SECRET, orders } });

    expect(paused.status).toBe('paused');
    expect(JSON.stringify(paused.checkpoint)).not.toContain(SECRET);
    expect(seen).toEqual([]);

    const resumed = await cog.resume(agent, paused.checkpoint!, {
      decisions: { [paused.pendingApprovals![0].toolCallId]: { approved: true } },
      deps: { apiKey: SECRET, orders },
    });

    expect(resumed.status).not.toBe('paused');
    expect(orders.get('B-2')).toBe('cancelled');
    expect(JSON.stringify(fake!.requests)).not.toContain(SECRET);
  });
});
