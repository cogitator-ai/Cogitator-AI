import { afterEach, describe, it, expect, vi } from 'vitest';
import type { ChatStreamChunk, LLMBackend } from '@cogitator-ai/types';
import type { ContextBuilderDeps } from '@cogitator-ai/memory';
import { InMemoryAdapter, PostgresAdapter } from '@cogitator-ai/memory';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { getLogger } from '../logger';

const captured = vi.hoisted(() => [] as ContextBuilderDeps[]);

vi.mock('@cogitator-ai/memory', async (importOriginal) => {
  const original = await importOriginal<typeof import('@cogitator-ai/memory')>();
  class CapturingContextBuilder extends original.ContextBuilder {
    constructor(...args: ConstructorParameters<typeof original.ContextBuilder>) {
      super(...args);
      captured.push(args[1]);
    }
  }
  return { ...original, ContextBuilder: CapturingContextBuilder };
});

const backend: LLMBackend = {
  provider: 'openai',
  chat: vi.fn(async () => ({
    id: 'r',
    content: 'ok',
    finishReason: 'stop' as const,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  })),
  chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
    yield { id: 's', delta: {}, finishReason: 'stop' };
  }),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('memory connection', () => {
  it('releases an adapter whose connection failed', async () => {
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    vi.spyOn(InMemoryAdapter.prototype, 'connect').mockResolvedValue({
      success: false,
      error: 'connect ECONNREFUSED',
    });
    const disconnect = vi.spyOn(InMemoryAdapter.prototype, 'disconnect');
    const cog = new Cogitator({
      llm: { backends: { mock: backend } },
      memory: { adapter: 'memory' },
    });

    const result = await cog.run(new Agent({ name: 'a', model: 'mock/m', instructions: 'x' }), {
      input: 'hi',
    });
    expect(result.output).toBe('ok');
    expect(await cog.getMemory()).toBeUndefined();
    expect(disconnect).toHaveBeenCalledTimes(2);
    await cog.close();
  });

  it('does not search a Postgres store without pgvector', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    vi.spyOn(PostgresAdapter.prototype, 'connect').mockResolvedValue({
      success: true,
      data: undefined,
    });
    vi.spyOn(PostgresAdapter.prototype, 'disconnect').mockResolvedValue({
      success: true,
      data: undefined,
    });
    vi.spyOn(PostgresAdapter.prototype, 'vectorStatus').mockReturnValue({
      available: false,
      reason: 'pgvector is not installed in this database',
    });
    const cog = new Cogitator({
      llm: { backends: { mock: backend } },
      memory: {
        adapter: 'postgres',
        postgres: { connectionString: 'postgresql://localhost/db' },
        contextBuilder: { includeSemanticContext: true },
      },
    });

    await cog.getMemory();

    const deps = captured.at(-1);
    expect(deps?.memoryAdapter).toBeInstanceOf(PostgresAdapter);
    expect(deps?.embeddingAdapter).toBeUndefined();
    expect(
      warn.mock.calls.some(([message]) => String(message).includes('pgvector is not installed'))
    ).toBe(true);
    await cog.close();
  });
});
