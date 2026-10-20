import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  Span,
  Tool,
  ToolCall,
  ToolContext,
} from '@cogitator-ai/types';
import { z } from 'zod';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { agentAsTool } from '../agent-tool';

const SECRET = 'sk_live_deps_must_stay_out_of_the_model';

interface AppDeps {
  orders: { lookup(id: string): { id: string; status: string } };
  apiKey: string;
}

function appDeps(status = 'shipped'): AppDeps {
  return { orders: { lookup: (id) => ({ id, status }) }, apiKey: SECRET };
}

const seenDeps: unknown[] = [];

const lookupOrder = tool({
  name: 'lookup_order',
  description: 'Look an order up',
  parameters: z.object({ id: z.string() }),
  execute: async ({ id }, { deps }: ToolContext<AppDeps>) => {
    seenDeps.push(deps);
    return deps.orders.lookup(id);
  },
});

const refundOrder = tool({
  name: 'refund_order',
  description: 'Refund an order',
  parameters: z.object({ id: z.string() }),
  requiresApproval: true,
  execute: async ({ id }, { deps }: ToolContext<AppDeps>) => {
    seenDeps.push(deps);
    return { refunded: deps.orders.lookup(id).id };
  },
});

/** A model that calls `call` once, then answers with what the tool returned. */
function callingBackend(call: ToolCall) {
  const requests: ChatRequest[] = [];
  const respond = (request: ChatRequest): ChatResponse => {
    requests.push(request);
    const results = request.messages.filter((m) => m.role === 'tool');
    if (results.length === 0) {
      return {
        id: 'r1',
        content: '',
        toolCalls: [call],
        finishReason: 'tool_calls',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    }
    return {
      id: 'r2',
      content: `Done: ${results.map((m) => String(m.content)).join(' | ')}`,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  };
  const backend: LLMBackend = {
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest) => respond(request)),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    }),
  };
  return { backend, requests };
}

function support(tools: Tool<unknown, unknown, AppDeps>[] = [lookupOrder]) {
  return new Agent<AppDeps>({
    id: 'support',
    name: 'support',
    model: 'mock/m',
    instructions: 'Help with orders.',
    tools,
  });
}

describe('run deps', () => {
  it('reach the tools of the run', async () => {
    seenDeps.length = 0;
    const { backend } = callingBackend({
      id: 'c1',
      name: 'lookup_order',
      arguments: { id: 'A-1' },
    });
    const cog = new Cogitator({ llm: { backends: { mock: backend } } });
    const deps = appDeps();

    const result = await cog.run(support(), { input: 'Where is A-1?', deps });

    expect(seenDeps).toEqual([deps]);
    expect(seenDeps[0]).toBe(deps);
    expect(result.output).toContain('shipped');
  });

  it('stay out of the model, the memory and the spans', async () => {
    const { backend, requests } = callingBackend({
      id: 'c1',
      name: 'lookup_order',
      arguments: { id: 'A-1' },
    });
    const cog = new Cogitator({
      llm: { backends: { mock: backend } },
      memory: { adapter: 'memory' },
    });
    const spans: Span[] = [];

    const result = await cog.run(support(), {
      input: 'Where is A-1?',
      deps: appDeps(),
      onSpan: (span) => spans.push(span),
    });

    expect(requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(requests.map((r) => r.messages))).not.toContain(SECRET);
    const entries = await cog.memory!.getEntries({ threadId: result.threadId });
    expect(entries.success).toBe(true);
    expect(JSON.stringify(entries)).not.toContain(SECRET);
    expect(JSON.stringify(spans)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('stay out of a paused run, and a resumed run takes them again', async () => {
    seenDeps.length = 0;
    const { backend } = callingBackend({
      id: 'c1',
      name: 'refund_order',
      arguments: { id: 'A-1' },
    });
    const cog = new Cogitator({ llm: { backends: { mock: backend } } });
    const agent = support([refundOrder]);

    const paused = await cog.run(agent, { input: 'Refund A-1', deps: appDeps() });

    expect(paused.status).toBe('paused');
    const checkpoint = paused.checkpoint;
    expect(JSON.stringify(checkpoint)).not.toContain(SECRET);
    expect(seenDeps).toEqual([]);

    const resumedDeps = appDeps('refunded');
    const resumed = await cog.resume(agent, JSON.parse(JSON.stringify(checkpoint)), {
      decisions: { c1: { approved: true } },
      deps: resumedDeps,
    });

    expect(resumed.status).not.toBe('paused');
    expect(seenDeps).toEqual([resumedDeps]);
    expect(seenDeps[0]).toBe(resumedDeps);
  });

  it('reach the tools of an agent the run hands over to', async () => {
    seenDeps.length = 0;
    const specialist = support();
    const triage = new Agent<AppDeps>({
      name: 'triage',
      model: 'mock/m',
      instructions: 'Route.',
      handoffs: [specialist],
    });
    let turn = 0;
    const backend: LLMBackend = {
      provider: 'openai',
      chat: vi.fn(async (): Promise<ChatResponse> => {
        turn++;
        const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
        if (turn === 1) {
          return {
            id: 'h',
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'h1', name: 'transfer_to_support', arguments: {} }],
            usage,
          };
        }
        if (turn === 2) {
          return {
            id: 'l',
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'c1', name: 'lookup_order', arguments: { id: 'B-2' } }],
            usage,
          };
        }
        return { id: 'a', content: 'It shipped.', finishReason: 'stop', usage };
      }),
      chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {}),
    };
    const cog = new Cogitator({ llm: { backends: { mock: backend } } });
    const deps = appDeps();

    await cog.run(triage, { input: 'Where is B-2?', deps });

    expect(seenDeps).toEqual([deps]);
  });

  it('reach the tools of an agent run as a tool', async () => {
    seenDeps.length = 0;
    const { backend } = callingBackend({
      id: 'c1',
      name: 'lookup_order',
      arguments: { id: 'A-1' },
    });
    const cog = new Cogitator({ llm: { backends: { mock: backend } } });
    const delegate = agentAsTool(cog, support(), { name: 'ask_support', description: 'Ask' });
    const deps = appDeps();

    const result = await delegate.execute(
      { task: 'Where is A-1?' },
      { agentId: 'lead', runId: 'run_1', signal: new AbortController().signal, deps }
    );

    expect(result.success).toBe(true);
    expect(seenDeps).toEqual([deps]);
  });

  it('reach a tool invoked outside a run', async () => {
    seenDeps.length = 0;
    const cog = new Cogitator();
    const deps = appDeps();

    const result = await cog.invokeTool(lookupOrder, { id: 'C-3' }, { deps });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ id: 'C-3', status: 'shipped' });
    expect(seenDeps).toEqual([deps]);
  });

  it('leave a run without deps as it was', async () => {
    const seen: unknown[] = [];
    const echo = tool({
      name: 'echo',
      description: 'Echo',
      parameters: z.object({}),
      execute: async (_params, context) => {
        seen.push(context.deps);
        return 'ok';
      },
    });
    const { backend } = callingBackend({ id: 'c1', name: 'echo', arguments: {} });
    const cog = new Cogitator({ llm: { backends: { mock: backend } } });
    const agent = new Agent({
      name: 'plain',
      model: 'mock/m',
      instructions: 'Echo.',
      tools: [echo],
    });

    await cog.run(agent, { input: 'Echo' });

    expect(seen).toEqual([undefined]);
  });

  it('are typed from the agent to its tools and runs', () => {
    expectTypeOf(lookupOrder.execute).parameter(1).toHaveProperty('deps');
    const plain = tool({
      name: 'plain',
      description: 'Plain',
      parameters: z.object({}),
      execute: async () => 'ok',
    });
    const mailer = tool({
      name: 'mail',
      description: 'Mail',
      parameters: z.object({}),
      execute: async (_p, { deps }: ToolContext<{ smtp: string }>) => deps.smtp,
    });
    const typed = new Agent<AppDeps>({
      name: 't',
      instructions: 'T.',
      tools: [plain, lookupOrder],
    });
    const untyped: Agent = typed;
    const cog = new Cogitator();

    expect(untyped.name).toBe('t');
    expect(
      () =>
        new Agent<AppDeps>({
          name: 'wrong',
          instructions: 'W.',
          // @ts-expect-error the agent does not provide the tool's deps
          tools: [mailer],
        })
    ).not.toThrow();
    const check = (run: () => unknown) => run;
    check(() =>
      // @ts-expect-error a typed agent's run needs deps
      cog.run(typed, { input: 'x' })
    );
    check(() =>
      // @ts-expect-error deps of another type
      cog.run(typed, { input: 'x', deps: { smtp: 'host' } })
    );
    check(() =>
      // @ts-expect-error a typed agent's resume needs deps
      cog.resume(typed, 'thread_1')
    );
    check(() =>
      cog.run(new Agent({ name: 'u', instructions: 'U.', tools: [plain] }), { input: 'x' })
    );
  });
});
