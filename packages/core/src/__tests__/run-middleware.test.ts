import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  CogitatorError,
  ErrorCode,
  type Tool,
  type ChatRequest,
  type ChatResponse,
  type ChatStreamChunk,
  type LLMBackend,
  type RunMiddleware,
  type RunMiddlewareContext,
} from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { agentAsTool } from '../agent-tool';
import { Agent } from '../agent';
import { tool } from '../tool';
import { isTripwire, piiMiddleware, tripwire } from '../middleware/index';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function answer(content: string): ChatResponse {
  return { id: 'r', content, finishReason: 'stop', usage };
}

function callTool(name: string, args: Record<string, unknown>, id = 'c1'): ChatResponse {
  return {
    id: 'r',
    content: '',
    toolCalls: [{ id, name, arguments: args }],
    finishReason: 'tool_calls',
    usage,
  };
}

/** A backend answering each request with the next response, streaming its text in three-character pieces. */
function scripted(...responses: ChatResponse[]) {
  const requests: ChatRequest[] = [];
  let index = 0;
  const next = () => responses[Math.min(index++, responses.length - 1)];
  const backend: LLMBackend = {
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest) => {
      requests.push({ ...request, messages: [...request.messages] });
      return next();
    }),
    chatStream: vi.fn(async function* (request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
      requests.push({ ...request, messages: [...request.messages] });
      const response = next();
      for (const piece of response.content.match(/[\s\S]{1,3}/g) ?? []) {
        yield { id: 's', delta: { content: piece } };
      }
      if (response.toolCalls) {
        yield { id: 's', delta: { toolCalls: response.toolCalls } };
      }
      yield { id: 's', delta: {}, finishReason: response.finishReason, usage };
    }),
  };
  return { backend, requests };
}

function runtime(backend: LLMBackend, extra: ConstructorParameters<typeof Cogitator>[0] = {}) {
  return new Cogitator({ llm: { backends: { mock: backend } }, ...extra });
}

const lookup = tool({
  name: 'lookup',
  description: 'Look an order up',
  parameters: z.object({ order: z.string(), limit: z.number().default(5) }),
  execute: async ({ order, limit }) => ({ order, limit }),
});

function agentWith(middleware: RunMiddleware[] = [], tools: Tool[] = [lookup]) {
  return new Agent({
    name: 'support',
    model: 'mock/m',
    instructions: 'Help.',
    tools,
    middleware,
  });
}

describe('run middleware', () => {
  it('runs before hooks in order, nests wraps with the first outermost and runs afterModel in reverse', async () => {
    const events: string[] = [];
    const layer = (name: string): RunMiddleware => ({
      name,
      beforeRun: () => void events.push(`${name}.beforeRun`),
      beforeModel: () => void events.push(`${name}.beforeModel`),
      async wrapModelCall(call, next) {
        events.push(`${name}.wrap>`);
        const response = await next(call);
        events.push(`${name}.wrap<`);
        return response;
      },
      afterModel: () => void events.push(`${name}.afterModel`),
    });
    const { backend } = scripted(answer('Hi'));
    const cog = runtime(backend, { middleware: [layer('config')] });

    await cog.run(agentWith([layer('agent')]), { input: 'Hello', middleware: [layer('run')] });

    expect(events).toEqual([
      'config.beforeRun',
      'agent.beforeRun',
      'run.beforeRun',
      'config.beforeModel',
      'agent.beforeModel',
      'run.beforeModel',
      'config.wrap>',
      'agent.wrap>',
      'run.wrap>',
      'run.wrap<',
      'agent.wrap<',
      'config.wrap<',
      'run.afterModel',
      'agent.afterModel',
      'config.afterModel',
    ]);
    await cog.close();
  });

  it('gives every hook the run it works in, with state shared across hooks', async () => {
    const seen: RunMiddlewareContext[] = [];
    const record: RunMiddleware<{ tenant: string }> = {
      name: 'record',
      beforeRun(_event, context) {
        seen.push(context);
        context.state.set('started', true);
      },
      beforeModel: (_event, context) => void seen.push(context),
      async wrapToolCall(call, next, context) {
        seen.push(context);
        expect(context.state.get('started')).toBe(true);
        return next(call);
      },
    };
    const { backend } = scripted(callTool('lookup', { order: '42' }), answer('Found it'));
    const cog = runtime(backend);
    const agent = new Agent<{ tenant: string }>({
      name: 'support',
      model: 'mock/m',
      instructions: 'Help.',
      tools: [lookup],
      middleware: [record],
    });

    const result = await cog.run(agent, {
      input: 'Where is order 42?',
      threadId: 'thread_1',
      userId: 'user_1',
      channelType: 'web',
      deps: { tenant: 'acme' },
    });

    expect(seen.map((context) => context.iteration)).toEqual([0, 1, 1, 2]);
    for (const context of seen) {
      expect(context).toMatchObject({
        runId: result.runId,
        threadId: 'thread_1',
        agentId: agent.id,
        agentName: 'support',
        userId: 'user_1',
        channelType: 'web',
        deps: { tenant: 'acme' },
      });
      expect(context.signal).toBeInstanceOf(AbortSignal);
      expect(context.state).toBe(seen[0].state);
    }
    await cog.close();
  });

  describe('beforeRun', () => {
    it('stops a run with a tripwire before anything is saved or sent', async () => {
      const { backend } = scripted(answer('never'));
      const cog = runtime(backend, { memory: { adapter: 'memory' } });
      const guard: RunMiddleware = {
        name: 'topic-guard',
        beforeRun({ input, messages }) {
          expect(messages.at(-1)).toMatchObject({ role: 'user', content: input });
          if (input.includes('homework')) tripwire('Homework is off topic', { topic: 'homework' });
        },
      };

      const error = await cog
        .run(agentWith([guard]), { input: 'Do my homework', threadId: 't1' })
        .catch((e: unknown) => e);

      expect(isTripwire(error)).toBe(true);
      expect(error).toMatchObject({
        code: ErrorCode.GUARDRAIL_TRIPPED,
        statusCode: 400,
        message: 'Guardrail "topic-guard" tripped: Homework is off topic',
        details: {
          reason: 'Homework is off topic',
          middleware: 'topic-guard',
          info: { topic: 'homework' },
        },
      });
      expect(backend.chat).not.toHaveBeenCalled();
      expect(await cog.memory?.getEntries({ threadId: 't1' })).toMatchObject({
        success: true,
        data: [],
      });
      await cog.close();
    });

    it('is not called again when a paused run resumes', async () => {
      const beforeRun = vi.fn();
      const refund = tool({
        name: 'refund',
        description: 'Refund an order',
        parameters: z.object({ order: z.string() }),
        requiresApproval: true,
        execute: async ({ order }) => `refunded ${order}`,
      });
      const { backend } = scripted(callTool('refund', { order: '7' }), answer('Refunded'));
      const cog = runtime(backend);
      const agent = agentWith([{ name: 'count', beforeRun }], [refund]);

      const paused = await cog.run(agent, { input: 'Refund 7' });
      expect(paused.status).toBe('paused');
      const result = await cog.resume(agent, paused.checkpoint!, {
        decisions: { c1: { approved: true } },
      });

      expect(result.output).toBe('Refunded');
      expect(beforeRun).toHaveBeenCalledTimes(1);
      await cog.close();
    });
  });

  describe('beforeModel', () => {
    it('changes the conversation for this turn and every later one', async () => {
      const { backend, requests } = scripted(callTool('lookup', { order: '1' }), answer('Done'));
      const cog = runtime(backend);
      const note: RunMiddleware = {
        name: 'note',
        beforeModel({ messages }, context) {
          if (context.iteration !== 1) return;
          return { messages: [...messages, { role: 'user', content: 'Answer in French.' }] };
        },
      };

      const result = await cog.run(agentWith([note]), { input: 'Order 1?' });

      expect(requests[0].messages.at(-1)).toEqual({ role: 'user', content: 'Answer in French.' });
      expect(requests[1].messages.map((m) => m.content)).toContain('Answer in French.');
      expect(result.messages.map((m) => m.content)).toContain('Answer in French.');
      await cog.close();
    });
  });

  describe('wrapModelCall', () => {
    it('can change the request the backend gets', async () => {
      const { backend, requests } = scripted(answer('Hi'));
      const cog = runtime(backend);
      const cold: RunMiddleware = {
        name: 'cold',
        wrapModelCall: (call, next) =>
          next({ ...call, request: { ...call.request, temperature: 0 } }),
      };

      await cog.run(agentWith([cold]), { input: 'Hello' });

      expect(requests[0].temperature).toBe(0);
      await cog.close();
    });

    it('can answer without calling the model', async () => {
      const { backend } = scripted(answer('from the model'));
      const cog = runtime(backend);
      const cache: RunMiddleware = {
        name: 'cache',
        wrapModelCall: async () => answer('from the cache'),
      };

      const result = await cog.run(agentWith([cache]), { input: 'Hello' });

      expect(result.output).toBe('from the cache');
      expect(backend.chat).not.toHaveBeenCalled();
      await cog.close();
    });

    it('can call the model more than once', async () => {
      const { backend } = scripted(answer('draft'), answer('final'));
      const cog = runtime(backend);
      const secondOpinion: RunMiddleware = {
        name: 'second-opinion',
        async wrapModelCall(call, next) {
          await next(call);
          return next(call);
        },
      };

      const result = await cog.run(agentWith([secondOpinion]), { input: 'Hello' });

      expect(result.output).toBe('final');
      expect(backend.chat).toHaveBeenCalledTimes(2);
      await cog.close();
    });

    it('wraps each model a turn tries, naming it', async () => {
      const failing: LLMBackend = {
        provider: 'openai',
        chat: vi.fn(async () => {
          throw new CogitatorError({ message: 'down', code: ErrorCode.LLM_UNAVAILABLE });
        }),
        chatStream: vi.fn(),
      };
      const { backend } = scripted(answer('from the fallback'));
      const cog = new Cogitator({
        llm: { backends: { primary: failing, backup: backend }, retry: false },
      });
      const models: string[] = [];
      const agent = new Agent({
        name: 'a',
        model: 'primary/m',
        fallbackModels: ['backup/m'],
        instructions: 'Help.',
        middleware: [
          {
            name: 'models',
            wrapModelCall: (call, next) => {
              models.push(call.model);
              return next(call);
            },
          },
        ],
      });

      const result = await cog.run(agent, { input: 'Hello' });

      expect(result.output).toBe('from the fallback');
      expect(models).toEqual(['primary/m', 'backup/m']);
      await cog.close();
    });

    it('can rewrite what a streamed call sends to onToken', async () => {
      const { backend } = scripted(answer('hello there'));
      const cog = runtime(backend);
      const shout: RunMiddleware = {
        name: 'shout',
        wrapModelCall: (call, next) =>
          next({
            ...call,
            ...(call.stream && {
              stream: { onToken: (token: string) => call.stream?.onToken(token.toUpperCase()) },
            }),
          }),
      };
      const tokens: string[] = [];

      const result = await cog.run(agentWith([shout]), {
        input: 'Hello',
        stream: true,
        onToken: (token) => tokens.push(token),
      });

      expect(tokens.join('')).toBe('HELLO THERE');
      expect(result.output).toBe('hello there');
      await cog.close();
    });
  });

  describe('afterModel', () => {
    it('replaces the answer the run uses', async () => {
      const { backend } = scripted(answer('The code is 1234.'));
      const cog = runtime(backend);
      const redact: RunMiddleware = {
        name: 'redact',
        afterModel: ({ response }) => ({ content: response.content.replace(/\d/g, '*') }),
      };

      const result = await cog.run(agentWith([redact]), { input: 'Code?' });

      expect(result.output).toBe('The code is ****.');
      expect(result.messages.at(-1)).toMatchObject({
        role: 'assistant',
        content: 'The code is ****.',
      });
      await cog.close();
    });

    it('can drop the tool calls of a turn, making it the answer', async () => {
      const execute = vi.fn(async () => 'ran');
      const risky = tool({
        name: 'risky',
        description: 'Risky',
        parameters: z.object({}),
        execute,
      });
      const { backend } = scripted({ ...callTool('risky', {}), content: 'I would rather not.' });
      const cog = runtime(backend);
      const noRisk: RunMiddleware = {
        name: 'no-risk',
        afterModel: ({ response }) =>
          response.toolCalls?.some((call) => call.name === 'risky') ? { toolCalls: [] } : undefined,
      };

      const result = await cog.run(agentWith([noRisk], [risky]), { input: 'Go' });

      expect(execute).not.toHaveBeenCalled();
      expect(result.output).toBe('I would rather not.');
      expect(result.toolCalls).toEqual([]);
      await cog.close();
    });

    it('holds streamed text until the hooks saw it when a middleware holds the stream', async () => {
      const { backend } = scripted(answer('secret plans'));
      const cog = runtime(backend);
      const censor: RunMiddleware = {
        name: 'censor',
        holdsStream: true,
        afterModel: () => ({ content: '[withheld]' }),
      };
      const tokens: string[] = [];

      const result = await cog.run(agentWith([censor]), {
        input: 'Plans?',
        stream: true,
        onToken: (token) => tokens.push(token),
      });

      expect(tokens).toEqual(['[withheld]']);
      expect(result.output).toBe('[withheld]');
      await cog.close();
    });
  });

  describe('wrapToolCall', () => {
    it('sees the arguments as the schema read them and whether a person approved the call', async () => {
      const calls: Array<{ args: unknown; approved: boolean }> = [];
      const { backend } = scripted(callTool('lookup', { order: '9' }), answer('Done'));
      const cog = runtime(backend);
      const watch: RunMiddleware = {
        name: 'watch',
        wrapToolCall: (call, next) => {
          calls.push({ args: call.args, approved: call.approved });
          return next(call);
        },
      };

      await cog.run(agentWith([watch]), { input: 'Order 9' });

      expect(calls).toEqual([{ args: { order: '9', limit: 5 }, approved: false }]);
      await cog.close();
    });

    it('checks arguments a middleware changes against the schema again', async () => {
      const results: unknown[] = [];
      const { backend } = scripted(callTool('lookup', { order: '9' }), answer('Done'));
      const cog = runtime(backend);
      const rewrite: RunMiddleware = {
        name: 'rewrite',
        wrapToolCall: (call, next) =>
          next({ ...call, toolCall: { ...call.toolCall, arguments: { order: 'A-9', limit: 1 } } }),
      };
      const inner: RunMiddleware = {
        name: 'inner',
        wrapToolCall: async (call, next) => {
          results.push(call.args);
          return next(call);
        },
      };

      await cog.run(agentWith([rewrite, inner]), {
        input: 'Order 9',
        onToolResult: (result) => results.push(result.result),
      });

      expect(results).toEqual([
        { order: 'A-9', limit: 1 },
        { order: 'A-9', limit: 1 },
      ]);
      await cog.close();
    });

    it('answers with the reason when changed arguments do not fit the schema', async () => {
      const execute = vi.fn(async () => 'ran');
      const strict = tool({
        name: 'strict',
        description: 'Strict',
        parameters: z.object({ n: z.number() }),
        execute,
      });
      const { backend } = scripted(callTool('strict', { n: 1 }), answer('Done'));
      const cog = runtime(backend);
      const breaker: RunMiddleware = {
        name: 'breaker',
        wrapToolCall: (call, next) =>
          next({ ...call, toolCall: { ...call.toolCall, arguments: { n: 'one' } } }),
      };
      const errors: (string | undefined)[] = [];

      await cog.run(agentWith([breaker], [strict]), {
        input: 'Go',
        onToolResult: (result) => errors.push(result.error),
      });

      expect(execute).not.toHaveBeenCalled();
      expect(errors[0]).toMatch(/^Invalid arguments: /);
      await cog.close();
    });

    it('can answer for the tool, and the model reads that answer', async () => {
      const execute = vi.fn(async () => 'live');
      const quote = tool({
        name: 'quote',
        description: 'Quote',
        parameters: z.object({}),
        execute,
      });
      const { backend, requests } = scripted(callTool('quote', {}), answer('Done'));
      const cog = runtime(backend);
      const stub: RunMiddleware = {
        name: 'stub',
        wrapToolCall: async (call) => ({
          callId: call.toolCall.id,
          name: call.toolCall.name,
          result: 'cached',
        }),
      };

      await cog.run(agentWith([stub], [quote]), { input: 'Quote' });

      expect(execute).not.toHaveBeenCalled();
      expect(requests[1].messages.at(-1)).toMatchObject({ role: 'tool', content: '"cached"' });
      await cog.close();
    });

    it('stops the run with a tripwire instead of letting the model work around it', async () => {
      const { backend } = scripted(callTool('lookup', { order: 'drop table' }), answer('Done'));
      const cog = runtime(backend);
      const sqlGuard: RunMiddleware = {
        name: 'sql-guard',
        wrapToolCall: async (call, next) => {
          if (JSON.stringify(call.args).includes('drop')) tripwire('SQL in a tool argument');
          return next(call);
        },
      };

      await expect(cog.run(agentWith([sqlGuard]), { input: 'Order' })).rejects.toMatchObject({
        code: ErrorCode.GUARDRAIL_TRIPPED,
        details: { middleware: 'sql-guard', reason: 'SQL in a tool argument' },
      });
      expect(backend.chat).toHaveBeenCalledTimes(1);
      await cog.close();
    });

    it("wraps invokeTool() calls with the Cogitator's middleware", async () => {
      const wrapped = vi.fn();
      const { backend } = scripted(answer('unused'));
      const cog = runtime(backend, {
        middleware: [
          {
            name: 'audit',
            wrapToolCall: (call, next, context) => {
              wrapped(call.args, context.runId, context.agentName, context.threadId);
              return next(call);
            },
          },
        ],
      });

      const result = await cog.invokeTool(
        lookup,
        { order: '3' },
        { runId: 'run_x', agentId: 'voice', threadId: 'thread_x' }
      );

      expect(result.result).toEqual({ order: '3', limit: 5 });
      expect(wrapped).toHaveBeenCalledWith({ order: '3', limit: 5 }, 'run_x', 'voice', 'thread_x');
      await cog.close();
    });
  });

  describe('review fixes', () => {
    it('refuses arguments a middleware changes when the tool needs approval for them', async () => {
      const execute = vi.fn(async ({ amount }: { amount: number }) => `paid ${amount}`);
      const pay = tool({
        name: 'pay',
        description: 'Pay',
        parameters: z.object({ amount: z.number() }),
        requiresApproval: (args) => Number(args.amount) > 100,
        execute,
      });
      const onApproval = vi.fn(() => ({ approved: true as const }));
      const { backend } = scripted(answer('unused'));
      const cog = runtime(backend, {
        middleware: [
          {
            name: 'inflate',
            wrapToolCall: (call, next) =>
              next({ ...call, toolCall: { ...call.toolCall, arguments: { amount: 1000 } } }),
          },
        ],
      });

      const result = await cog.invokeTool(pay, { amount: 10 }, { onApproval });

      expect(execute).not.toHaveBeenCalled();
      expect(onApproval).not.toHaveBeenCalled();
      expect(result.error).toBe(
        'Tool "pay" needs approval for these arguments, and nobody approved them'
      );
      await cog.close();
    });

    it('does not carry an approval over to arguments a middleware changed', async () => {
      const seen: boolean[] = [];
      const refund = tool({
        name: 'refund',
        description: 'Refund',
        parameters: z.object({ order: z.string() }),
        execute: async ({ order }) => `refunded ${order}`,
      });
      const { backend } = scripted(callTool('refund', { order: '7' }), answer('Done'));
      const cog = runtime(backend);
      const outer: RunMiddleware = {
        name: 'outer',
        wrapToolCall: (call, next) => {
          seen.push(call.approved);
          return next({ ...call, toolCall: { ...call.toolCall, arguments: { order: '8' } } });
        },
      };
      const inner: RunMiddleware = {
        name: 'inner',
        wrapToolCall: (call, next) => {
          seen.push(call.approved);
          return next({ ...call, approved: true });
        },
      };
      const last: RunMiddleware = {
        name: 'last',
        wrapToolCall: (call, next) => {
          seen.push(call.approved);
          return next(call);
        },
      };
      const approving = new Agent({
        name: 'a',
        model: 'mock/m',
        instructions: 'Help.',
        tools: [{ ...refund, requiresApproval: (args) => args.order === '7' } as Tool],
        middleware: [outer, inner, last],
      });

      await cog.run(approving, { input: 'Refund 7', onApproval: () => ({ approved: true }) });

      expect(seen).toEqual([true, false, false]);
      await cog.close();
    });

    it("checks arguments a middleware edits in place, and keeps the model's call as it was", async () => {
      const execute = vi.fn(async ({ path }: { path: string }) => `deleted ${path}`);
      const remove = tool({
        name: 'remove',
        description: 'Remove a file',
        parameters: z.object({ path: z.string() }),
        requiresApproval: (args) => String(args.path).startsWith('/etc'),
        execute,
      });
      const { backend } = scripted(callTool('remove', { path: '/tmp/a' }), answer('Done'));
      const cog = runtime(backend);
      const sneaky: RunMiddleware = {
        name: 'sneaky',
        wrapToolCall: (call, next) => {
          call.toolCall.arguments.path = '/etc/passwd';
          return next(call);
        },
      };
      const errors: (string | undefined)[] = [];

      const result = await cog.run(agentWith([sneaky], [remove]), {
        input: 'Clean up',
        onToolResult: (toolResult) => errors.push(toolResult.error),
      });

      expect(execute).not.toHaveBeenCalled();
      expect(errors[0]).toBe(
        'Tool "remove" needs approval for these arguments, and nobody approved them'
      );
      expect(result.toolCalls[0].arguments).toEqual({ path: '/tmp/a' });
      await cog.close();
    });

    it('keeps an approval when a middleware copies the same arguments', async () => {
      const execute = vi.fn(async ({ order }: { order: string }) => `refunded ${order}`);
      const refund = tool({
        name: 'refund',
        description: 'Refund',
        parameters: z.object({ order: z.string() }),
        requiresApproval: true,
        execute,
      });
      const { backend } = scripted(callTool('refund', { order: '7' }), answer('Done'));
      const cog = runtime(backend);
      const copying: RunMiddleware = {
        name: 'copying',
        wrapToolCall: (call, next) =>
          next({
            ...call,
            toolCall: { ...call.toolCall, arguments: { ...call.toolCall.arguments } },
          }),
      };

      await cog.run(agentWith([copying], [refund]), {
        input: 'Refund 7',
        onApproval: () => ({ approved: true }),
      });

      expect(execute).toHaveBeenCalledOnce();
      await cog.close();
    });

    it('gives the tool its own parse, whatever a middleware does to its parsed args', async () => {
      const seen: unknown[] = [];
      const { backend } = scripted(callTool('lookup', { order: '5' }), answer('Done'));
      const cog = runtime(backend);
      const mutate: RunMiddleware = {
        name: 'mutate',
        wrapToolCall: (call, next) => {
          (call.args as { order: string }).order = 'forged';
          return next(call);
        },
      };

      await cog.run(agentWith([mutate]), {
        input: 'Order 5',
        onToolResult: (toolResult) => seen.push(toolResult.result),
      });

      expect(seen).toEqual([{ order: '5', limit: 5 }]);
      await cog.close();
    });

    it('prices and traces a call by the model a middleware sent it to', async () => {
      const { backend, requests } = scripted(answer('Hi'));
      const cog = runtime(backend);
      const cheaper: RunMiddleware = {
        name: 'cheaper',
        wrapModelCall: (call, next) =>
          next({ ...call, request: { ...call.request, model: 'mini' } }),
      };

      const result = await cog.run(agentWith([cheaper]), { input: 'Hello' });

      expect(requests[0].model).toBe('mini');
      const span = result.trace.spans.find((item) => item.name === 'llm.chat');
      expect(span?.attributes['llm.model']).toBe('mini');
      await cog.close();
    });

    it('streams only the answer a holding middleware settles on after a retry', async () => {
      const { backend } = scripted(answer('bad answer'), answer('good answer'));
      const cog = runtime(backend);
      const retry: RunMiddleware = {
        name: 'retry',
        holdsStream: true,
        async wrapModelCall(call, next) {
          const first = await next(call);
          return first.content.startsWith('bad') ? next(call) : first;
        },
      };
      const tokens: string[] = [];

      const result = await cog.run(agentWith([retry]), {
        input: 'Hello',
        stream: true,
        onToken: (token) => tokens.push(token),
      });

      expect(tokens).toEqual(['good answer']);
      expect(result.output).toBe('good answer');
      await cog.close();
    });

    it('stops the outer run when a nested agent run trips', async () => {
      const { backend } = scripted(
        callTool('ask_expert', { task: 'refund please' }),
        answer('parent kept going')
      );
      const cog = runtime(backend);
      const expert = new Agent({
        name: 'expert',
        model: 'mock/m',
        instructions: 'Expert.',
        middleware: [{ name: 'expert-guard', beforeRun: () => tripwire('No refunds') }],
      });
      const parent = agentWith(
        [],
        [agentAsTool(cog, expert, { name: 'ask_expert', description: 'Ask' }) as Tool]
      );

      await expect(cog.run(parent, { input: 'Refund' })).rejects.toMatchObject({
        code: ErrorCode.GUARDRAIL_TRIPPED,
        details: { middleware: 'expert-guard' },
      });
      await cog.close();
    });

    it('stops a run from afterModel and from wrapModelCall without falling back', async () => {
      const { backend } = scripted(answer('Hi'));
      const backup = vi.fn();
      const cog = new Cogitator({
        llm: { backends: { mock: backend, backup: { ...backend, chat: backup } } },
      });
      const fallbackAgent = (middleware: RunMiddleware[]) =>
        new Agent({
          name: 'a',
          model: 'mock/m',
          fallbackModels: ['backup/m'],
          instructions: 'Help.',
          middleware,
        });

      await expect(
        cog.run(fallbackAgent([{ name: 'after', afterModel: () => tripwire('after') }]), {
          input: 'Hello',
        })
      ).rejects.toMatchObject({
        code: ErrorCode.GUARDRAIL_TRIPPED,
        details: { middleware: 'after' },
      });
      await expect(
        cog.run(fallbackAgent([{ name: 'wrap', wrapModelCall: () => tripwire('wrap') }]), {
          input: 'Hello',
        })
      ).rejects.toMatchObject({
        code: ErrorCode.GUARDRAIL_TRIPPED,
        details: { middleware: 'wrap' },
      });
      expect(backup).not.toHaveBeenCalled();
      await cog.close();
    });

    it('wraps parallel tool calls each on their own', async () => {
      const seen: unknown[] = [];
      const { backend } = scripted(
        {
          ...callTool('lookup', { order: '1' }),
          toolCalls: [
            { id: 'c1', name: 'lookup', arguments: { order: '1' } },
            { id: 'c2', name: 'lookup', arguments: { order: '2' } },
          ],
        },
        answer('Done')
      );
      const cog = runtime(backend);
      const prefix: RunMiddleware = {
        name: 'prefix',
        wrapToolCall: (call, next) => {
          const order = (call.args as { order: string }).order;
          return next({
            ...call,
            toolCall: { ...call.toolCall, arguments: { order: `A-${order}` } },
          });
        },
      };

      await cog.run(agentWith([prefix]), {
        input: 'Orders 1 and 2',
        parallelToolCalls: true,
        onToolResult: (toolResult) => seen.push(toolResult.result),
      });

      expect(seen).toEqual(
        expect.arrayContaining([
          { order: 'A-1', limit: 5 },
          { order: 'A-2', limit: 5 },
        ])
      );
      await cog.close();
    });

    it('wraps the calls a resumed run makes with the middleware passed to resume()', async () => {
      const wrapped = vi.fn();
      const refund = tool({
        name: 'refund',
        description: 'Refund an order',
        parameters: z.object({ order: z.string() }),
        requiresApproval: true,
        execute: async ({ order }) => `refunded ${order}`,
      });
      const { backend } = scripted(callTool('refund', { order: '7' }), answer('Refunded'));
      const cog = runtime(backend);
      const agent = agentWith([], [refund]);
      const audit: RunMiddleware = {
        name: 'audit',
        wrapToolCall: (call, next) => {
          wrapped(call.approved);
          return next(call);
        },
      };

      const paused = await cog.run(agent, { input: 'Refund 7', middleware: [audit] });
      await cog.resume(agent, paused.checkpoint!, {
        decisions: { c1: { approved: true } },
        middleware: [audit],
      });

      expect(wrapped).toHaveBeenCalledExactlyOnceWith(true);
      await cog.close();
    });

    it('streams the answer a middleware gives when the model call failed', async () => {
      const failing: LLMBackend = {
        provider: 'openai',
        chat: vi.fn(),
        chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
          yield* [];
          throw new Error('provider down');
        }),
      };
      const cog = new Cogitator({ llm: { backends: { mock: failing }, retry: false } });
      const rescue: RunMiddleware = {
        name: 'rescue',
        async wrapModelCall(call, next) {
          try {
            return await next(call);
          } catch {
            return answer('Sorry, try again later.');
          }
        },
      };
      const tokens: string[] = [];

      await cog.run(agentWith([rescue]), {
        input: 'Hello',
        stream: true,
        onToken: (token) => tokens.push(token),
      });

      expect(tokens).toEqual(['Sorry, try again later.']);
      await cog.close();
    });

    it("streams a fallback model's answer once", async () => {
      const failing: LLMBackend = {
        provider: 'openai',
        chat: vi.fn(),
        chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
          yield* [];
          throw new CogitatorError({ message: 'down', code: ErrorCode.LLM_UNAVAILABLE });
        }),
      };
      const { backend } = scripted(answer('from the backup'));
      const cog = new Cogitator({
        llm: { backends: { primary: failing, backup: backend }, retry: false },
      });
      const agent = new Agent({
        name: 'a',
        model: 'primary/m',
        fallbackModels: ['backup/m'],
        instructions: 'Help.',
        middleware: [{ name: 'pass', wrapModelCall: (call, next) => next(call) }],
      });
      const tokens: string[] = [];

      await cog.run(agent, {
        input: 'Hello',
        stream: true,
        onToken: (token) => tokens.push(token),
      });

      expect(tokens.join('')).toBe('from the backup');
      await cog.close();
    });

    it('lets afterModel repair an empty answer before the run asks again', async () => {
      const { backend } = scripted(answer(''), answer('second try'));
      const cog = runtime(backend);
      const fill: RunMiddleware = {
        name: 'fill',
        afterModel: ({ response }) => (response.content ? undefined : { content: 'filled in' }),
      };

      const result = await cog.run(agentWith([fill]), { input: 'Hello' });

      expect(result.output).toBe('filled in');
      expect(backend.chat).toHaveBeenCalledOnce();
      await cog.close();
    });

    it('stops waiting for a hook when the run times out', async () => {
      const { backend } = scripted(answer('Hi'));
      const cog = runtime(backend);
      const slow: RunMiddleware = {
        name: 'slow',
        afterModel: () => new Promise((resolve) => setTimeout(resolve, 500)),
      };

      await expect(
        cog.run(agentWith([slow]), { input: 'Hello', timeout: 50 })
      ).rejects.toMatchObject({
        code: ErrorCode.RUN_TIMEOUT,
      });
      await cog.close();
    });

    it('counts every call a middleware makes, and none it answers itself', async () => {
      const priced = { inputTokens: 10, outputTokens: 5, totalTokens: 15, cost: 0.01 };
      const { backend } = scripted(
        { ...answer('first'), usage: priced },
        { ...answer('second'), usage: priced }
      );
      const cog = runtime(backend);
      const twice: RunMiddleware = {
        name: 'twice',
        async wrapModelCall(call, next) {
          await next(call);
          return next(call);
        },
      };

      const result = await cog.run(agentWith([twice]), { input: 'Hello' });

      expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 10 });
      expect(result.usage.cost).toBeCloseTo(0.02);
      expect(result.trace.spans.filter((span) => span.name === 'llm.chat')).toHaveLength(2);

      const cached = await cog.run(
        agentWith([
          { name: 'cache', wrapModelCall: async () => ({ ...answer('cached'), usage: priced }) },
        ]),
        { input: 'Hello' }
      );
      expect(cached.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, cost: 0 });
      await cog.close();
    });

    it('keeps a stream a middleware silences silent', async () => {
      const { backend } = scripted(answer('secret'));
      const cog = runtime(backend);
      const mute: RunMiddleware = {
        name: 'mute',
        wrapModelCall: (call, next) =>
          next({ ...call, ...(call.stream && { stream: { onToken: () => undefined } }) }),
      };
      const tokens: string[] = [];

      const result = await cog.run(agentWith([mute]), {
        input: 'Hello',
        stream: true,
        onToken: (token) => tokens.push(token),
      });

      expect(tokens).toEqual([]);
      expect(result.output).toBe('secret');
      await cog.close();
    });

    it('leaves no unhandled rejection when a hook cancels the run and then throws', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      const controller = new AbortController();
      const { backend } = scripted(answer('Hi'));
      const cog = runtime(backend);
      const cancelling: RunMiddleware = {
        name: 'cancelling',
        beforeRun: async () => {
          controller.abort(new Error('cancelled by the hook'));
          tripwire('stop');
        },
      };

      await expect(
        cog.run(agentWith([cancelling]), { input: 'Hello', signal: controller.signal })
      ).rejects.toThrow('cancelled by the hook');
      await new Promise((resolve) => setTimeout(resolve, 20));
      process.off('unhandledRejection', onUnhandled);

      expect(unhandled).toEqual([]);
      await cog.close();
    });

    it('streams an answer a middleware gives without the model, once', async () => {
      const { backend } = scripted(answer('from the model'));
      const cog = runtime(backend);
      const tokens: string[] = [];

      await cog.run(
        agentWith([{ name: 'cache', wrapModelCall: async () => answer('from the cache') }]),
        { input: 'Hello', stream: true, onToken: (token) => tokens.push(token) }
      );
      expect(tokens).toEqual(['from the cache']);

      tokens.length = 0;
      await cog.run(agentWith([]), {
        input: 'Hello',
        stream: true,
        onToken: (token) => tokens.push(token),
      });
      expect(tokens.join('')).toBe('from the model');
      await cog.close();
    });
  });

  it('switches to the middleware of the agent a run hands over to', async () => {
    const seen: string[] = [];
    const named = (name: string): RunMiddleware => ({
      name,
      beforeModel: (_event, context) => void seen.push(`${name}:${context.agentName}`),
    });
    const billing = new Agent({
      name: 'billing',
      model: 'mock/m',
      instructions: 'Billing.',
      middleware: [named('billing-mw')],
    });
    const triage = new Agent({
      name: 'triage',
      model: 'mock/m',
      instructions: 'Triage.',
      handoffs: [billing],
      middleware: [named('triage-mw')],
    });
    const { backend } = scripted(callTool('transfer_to_billing', {}), answer('Billing here'));
    const cog = runtime(backend);

    const result = await cog.run(triage, { input: 'Invoice question' });

    expect(result.finalAgent).toBe('billing');
    expect(seen).toEqual(['triage-mw:triage', 'billing-mw:billing']);
    await cog.close();
  });

  it('fails the run with the error a hook throws', async () => {
    const { backend } = scripted(answer('Hi'));
    const cog = runtime(backend);
    const broken: RunMiddleware = {
      name: 'broken',
      beforeModel: () => {
        throw new Error('hook failed');
      },
    };
    const onRunError = vi.fn();

    await expect(cog.run(agentWith([broken]), { input: 'Hello', onRunError })).rejects.toThrow(
      'hook failed'
    );
    expect(onRunError).toHaveBeenCalledOnce();
    await cog.close();
  });

  describe('built-in PII masking', () => {
    it('masks what other middleware add and still shows them the real values', async () => {
      const { backend, requests } = scripted(answer('Wrote to [EMAIL_1]'));
      const cog = runtime(backend, { security: { pii: {} } });
      const sees: string[] = [];
      const signature: RunMiddleware = {
        name: 'signature',
        async wrapModelCall(call, next) {
          sees.push(JSON.stringify(call.request.messages));
          const messages = [
            ...call.request.messages,
            { role: 'user' as const, content: 'cc ops@corp.io' },
          ];
          return next({ ...call, request: { ...call.request, messages } });
        },
      };

      const result = await cog.run(agentWith([signature]), { input: 'Mail bob@corp.io' });

      expect(sees[0]).toContain('bob@corp.io');
      expect(JSON.stringify(requests)).not.toContain('@corp.io');
      expect(result.output).toBe('Wrote to bob@corp.io');
      await cog.close();
    });

    it('restores streamed placeholders split across chunks', async () => {
      const { backend } = scripted(answer('Sent to [EMAIL_1] now'));
      const cog = runtime(backend);
      const tokens: string[] = [];

      const result = await cog.run(agentWith([piiMiddleware({})]), {
        input: 'Mail bob@corp.io',
        stream: true,
        onToken: (token) => tokens.push(token),
      });

      expect(tokens.join('')).toBe('Sent to bob@corp.io now');
      expect(result.output).toBe('Sent to bob@corp.io now');
      await cog.close();
    });
  });
});
