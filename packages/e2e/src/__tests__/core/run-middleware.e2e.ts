import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { Agent, Cogitator, isTripwire, tool, tripwire } from '@cogitator-ai/core';
import { ErrorCode, type RunMiddleware } from '@cogitator-ai/types';
import { startFakeOllama, type FakeMessage, type FakeOllama } from '../../helpers/fake-ollama';
import { createTestCogitator, getTestModel, ollamaSkipReason } from '../../helpers/setup';

const MODEL = 'qwen2.5:0.5b';

let fake: FakeOllama | undefined;
let cogitator: Cogitator | undefined;

afterEach(async () => {
  await cogitator?.close();
  await fake?.close();
  cogitator = undefined;
  fake = undefined;
});

const executed: unknown[] = [];

const lookup = tool({
  name: 'lookup',
  description: 'Look an order up',
  parameters: z.object({ order: z.string(), region: z.string().default('eu') }),
  execute: async (args) => {
    executed.push(args);
    return { ...args, status: 'shipped' };
  },
});

function callsLookup(order: string) {
  return (messages: FakeMessage[]) =>
    messages.some((m) => m.role === 'tool')
      ? { content: `Order ${order} has shipped. Contact ops@northwind.io for help.` }
      : { toolCalls: [{ name: 'lookup', arguments: { order } }] };
}

async function fakeCogitator(
  reply: Parameters<typeof startFakeOllama>[0],
  config: ConstructorParameters<typeof Cogitator>[0] = {}
): Promise<Cogitator> {
  fake = await startFakeOllama(reply, [MODEL]);
  cogitator = new Cogitator({
    llm: { providers: { ollama: { baseUrl: fake.url } } },
    ...config,
  });
  return cogitator;
}

const agent = (middleware: RunMiddleware[]) =>
  new Agent({
    name: 'support',
    model: `ollama/${MODEL}`,
    instructions: 'Help with orders.',
    tools: [lookup],
    middleware,
  });

describe('Core: run middleware over the Ollama API', () => {
  it('lets middleware change what reaches the model, the tools and the caller', async () => {
    executed.length = 0;
    const cog = await fakeCogitator(callsLookup('A-7'));
    const hooks: string[] = [];
    const policy: RunMiddleware = {
      name: 'policy',
      beforeModel: (_event, context) => void hooks.push(`beforeModel:${context.iteration}`),
      wrapModelCall: (call, next) =>
        next({
          ...call,
          request: {
            ...call.request,
            messages: [...call.request.messages, { role: 'system', content: 'Be brief.' }],
          },
        }),
      wrapToolCall: (call, next) =>
        next({
          ...call,
          toolCall: { ...call.toolCall, arguments: { order: 'A-7', region: 'us' } },
        }),
      afterModel: ({ response }) => ({
        content: response.content.replace(/[\w.]+@[\w.]+/g, '[email]'),
      }),
    };

    const result = await cog.run(agent([policy]), { input: 'Where is A-7?' });

    expect(hooks).toEqual(['beforeModel:1', 'beforeModel:2']);
    expect(executed).toEqual([{ order: 'A-7', region: 'us' }]);
    expect(result.output).toBe('Order A-7 has shipped. Contact [email] for help.');
    expect(fake!.requests).toHaveLength(2);
    for (const request of fake!.requests) {
      expect(request.messages.at(-1)).toMatchObject({ role: 'system', content: 'Be brief.' });
    }
  });

  it('stops the run with a tripwire before the model is called', async () => {
    const cog = await fakeCogitator(callsLookup('A-7'), { memory: { adapter: 'memory' } });
    const guard: RunMiddleware = {
      name: 'refund-guard',
      beforeRun: ({ input }) => {
        if (/refund/i.test(input)) tripwire('Refunds go to a person', { queue: 'billing' });
      },
    };

    const error = await cog
      .run(agent([guard]), { input: 'Refund my order', threadId: 'thread_refund' })
      .catch((e: unknown) => e);

    expect(isTripwire(error)).toBe(true);
    expect(error).toMatchObject({
      code: ErrorCode.GUARDRAIL_TRIPPED,
      details: { middleware: 'refund-guard', info: { queue: 'billing' } },
    });
    expect(fake!.requests).toHaveLength(0);
    const entries = await cog.memory!.getEntries({ threadId: 'thread_refund' });
    expect(entries.data ?? []).toHaveLength(0);
  });

  it('masks personal data with the built-in middleware while streaming the real values back', async () => {
    const cog = await fakeCogitator(
      (messages) => ({
        content: `Noted ${/\[EMAIL_\d+\]/.exec(messages.at(-1)?.content ?? '')?.[0] ?? 'nothing'}.`,
      }),
      { security: { pii: {} } }
    );
    const tokens: string[] = [];

    const result = await cog.run(agent([]), {
      input: 'My email is maria.lopez@northwind-bank.io',
      stream: true,
      onToken: (token) => tokens.push(token),
    });

    expect(JSON.stringify(fake!.requests)).not.toContain('maria.lopez');
    expect(tokens.join('')).toBe('Noted maria.lopez@northwind-bank.io.');
    expect(result.output).toBe('Noted maria.lopez@northwind-bank.io.');
  });
});

const describeOllama = describe.skipIf((await ollamaSkipReason()) !== null);

describeOllama('Core: run middleware on a real model', () => {
  it('wraps the real model call and rewrites its answer', { timeout: 120_000 }, async () => {
    cogitator = createTestCogitator();
    const models: string[] = [];
    const reviewed: RunMiddleware = {
      name: 'reviewed',
      wrapModelCall: (call, next) => {
        models.push(call.model);
        return next(call);
      },
      afterModel: ({ response }) => ({ content: `[reviewed] ${response.content}` }),
    };
    const plain = new Agent({
      name: 'plain',
      model: `ollama/${getTestModel()}`,
      instructions: 'Answer in one short sentence.',
      middleware: [reviewed],
    });

    const result = await cogitator.run(plain, { input: 'What color is the sky on a clear day?' });

    expect(models).toEqual([`ollama/${getTestModel()}`]);
    expect(result.output.startsWith('[reviewed] ')).toBe(true);
    expect(result.output.length).toBeGreaterThan('[reviewed] '.length);
  });
});
