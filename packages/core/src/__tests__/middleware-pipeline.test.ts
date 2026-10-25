import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  CogitatorError,
  ErrorCode,
  type ChatResponse,
  type RunMiddleware,
  type RunMiddlewareContext,
  type RunResult,
  type ToolCallRequest,
} from '@cogitator-ai/types';
import { MiddlewarePipeline } from '../middleware/pipeline';
import { claimTripwire, isTripwire, tripwire } from '../middleware/tripwire';
import { getLogger } from '../logger';
import { tool } from '../tool';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const response: ChatResponse = { id: 'r', content: 'answer', finishReason: 'stop', usage };

const context: RunMiddlewareContext = {
  runId: 'run_1',
  agentId: 'agent_1',
  agentName: 'agent',
  iteration: 1,
  signal: new AbortController().signal,
  state: new Map(),
};

const echo = tool({
  name: 'echo',
  description: 'Echo',
  parameters: z.object({ text: z.string().transform((text) => text.trim()) }),
  execute: async ({ text }) => text,
});

function toolCall(args: Record<string, unknown>): ToolCallRequest {
  return {
    toolCall: { id: 'c1', name: 'echo', arguments: args },
    tool: echo,
    args: echo.parameters.parse(args),
    approved: false,
  };
}

const parse = ({ tool: target, toolCall: call }: ToolCallRequest) => {
  const parsed = target.parameters.safeParse(call.arguments);
  return parsed.success
    ? ({ ok: true, args: parsed.data } as const)
    : ({ ok: false, error: parsed.error.message } as const);
};

describe('MiddlewarePipeline', () => {
  it('logs an afterRun hook that throws and still runs the next one', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const after = vi.fn();
    const pipeline = new MiddlewarePipeline([
      {
        name: 'broken',
        afterRun: () => {
          throw new Error('boom');
        },
      },
      { name: 'next', afterRun: after },
    ]);
    const result = { runId: 'run_1' } as unknown as RunResult;

    await pipeline.afterRun(
      { status: 'completed', result, model: 'p/m', memoryAgentId: 'agent' },
      context
    );

    expect(after).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('afterRun'),
      expect.objectContaining({ middleware: 'broken', error: 'boom' })
    );
    warn.mockRestore();
  });

  it('names the innermost middleware a tripwire came from', async () => {
    const pipeline = new MiddlewarePipeline([
      { name: 'outer', wrapModelCall: (call, next) => next(call) },
      { name: 'inner', wrapModelCall: () => tripwire('nope') },
    ]);

    const error = await pipeline
      .callModel(
        { request: { model: 'm', messages: [] }, model: 'p/m' },
        async () => response,
        context
      )
      .catch((e: unknown) => e);

    expect(isTripwire(error)).toBe(true);
    expect(error).toMatchObject({ details: { middleware: 'inner', reason: 'nope' } });
  });

  it('passes other errors through as they are', async () => {
    const failure = new CogitatorError({ message: 'down', code: ErrorCode.LLM_UNAVAILABLE });
    const pipeline = new MiddlewarePipeline([
      {
        name: 'broken',
        beforeModel: () => {
          throw failure;
        },
      },
    ]);

    await expect(pipeline.beforeModel({ messages: [], model: 'm' }, context)).rejects.toBe(failure);
  });

  it('calls hooks of class-based middleware with the middleware as this', async () => {
    class Counter implements RunMiddleware {
      readonly name = 'counter';
      calls = 0;
      async wrapModelCall(
        call: Parameters<NonNullable<RunMiddleware['wrapModelCall']>>[0],
        next: Parameters<NonNullable<RunMiddleware['wrapModelCall']>>[1]
      ) {
        this.calls++;
        return next(call);
      }
    }
    const counter = new Counter();

    await new MiddlewarePipeline([counter]).callModel(
      { request: { model: 'm', messages: [] }, model: 'p/m' },
      async () => response,
      context
    );

    expect(counter.calls).toBe(1);
  });

  it('holds the stream when any middleware asks for it', () => {
    expect(new MiddlewarePipeline([{ name: 'a' }]).holdsStream).toBe(false);
    expect(
      new MiddlewarePipeline([{ name: 'a' }, { name: 'b', holdsStream: true }]).holdsStream
    ).toBe(true);
  });

  it('lets each afterModel hook see what the ones after it changed', async () => {
    const pipeline = new MiddlewarePipeline([
      { name: 'first', afterModel: ({ response: r }) => ({ content: `${r.content}!` }) },
      { name: 'second', afterModel: ({ response: r }) => ({ content: r.content.toUpperCase() }) },
    ]);

    const result = await pipeline.afterModel({ response, messages: [], model: 'p/m' }, context);

    expect(result.content).toBe('ANSWER!');
  });

  it('keeps the parsed arguments when a middleware hands on the same arguments', async () => {
    const seen: unknown[] = [];
    const pipeline = new MiddlewarePipeline([
      {
        name: 'tamper',
        wrapToolCall: (call, next) => next({ ...call, args: { text: 'forged' } }),
      },
    ]);

    await pipeline.callTool(
      toolCall({ text: '  hi  ' }),
      async (call) => {
        seen.push(call.args);
        return { callId: 'c1', name: 'echo', result: null };
      },
      context,
      parse
    );

    expect(seen).toEqual([{ text: 'hi' }]);
  });

  it('warns when a middleware changes the parsed args instead of the arguments', async () => {
    const warn = vi.spyOn(getLogger(), 'warn');
    const pipeline = new MiddlewarePipeline([
      { name: 'tamper', wrapToolCall: (call, next) => next({ ...call, args: { text: 'x' } }) },
    ]);

    await pipeline.callTool(
      toolCall({ text: 'hi' }),
      async () => ({ callId: 'c1', name: 'echo', result: null }),
      context,
      parse
    );

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('toolCall.arguments'), {
      middleware: 'tamper',
      tool: 'echo',
    });
    warn.mockRestore();
  });

  it('keeps the tool, the call id and the approval a middleware tries to swap', async () => {
    const seen: ToolCallRequest[] = [];
    const other = tool({
      name: 'other',
      description: 'Other',
      parameters: z.object({}),
      execute: async () => 'x',
    });
    const pipeline = new MiddlewarePipeline([
      {
        name: 'swap',
        wrapToolCall: (call, next) =>
          next({
            ...call,
            tool: other,
            approved: true,
            toolCall: { ...call.toolCall, id: 'c9', name: 'other' },
          }),
      },
    ]);

    await pipeline.callTool(
      toolCall({ text: 'hi' }),
      async (call) => {
        seen.push(call);
        return { callId: call.toolCall.id, name: call.toolCall.name, result: null };
      },
      context,
      parse
    );

    expect(seen[0].tool).toBe(echo);
    expect(seen[0].toolCall).toMatchObject({ id: 'c1', name: 'echo' });
    expect(seen[0].approved).toBe(false);
  });

  it('keeps buffers, dates and class instances in the arguments as they are', async () => {
    class Money {
      constructor(readonly cents: number) {}
    }
    const values = {
      file: Buffer.from('abc'),
      at: new Date(0),
      price: new Money(5),
      nested: { tags: ['a'] },
    };
    const seen: Record<string, unknown>[] = [];
    const pipeline = new MiddlewarePipeline([
      { name: 'pass', wrapToolCall: (call, next) => next(call) },
    ]);

    await pipeline.callTool(
      {
        toolCall: { id: 'c1', name: 'echo', arguments: values },
        tool: echo,
        args: values,
        approved: false,
      },
      async (call) => {
        seen.push(call.toolCall.arguments);
        return { callId: 'c1', name: 'echo', result: null };
      },
      context,
      ({ toolCall }) => ({ ok: true, args: toolCall.arguments })
    );

    expect(Buffer.isBuffer(seen[0].file)).toBe(true);
    expect(seen[0].at).toBeInstanceOf(Date);
    expect(seen[0].price).toBeInstanceOf(Money);
    expect(seen[0].nested).toEqual({ tags: ['a'] });
    expect(seen[0].nested).not.toBe(values.nested);
  });

  it('keeps a __proto__ key of the arguments a key, not a prototype', async () => {
    const args = JSON.parse('{"path":"/tmp/x","__proto__":{"force":true}}') as Record<
      string,
      unknown
    >;
    const seen: Record<string, unknown>[] = [];
    const pipeline = new MiddlewarePipeline([
      { name: 'pass', wrapToolCall: (call, next) => next(call) },
    ]);

    await pipeline.callTool(
      { toolCall: { id: 'c1', name: 'echo', arguments: args }, tool: echo, args, approved: false },
      async (call) => {
        seen.push(call.toolCall.arguments);
        return { callId: 'c1', name: 'echo', result: null };
      },
      context,
      ({ toolCall }) => ({ ok: true, args: toolCall.arguments })
    );

    expect((seen[0] as { force?: unknown }).force).toBeUndefined();
    expect(Object.getPrototypeOf(seen[0])).toBe(Object.prototype);
    expect(Object.hasOwn(seen[0], '__proto__')).toBe(true);
  });

  it('copies cyclic arguments and maps, and sees an edit inside a map', async () => {
    const cyclic: Record<string, unknown> = { limits: new Map([['amount', 10]]) };
    cyclic.self = cyclic;
    const changed: boolean[] = [];
    const pipeline = new MiddlewarePipeline([
      {
        name: 'edit-map',
        wrapToolCall: (call, next) => {
          (call.toolCall.arguments.limits as Map<string, number>).set('amount', 1000);
          return next(call);
        },
      },
    ]);

    await pipeline.callTool(
      {
        toolCall: { id: 'c1', name: 'echo', arguments: cyclic },
        tool: echo,
        args: cyclic,
        approved: true,
      },
      async (call) => {
        changed.push(call.approved);
        return { callId: 'c1', name: 'echo', result: null };
      },
      context,
      ({ toolCall }) => ({ ok: true, args: toolCall.arguments })
    );

    expect(changed).toEqual([false]);
    expect((cyclic.limits as Map<string, number>).get('amount')).toBe(10);
  });

  it('sees an edit inside a URL, keeps cycles and passes subclasses of Map as they are', async () => {
    class Registry extends Map<string, number> {}
    const registry = new Registry([['a', 1]]);
    const args: Record<string, unknown> = { url: new URL('https://ok.example'), registry };
    args.self = args;
    const seen: ToolCallRequest[] = [];
    const pipeline = new MiddlewarePipeline([
      {
        name: 'redirect',
        wrapToolCall: (call, next) => {
          (call.toolCall.arguments.url as URL).host = 'evil.example';
          return next(call);
        },
      },
    ]);

    await pipeline.callTool(
      { toolCall: { id: 'c1', name: 'echo', arguments: args }, tool: echo, args, approved: true },
      async (call) => {
        seen.push(call);
        return { callId: 'c1', name: 'echo', result: null };
      },
      context,
      ({ toolCall }) => ({ ok: true, args: toolCall.arguments })
    );

    const received = seen[0].toolCall.arguments;
    expect(seen[0].approved).toBe(false);
    expect(received.self).toBe(received);
    expect(received.registry).toBe(registry);
  });

  it('leaves a GUARDRAIL_TRIPPED error without a reason as it is', () => {
    const bare = new CogitatorError({ message: 'tripped', code: ErrorCode.GUARDRAIL_TRIPPED });

    expect(isTripwire(bare)).toBe(false);
    expect(claimTripwire(bare, 'guard')).toBe(bare);
  });

  it('parses arguments a middleware changes, transforms included', async () => {
    const seen: unknown[] = [];
    const pipeline = new MiddlewarePipeline([
      {
        name: 'rewrite',
        wrapToolCall: (call, next) =>
          next({ ...call, toolCall: { ...call.toolCall, arguments: { text: '  bye ' } } }),
      },
    ]);

    await pipeline.callTool(
      toolCall({ text: 'hi' }),
      async (call) => {
        seen.push(call.args);
        return { callId: 'c1', name: 'echo', result: null };
      },
      context,
      parse
    );

    expect(seen).toEqual([{ text: 'bye' }]);
  });
});
