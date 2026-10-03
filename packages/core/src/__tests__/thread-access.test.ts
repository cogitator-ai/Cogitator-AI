import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ChatStreamChunk, LLMBackend } from '@cogitator-ai/types';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { ContextBuilder, InMemoryAdapter } from '@cogitator-ai/memory';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { assertThreadAccess, ensureThreadAccess, threadOwner } from '../cogitator/threads';

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

function cogitator(contextBuilder?: { maxTokens: number }) {
  return new Cogitator({
    llm: { backends: { mock: backend } },
    memory: { adapter: 'memory', ...(contextBuilder && { contextBuilder }) },
  });
}

async function denial(promise: Promise<unknown>): Promise<CogitatorError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(CogitatorError);
  return error as CogitatorError;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('thread ownership', () => {
  it('records the user of the run that creates a thread', async () => {
    const cog = cogitator();

    await cog.run(agent, { input: 'hi', threadId: 't-alice', userId: 'alice' });
    await cog.run(agent, { input: 'hi', threadId: 't-anon' });

    const owned = await cog.memory!.getThread('t-alice');
    const open = await cog.memory!.getThread('t-anon');
    expect(owned.success && owned.data && threadOwner(owned.data)).toBe('alice');
    expect(open.success && open.data && threadOwner(open.data)).toBeUndefined();
    await cog.close();
  });

  it('lets only the owner use a thread', async () => {
    const memory = new InMemoryAdapter();
    await memory.createThread('support', { agentId: 'support', userId: 'alice' }, 't1');
    await memory.createThread('support', { agentId: 'support' }, 't2');

    expect((await assertThreadAccess(memory, 't1', 'alice'))?.id).toBe('t1');
    expect((await assertThreadAccess(memory, 't2', undefined))?.id).toBe('t2');
    expect(await assertThreadAccess(memory, 'missing', 'alice')).toBeNull();

    const foreign = await denial(assertThreadAccess(memory, 't1', 'bob'));
    expect(foreign.code).toBe(ErrorCode.THREAD_ACCESS_DENIED);
    expect(foreign.statusCode).toBe(403);
    expect((await denial(assertThreadAccess(memory, 't1', undefined))).code).toBe(
      ErrorCode.THREAD_ACCESS_DENIED
    );
    expect((await denial(assertThreadAccess(memory, 't2', 'bob'))).code).toBe(
      ErrorCode.THREAD_ACCESS_DENIED
    );
  });

  it('refuses a thread whose owner cannot be read', async () => {
    const memory = new InMemoryAdapter();
    vi.spyOn(memory, 'getThread').mockResolvedValue({ success: false, error: 'redis down' });

    const error = await denial(assertThreadAccess(memory, 't1', 'alice'));

    expect(error.code).toBe(ErrorCode.MEMORY_READ_FAILED);
  });

  it('creates a missing thread for the caller', async () => {
    const memory = new InMemoryAdapter();

    const thread = await ensureThreadAccess(memory, 't1', { agentId: 'support', userId: 'alice' });

    expect(threadOwner(thread)).toBe('alice');
    expect(thread.metadata.agentId).toBe('support');
    expect(
      (await denial(ensureThreadAccess(memory, 't1', { agentId: 'x', userId: 'bob' }))).code
    ).toBe(ErrorCode.THREAD_ACCESS_DENIED);
  });

  it("refuses a run on another user's thread", async () => {
    const cog = cogitator();
    await cog.run(agent, { input: 'my address is 1 Main St', threadId: 't1', userId: 'alice' });
    vi.mocked(backend.chat).mockClear();

    const error = await denial(
      cog.run(agent, { input: 'what is my address?', threadId: 't1', userId: 'bob' })
    );

    expect(error.code).toBe(ErrorCode.THREAD_ACCESS_DENIED);
    expect(backend.chat).not.toHaveBeenCalled();
    const entries = await cog.memory!.getEntries({ threadId: 't1' });
    expect(entries.success && entries.data.map((e) => e.message.role)).toEqual([
      'user',
      'assistant',
    ]);
    await cog.close();
  });

  it('lets several users write to a shared thread', async () => {
    const cog = cogitator();

    await cog.run(agent, {
      input: 'hi',
      threadId: 'group',
      userId: 'alice',
      threadAccess: 'shared',
    });
    const result = await cog.run(agent, {
      input: 'hello',
      threadId: 'group',
      userId: 'bob',
      threadAccess: 'shared',
    });

    expect(result.threadId).toBe('group');
    await cog.close();
  });

  it('fails a run whose thread cannot be read instead of recreating it without its owner', async () => {
    const cog = cogitator();
    await cog.run(agent, { input: 'hi', threadId: 't1', userId: 'alice' });
    const memory = cog.memory!;
    const getThread = vi
      .spyOn(memory, 'getThread')
      .mockResolvedValue({ success: false, error: 'timeout' });
    const createThread = vi.spyOn(memory, 'createThread');

    const owned = await denial(cog.run(agent, { input: 'again', threadId: 't1', userId: 'alice' }));
    await cog.run(agent, { input: 'again', threadId: 't1', userId: 'bob', threadAccess: 'shared' });

    expect(owned.code).toBe(ErrorCode.MEMORY_READ_FAILED);
    expect(createThread).not.toHaveBeenCalled();
    getThread.mockRestore();
    const thread = await memory.getThread('t1');
    expect(thread.success && thread.data && threadOwner(thread.data)).toBe('alice');
    await cog.close();
  });

  it('builds the context for the user of the run', async () => {
    const build = vi.spyOn(ContextBuilder.prototype, 'build');
    const cog = cogitator({ maxTokens: 4000 });

    await cog.run(agent, { input: 'where is my order?', threadId: 't1', userId: 'alice' });

    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 't1',
        userId: 'alice',
        currentInput: 'where is my order?',
      })
    );
    await cog.close();
  });
});
