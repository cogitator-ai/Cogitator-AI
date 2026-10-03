import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ChatRequest, ChatResponse, ChatStreamChunk, LLMBackend } from '@cogitator-ai/types';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { z } from 'zod';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { RunLimiter } from '../cogitator/run-limiter';
import { ContextManager } from '../context/context-manager';
import { ReflectionEngine } from '../reflection/reflection-engine';

vi.mock('../llm/index', async (importOriginal) => {
  const original = await importOriginal<typeof import('../llm/index')>();
  return { ...original, createLLMBackend: vi.fn() };
});

function scriptedBackend(next: (request: ChatRequest) => Promise<ChatResponse>) {
  const requests: ChatRequest[] = [];
  const backend: LLMBackend = {
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest) => {
      requests.push(request);
      return next(request);
    }),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: { content: 'unused' }, finishReason: 'stop' };
    }),
  };
  return { backend, requests };
}

const answer = (content: string, tokens = 10): ChatResponse => ({
  id: 'r',
  content,
  finishReason: 'stop',
  usage: { inputTokens: tokens, outputTokens: 0, totalTokens: tokens },
});

async function useBackend(backend: LLMBackend) {
  const { createLLMBackend } = await import('../llm/index');
  vi.mocked(createLLMBackend).mockReturnValue(backend);
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('llm.defaultModel', () => {
  it('runs an agent without a model on the default model', async () => {
    const { backend, requests } = scriptedBackend(async () => answer('hi'));
    await useBackend(backend);
    const cog = new Cogitator({ llm: { defaultModel: 'openai/gpt-6-luna' } });

    await cog.run(new Agent({ name: 'a', instructions: 'x' }), { input: 'hello' });

    expect(requests[0].model).toBe('gpt-6-luna');
    const { createLLMBackend } = await import('../llm/index');
    expect(vi.mocked(createLLMBackend).mock.calls[0][0]).toBe('openai');
    await cog.close();
  });

  it("prefers the agent's own model", async () => {
    const { backend, requests } = scriptedBackend(async () => answer('hi'));
    await useBackend(backend);
    const cog = new Cogitator({ llm: { defaultModel: 'openai/gpt-6-luna' } });

    await cog.run(new Agent({ name: 'a', model: 'openai/gpt-6.1-sol', instructions: 'x' }), {
      input: 'hello',
    });

    expect(requests[0].model).toBe('gpt-6.1-sol');
    await cog.close();
  });

  it('fails clearly when there is no model at all', async () => {
    const cog = new Cogitator();
    const error = await cog
      .run(new Agent({ name: 'lonely', instructions: 'x' }), { input: 'hello' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CogitatorError);
    expect((error as CogitatorError).code).toBe(ErrorCode.CONFIGURATION_ERROR);
    expect((error as Error).message).toContain('lonely');
    await cog.close();
  });
});

describe('limits.defaultTimeout', () => {
  it('times out runs whose agent sets no timeout', async () => {
    const { backend } = scriptedBackend(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    await useBackend(backend);
    const cog = new Cogitator({ limits: { defaultTimeout: 30 } });

    const error = await cog
      .run(new Agent({ name: 'a', model: 'openai/x', instructions: 'x' }), { input: 'hi' })
      .catch((e: unknown) => e);

    expect((error as Error).message).toContain('30ms');
    expect(error).toBeInstanceOf(CogitatorError);
    expect((error as CogitatorError).code).toBe(ErrorCode.RUN_TIMEOUT);
    expect((error as CogitatorError).statusCode).toBe(504);
    await cog.close();
  });

  it("does not override the agent's own timeout", async () => {
    const { backend } = scriptedBackend(
      () => new Promise((resolve) => setTimeout(() => resolve(answer('slow but fine')), 60))
    );
    await useBackend(backend);
    const cog = new Cogitator({ limits: { defaultTimeout: 20 } });

    const result = await cog.run(
      new Agent({ name: 'a', model: 'openai/x', instructions: 'x', timeout: 5_000 }),
      { input: 'hi' }
    );

    expect(result.output).toBe('slow but fine');
    await cog.close();
  });
});

describe('limits.maxTokensPerRun', () => {
  const echo = tool({
    name: 'echo',
    description: 'Echo',
    parameters: z.object({ text: z.string() }),
    execute: async ({ text }) => text,
  });

  function looping() {
    let call = 0;
    return scriptedBackend(async () => {
      call++;
      return {
        id: `r${call}`,
        content: '',
        toolCalls: [{ id: `c${call}`, name: 'echo', arguments: { text: String(call) } }],
        finishReason: 'tool_calls',
        usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
      };
    });
  }

  it('stops before a model call that would start over the budget', async () => {
    const { backend, requests } = looping();
    await useBackend(backend);
    const cog = new Cogitator({ limits: { maxTokensPerRun: 120 } });
    const agent = new Agent({ name: 'a', model: 'openai/x', instructions: 'x', tools: [echo] });

    const error = await cog.run(agent, { input: 'go' }).catch((e: unknown) => e);

    expect((error as CogitatorError).code).toBe(ErrorCode.RUN_TOKEN_LIMIT_EXCEEDED);
    expect(requests).toHaveLength(3);
    await cog.close();
  });

  it('lets a run finish when its last answer crosses the budget', async () => {
    const { backend } = scriptedBackend(async () => answer('done', 500));
    await useBackend(backend);
    const cog = new Cogitator({ limits: { maxTokensPerRun: 100 } });

    const result = await cog.run(new Agent({ name: 'a', model: 'openai/x', instructions: 'x' }), {
      input: 'go',
    });

    expect(result.output).toBe('done');
    await cog.close();
  });
});

describe('limits.maxConcurrentRuns', () => {
  it('runs at most the limit at once and queues the rest in order', async () => {
    let running = 0;
    let peak = 0;
    const order: string[] = [];
    const { backend } = scriptedBackend(async (request) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 15));
      running--;
      const input = String(request.messages.at(-1)?.content);
      order.push(input);
      return answer(input);
    });
    await useBackend(backend);
    const cog = new Cogitator({ limits: { maxConcurrentRuns: 2 } });
    const agent = new Agent({ name: 'a', model: 'openai/x', instructions: 'x' });

    await Promise.all(['1', '2', '3', '4', '5'].map((input) => cog.run(agent, { input })));

    expect(peak).toBe(2);
    expect(order.slice(2)).toEqual(['3', '4', '5']);
    await cog.close();
  });
});

describe('RunLimiter', () => {
  it('drops a waiting run from the queue when it aborts', async () => {
    const limiter = new RunLimiter(1);
    const release = await limiter.acquire(new AbortController().signal);
    const waiting = new AbortController();

    const pending = limiter.acquire(waiting.signal);
    expect(limiter.queued).toBe(1);
    waiting.abort(new Error('gave up'));

    await expect(pending).rejects.toThrow('gave up');
    expect(limiter.queued).toBe(0);
    release();
    expect(limiter.running).toBe(0);
  });

  it('refuses a limit that is not a positive integer', () => {
    expect(() => new RunLimiter(0)).toThrow(
      expect.objectContaining({
        code: ErrorCode.CONFIGURATION_ERROR,
        message: expect.stringContaining('maxConcurrentRuns'),
      })
    );
  });
});

describe('context management', () => {
  it('compresses context whenever `context` is configured', async () => {
    const { backend } = scriptedBackend(async () => answer('ok'));
    await useBackend(backend);
    const shouldCompress = vi.spyOn(ContextManager.prototype, 'shouldCompress');
    const cog = new Cogitator({ context: { strategy: 'truncate' } });

    await cog.run(new Agent({ name: 'a', model: 'openai/x', instructions: 'x' }), { input: 'hi' });

    expect(shouldCompress).toHaveBeenCalled();
    shouldCompress.mockRestore();
    await cog.close();
  });

  it('stays off with enabled: false', async () => {
    const { backend } = scriptedBackend(async () => answer('ok'));
    await useBackend(backend);
    const shouldCompress = vi.spyOn(ContextManager.prototype, 'shouldCompress');
    const cog = new Cogitator({ context: { enabled: false, strategy: 'truncate' } });

    await cog.run(new Agent({ name: 'a', model: 'openai/x', instructions: 'x' }), { input: 'hi' });

    expect(shouldCompress).not.toHaveBeenCalled();
    shouldCompress.mockRestore();
    await cog.close();
  });
});

describe('reflection.reflectAfterError', () => {
  const failing = tool({
    name: 'flaky',
    description: 'Fails',
    parameters: z.object({}),
    execute: async () => {
      throw new Error('upstream down');
    },
  });

  function failingRun() {
    let call = 0;
    return scriptedBackend(async () => {
      call++;
      return call === 1
        ? {
            id: 'r1',
            content: '',
            toolCalls: [{ id: 'c1', name: 'flaky', arguments: {} }],
            finishReason: 'tool_calls' as const,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }
        : answer('gave up');
    });
  }

  const reflection = {
    reflection: {
      id: 'r',
      runId: 'run',
      agentId: 'a',
      timestamp: new Date(),
      action: { type: 'tool_call' as const },
      analysis: { wasSuccessful: false, confidence: 0.5, reasoning: 'the service is down' },
      insights: [],
      iterationIndex: 0,
    },
    shouldAdjustStrategy: false,
  };

  it('reflects on a failed tool call with the error reflection', async () => {
    const { backend } = failingRun();
    await useBackend(backend);
    const onError = vi
      .spyOn(ReflectionEngine.prototype, 'reflectOnError')
      .mockResolvedValue(reflection as never);
    const onToolCall = vi.spyOn(ReflectionEngine.prototype, 'reflectOnToolCall');
    const cog = new Cogitator({ reflection: { enabled: true, reflectAfterError: true } });
    const agent = new Agent({ name: 'a', model: 'openai/x', instructions: 'x', tools: [failing] });

    const result = await cog.run(agent, { input: 'go' });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({ toolName: 'flaky', error: 'upstream down' });
    expect(onToolCall).not.toHaveBeenCalled();
    expect(result.reflections).toHaveLength(1);
    onError.mockRestore();
    onToolCall.mockRestore();
    await cog.close();
  });

  it('does not reflect on errors unless asked', async () => {
    const { backend } = failingRun();
    await useBackend(backend);
    const onError = vi.spyOn(ReflectionEngine.prototype, 'reflectOnError');
    const cog = new Cogitator({ reflection: { enabled: true } });
    const agent = new Agent({ name: 'a', model: 'openai/x', instructions: 'x', tools: [failing] });

    await cog.run(agent, { input: 'go' });

    expect(onError).not.toHaveBeenCalled();
    onError.mockRestore();
    await cog.close();
  });
});
