import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  CogitatorError,
  ErrorCode,
  type ChatResponse,
  type RunMiddleware,
  type RunMiddlewareContext,
  type ToolCallRequest,
} from '@cogitator-ai/types';
import { MiddlewarePipeline } from '../middleware/pipeline';
import { isTripwire, tripwire } from '../middleware/tripwire';
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

  it('holds the stream only for a middleware that also has afterModel', () => {
    expect(new MiddlewarePipeline([{ name: 'a', holdsStream: true }]).holdsStream).toBe(false);
    expect(
      new MiddlewarePipeline([{ name: 'a', holdsStream: true, afterModel: () => undefined }])
        .holdsStream
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
