import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ChatRequest, ChatResponse, ChatStreamChunk, LLMBackend } from '@cogitator-ai/types';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { z } from 'zod';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { RunLimiter } from '../cogitator/run-limiter';

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
    expect(() => new RunLimiter(0)).toThrow('maxConcurrentRuns');
  });
});
