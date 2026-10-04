import { describe, it, expect, vi } from 'vitest';
import type {
  ChatStreamChunk,
  LLMBackend,
  MemoryAdapter,
  MemoryEntry,
  MemoryResult,
  Thread,
} from '@cogitator-ai/types';
import { Agent } from '../agent';
import { Cogitator } from '../cogitator';
import { saveEntry } from '../cogitator/message-builder';

const thread: Thread = {
  id: 't-1',
  agentId: 'agent',
  metadata: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const ok = <T>(data: T): MemoryResult<T> => ({ success: true, data });
const failed = <T>(error: string): MemoryResult<T> => ({ success: false, error });

function adapter(overrides: Partial<MemoryAdapter>): MemoryAdapter {
  return {
    provider: 'memory',
    connect: vi.fn(async () => ok(undefined)),
    disconnect: vi.fn(async () => ok(undefined)),
    createThread: vi.fn(async () => ok(thread)),
    getThread: vi.fn(async () => ok<Thread | null>(thread)),
    updateThread: vi.fn(async () => ok(thread)),
    deleteThread: vi.fn(async () => ok(undefined)),
    addEntry: vi.fn(async (entry) => ok({ ...entry, id: 'e-1', createdAt: new Date(0) })),
    getEntries: vi.fn(async () => ok([])),
    getEntry: vi.fn(async () => ok(null)),
    deleteEntry: vi.fn(async () => ok(undefined)),
    clearThread: vi.fn(async () => ok(undefined)),
    ...overrides,
  } as MemoryAdapter;
}

const message = { role: 'assistant' as const, content: '' };
const toolCalls = [{ id: 'call-1', name: 'lookup', arguments: {} }];

describe('saveEntry', () => {
  it('reports an entry the adapter refused to store', async () => {
    const onError = vi.fn();
    const memory = adapter({
      addEntry: vi.fn(async () => failed<MemoryEntry>('invalid input syntax for type json')),
    });

    await saveEntry('t-1', 'agent', message, memory, toolCalls, undefined, onError);

    expect(onError).toHaveBeenCalledOnce();
    const [error, operation] = onError.mock.calls[0] as [Error, string];
    expect(operation).toBe('save');
    expect(error.message).toBe('Memory addEntry failed: invalid input syntax for type json');
  });

  it('reports a thread that could not be looked up, without writing the entry', async () => {
    const onError = vi.fn();
    const memory = adapter({
      getThread: vi.fn(async () => failed<Thread | null>('connection refused')),
    });

    await saveEntry('t-1', 'agent', message, memory, undefined, undefined, onError);

    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      message: 'Memory getThread failed: connection refused',
    });
    expect(memory.addEntry).not.toHaveBeenCalled();
  });

  it('reports a thread that could not be created', async () => {
    const onError = vi.fn();
    const memory = adapter({
      getThread: vi.fn(async () => ok<Thread | null>(null)),
      createThread: vi.fn(async () => failed<Thread>('permission denied')),
    });

    await saveEntry('t-1', 'agent', message, memory, undefined, undefined, onError);

    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      message: 'Memory createThread failed: permission denied',
    });
    expect(memory.addEntry).not.toHaveBeenCalled();
  });

  it('still reports errors the adapter throws', async () => {
    const onError = vi.fn();
    const memory = adapter({
      addEntry: vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    });

    await saveEntry('t-1', 'agent', message, memory, undefined, undefined, onError);

    expect(onError.mock.calls[0]?.[0]).toMatchObject({ message: 'socket hang up' });
  });

  it('creates a missing thread and stores the entry', async () => {
    const onError = vi.fn();
    const memory = adapter({ getThread: vi.fn(async () => ok<Thread | null>(null)) });

    await saveEntry('t-1', 'agent', message, memory, toolCalls, undefined, onError);

    expect(memory.createThread).toHaveBeenCalledOnce();
    expect(memory.addEntry).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 't-1', toolCalls })
    );
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('memory failures during a run', () => {
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
  const agent = new Agent({ name: 'support', model: 'mock/m', instructions: 'Help.' });
  const runtime = () =>
    new Cogitator({ llm: { backends: { mock: backend } }, memory: { adapter: 'memory' } });

  it('reports a history that could not be loaded and still answers', async () => {
    const cog = runtime();
    await cog.run(agent, { input: 'hi', threadId: 't1' });
    vi.spyOn(cog.memory!, 'getEntries').mockResolvedValue({ success: false, error: 'timeout' });
    const onMemoryError = vi.fn();

    const result = await cog.run(agent, { input: 'again', threadId: 't1', onMemoryError });

    expect(result.output).toBe('ok');
    expect(onMemoryError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Memory getEntries failed: timeout' }),
      'load'
    );
    await cog.close();
  });

  it('reports a shared thread that could not be read and still answers', async () => {
    const cog = runtime();
    await cog.run(agent, { input: 'warm up', threadId: 't0' });
    vi.spyOn(cog.memory!, 'getThread').mockResolvedValue({ success: false, error: 'timeout' });
    const onMemoryError = vi.fn();

    const result = await cog.run(agent, {
      input: 'hi',
      threadId: 't1',
      threadAccess: 'shared',
      onMemoryError,
    });

    expect(result.output).toBe('ok');
    expect(onMemoryError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Memory getThread failed: timeout' }),
      'load'
    );
    await cog.close();
  });
});
