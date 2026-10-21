import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  MemoryAdapter,
} from '@cogitator-ai/types';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { TimeTravel } from '../time-travel/index';
import { createLLMError } from '../llm/errors';
import { CompactionService } from '@cogitator-ai/memory';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/** Answers each request with what it read last, so a test sees the history a run got */
function echoingBackend(): LLMBackend & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest): Promise<ChatResponse> => {
      requests.push({ ...request, messages: [...request.messages] });
      const last = request.messages.at(-1);
      return {
        id: 'r',
        content: `re: ${String(last?.content)}`,
        finishReason: 'stop',
        usage,
      };
    }),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    }),
  };
}

const agent = new Agent({ name: 'a', model: 'mock/m', instructions: 'Answer.' });

const contents = (messages: readonly { content: unknown }[]) =>
  messages.map((m) => String(m.content));

describe('runs on branches of a thread', () => {
  const cogs: Cogitator[] = [];
  afterEach(async () => {
    for (const cog of cogs.splice(0)) await cog.close();
  });

  function runtime(backend: LLMBackend) {
    const cog = new Cogitator({
      llm: { backends: { mock: backend } },
      memory: { adapter: 'memory' },
    });
    cogs.push(cog);
    return cog;
  }

  async function memoryOf(cog: Cogitator): Promise<MemoryAdapter> {
    const memory = await cog.getMemory();
    if (!memory) throw new Error('no memory');
    return memory;
  }

  it('reports where a run wrote, after the active leaf', async () => {
    const cog = runtime(echoingBackend());
    const first = await cog.run(agent, { input: 'one', threadId: 't' });
    const second = await cog.run(agent, { input: 'two', threadId: 't' });

    expect(first.memory?.branchPoint).toBeNull();
    expect(second.memory?.branchPoint).toBe(first.memory?.leafId);
    const thread = await (await memoryOf(cog)).getThread('t');
    expect(thread.success && thread.data?.activeLeafId).toBe(second.memory?.leafId);
  });

  it('reads history along the branch and leaves the active leaf when not activated', async () => {
    const backend = echoingBackend();
    const cog = runtime(backend);
    const first = await cog.run(agent, { input: 'one', threadId: 't' });
    await cog.run(agent, { input: 'two', threadId: 't' });
    const memory = await memoryOf(cog);
    const leafBefore = (await memory.getThread('t')).success
      ? ((await memory.getThread('t')) as { data: { activeLeafId?: string } }).data.activeLeafId
      : undefined;

    const fork = await cog.run(agent, {
      input: 'instead',
      threadId: 't',
      branch: { fromEntryId: first.memory!.leafId!, activate: false },
    });

    expect(contents(backend.requests.at(-1)!.messages.slice(1))).toEqual([
      'one',
      're: one',
      'instead',
    ]);
    expect(fork.memory?.branchPoint).toBe(first.memory?.leafId);
    const thread = await memory.getThread('t');
    expect(thread.success && thread.data?.activeLeafId).toBe(leafBefore);
    const branch = await memory.getPath!({ threadId: 't', leafId: fork.memory!.leafId! });
    expect(branch.success && contents(branch.data.map((e) => e.message))).toEqual([
      'one',
      're: one',
      'instead',
      're: instead',
    ]);
  });

  it('starts a new root for a branch from null, and refuses an entry of another thread', async () => {
    const backend = echoingBackend();
    const cog = runtime(backend);
    await cog.run(agent, { input: 'one', threadId: 't' });
    const other = await cog.run(agent, { input: 'elsewhere', threadId: 'u' });

    const fresh = await cog.run(agent, {
      input: 'fresh start',
      threadId: 't',
      branch: { fromEntryId: null, activate: false },
    });

    expect(contents(backend.requests.at(-1)!.messages.slice(1))).toEqual(['fresh start']);
    expect(fresh.memory?.branchPoint).toBeNull();
    const refused = await cog
      .run(agent, { input: 'x', threadId: 't', branch: { fromEntryId: other.memory!.leafId! } })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CogitatorError);
    expect((refused as CogitatorError).code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('builds the context from the active branch only', async () => {
    const backend = echoingBackend();
    const cog = runtime(backend);
    const first = await cog.run(agent, { input: 'keep this', threadId: 't' });
    await cog.run(agent, { input: 'drop this', threadId: 't' });
    const memory = await memoryOf(cog);
    await memory.rewind!('t', first.memory!.leafId!);

    await cog.run(agent, { input: 'go on', threadId: 't' });

    expect(contents(backend.requests.at(-1)!.messages.slice(1))).toEqual([
      'keep this',
      're: keep this',
      'go on',
    ]);
  });

  it('reads a compacted thread as its summary and the entries it kept', async () => {
    const backend = echoingBackend();
    const cog = runtime(backend);
    await cog.run(agent, { input: 'one', threadId: 't' });
    await cog.run(agent, { input: 'two', threadId: 't' });
    const compaction = new CompactionService({
      adapter: await memoryOf(cog),
      summarize: async () => 'they said one',
    });
    await compaction.compact('t', { strategy: 'summary', threshold: 0, keepRecent: 2 });

    await cog.run(agent, { input: 'three', threadId: 't' });

    expect(contents(backend.requests.at(-1)!.messages.slice(1))).toEqual([
      '[Conversation summary]\nthey said one',
      'two',
      're: two',
      'three',
    ]);
  });

  it('records a pause for approval and goes on along the branch when resumed', async () => {
    const refund = tool({
      name: 'refund',
      description: 'Refund',
      parameters: z.object({ order: z.string() }),
      requiresApproval: true,
      execute: async ({ order }) => `refunded ${order}`,
    });
    let calls = 1;
    const backend: LLMBackend = {
      provider: 'openai',
      chat: vi.fn(async (): Promise<ChatResponse> => {
        calls++;
        return calls === 1
          ? {
              id: 'r',
              content: '',
              toolCalls: [{ id: 'c1', name: 'refund', arguments: { order: '7' } }],
              finishReason: 'tool_calls',
              usage,
            }
          : { id: 'r', content: 'done', finishReason: 'stop', usage };
      }),
      chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
        yield { id: 's', delta: {}, finishReason: 'stop' };
      }),
    };
    const cog = runtime(backend);
    const refunds = new Agent({ name: 'r', model: 'mock/m', instructions: 'x', tools: [refund] });
    const first = await cog.run(refunds, { input: 'hello', threadId: 't' });
    calls = 0;

    const paused = await cog.run(refunds, {
      input: 'refund 7',
      threadId: 't',
      branch: { fromEntryId: first.memory!.leafId!, activate: false },
    });
    expect(paused.status).toBe('paused');
    const resumed = await cog.resume(refunds, paused.checkpoint!, {
      decisions: { c1: { approved: true } },
    });

    const memory = await memoryOf(cog);
    const branch = await memory.getPath!({
      threadId: 't',
      leafId: resumed.memory!.leafId!,
      types: 'all',
    });
    expect(branch.success && branch.data.map((e) => e.type)).toEqual([
      'message',
      'message',
      'message',
      'message',
      'approval',
      'tool_result',
      'message',
    ]);
    const approval = branch.success ? branch.data[4] : undefined;
    expect(approval?.event).toEqual({ pending: [{ toolCallId: 'c1', toolName: 'refund' }] });
    const thread = await memory.getThread('t');
    expect(thread.success && thread.data?.activeLeafId).toBe(first.memory?.leafId);
  });

  it('keeps the paused run of a thread while a run aside of it pauses and resumes', async () => {
    const refund = tool({
      name: 'refund',
      description: 'Refund',
      parameters: z.object({ order: z.string() }),
      requiresApproval: true,
      execute: async ({ order }) => `refunded ${order}`,
    });
    const backend: LLMBackend = {
      provider: 'openai',
      chat: vi.fn(async (request: ChatRequest): Promise<ChatResponse> =>
        request.messages.at(-1)?.role === 'tool'
          ? { id: 'r', content: 'done', finishReason: 'stop', usage }
          : {
              id: 'r',
              content: '',
              toolCalls: [
                { id: `c${request.messages.length}`, name: 'refund', arguments: { order: '7' } },
              ],
              finishReason: 'tool_calls',
              usage,
            }
      ),
      chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
        yield { id: 's', delta: {}, finishReason: 'stop' };
      }),
    };
    const cog = runtime(backend);
    const refunds = new Agent({ name: 'r', model: 'mock/m', instructions: 'x', tools: [refund] });
    const main = await cog.run(refunds, { input: 'refund 7', threadId: 't' });
    expect(main.status).toBe('paused');

    const aside = await cog.run(refunds, {
      input: 'refund 7 again',
      threadId: 't',
      branch: { fromEntryId: null, activate: false },
    });
    expect(aside.status).toBe('paused');
    const asideDone = await cog.resume(refunds, aside.checkpoint!, {
      decisions: Object.fromEntries(
        aside.pendingApprovals!.map((p) => [p.toolCallId, { approved: true }])
      ),
    });
    expect(asideDone.memory?.branchPoint).toBeNull();

    const mainDone = await cog.resume(refunds, 't', {
      decisions: Object.fromEntries(
        main.pendingApprovals!.map((p) => [p.toolCallId, { approved: true }])
      ),
    });
    expect(mainDone.output).toBe('done');
    expect(mainDone.memory?.branchPoint).toBe(main.memory?.branchPoint);
    const path = await (await memoryOf(cog)).getPath!({ threadId: 't' });
    expect(path.success && path.data.map((e) => e.message.content)).toEqual([
      'refund 7',
      '',
      '"refunded 7"',
      'done',
    ]);
  });

  it('answers the calls of an abandoned pause on the branch that paused, not the new run', async () => {
    const refund = tool({
      name: 'refund',
      description: 'Refund',
      parameters: z.object({ order: z.string() }),
      requiresApproval: true,
      execute: async ({ order }) => `refunded ${order}`,
    });
    let calls = 0;
    const backend: LLMBackend = {
      provider: 'openai',
      chat: vi.fn(async (): Promise<ChatResponse> => {
        calls++;
        return calls === 2
          ? {
              id: 'r',
              content: '',
              toolCalls: [{ id: 'c1', name: 'refund', arguments: { order: '7' } }],
              finishReason: 'tool_calls',
              usage,
            }
          : { id: 'r', content: 'ok', finishReason: 'stop', usage };
      }),
      chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
        yield { id: 's', delta: {}, finishReason: 'stop' };
      }),
    };
    const cog = runtime(backend);
    const refunds = new Agent({ name: 'r', model: 'mock/m', instructions: 'x', tools: [refund] });
    const first = await cog.run(refunds, { input: 'hello', threadId: 't' });
    const paused = await cog.run(refunds, { input: 'refund 7', threadId: 't' });
    expect(paused.status).toBe('paused');

    await cog.run(refunds, {
      input: 'never mind',
      threadId: 't',
      branch: { fromEntryId: first.memory!.leafId! },
    });

    const memory = await memoryOf(cog);
    const all = await memory.getEntries({ threadId: 't', types: 'all', includeToolCalls: true });
    if (!all.success) throw new Error(all.error);
    const assistantCall = all.data.find((e) => e.toolCalls?.length);
    const approval = all.data.find((e) => e.type === 'approval');
    const answer = all.data.find((e) => e.type === 'tool_result');
    expect(approval?.parentId).toBe(assistantCall?.id);
    expect(answer?.parentId).toBe(approval?.id);
  });

  it('keeps writing after a memory error a callback turns fatal', async () => {
    const failing: LLMBackend = {
      provider: 'openai',
      chat: vi.fn(async () => {
        throw createLLMError({ provider: 'openai', model: 'm' }, 503, '{"error":{"message":"x"}}', {
          kind: 'overloaded',
        });
      }),
      chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
        yield { id: 's', delta: {}, finishReason: 'stop' };
      }),
    };
    const cog = new Cogitator({
      llm: {
        backends: { primary: failing, backup: echoingBackend() },
        retry: { maxRetries: 0, baseDelay: 1, maxDelay: 1 },
      },
      memory: { adapter: 'memory' },
    });
    cogs.push(cog);
    const memory = await memoryOf(cog);
    const add = memory.addEntry.bind(memory);
    memory.addEntry = async (entry) =>
      entry.type === 'model_change' ? { success: false, error: 'disk full' } : add(entry);
    const writer = new Agent({
      name: 'w',
      model: 'primary/fast',
      fallbackModels: ['backup/steady'],
      instructions: 'x',
    });

    const result = await cog.run(writer, {
      input: 'draft',
      threadId: 't',
      onMemoryError: (error) => {
        throw error;
      },
    });

    expect(result.output).toBe('re: draft');
    const path = await memory.getPath!({ threadId: 't' });
    expect(path.success && path.data.map((e) => e.message.content)).toEqual(['draft', 're: draft']);
  });

  it('records a model change on fallback before the answer', async () => {
    const failing: LLMBackend = {
      provider: 'openai',
      chat: vi.fn(async () => {
        throw createLLMError({ provider: 'openai', model: 'm' }, 503, '{"error":{"message":"x"}}', {
          kind: 'overloaded',
        });
      }),
      chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
        yield { id: 's', delta: {}, finishReason: 'stop' };
      }),
    };
    const cog = new Cogitator({
      llm: {
        backends: { primary: failing, backup: echoingBackend() },
        retry: { maxRetries: 0, baseDelay: 1, maxDelay: 1 },
      },
      memory: { adapter: 'memory' },
    });
    cogs.push(cog);
    const writer = new Agent({
      name: 'w',
      model: 'primary/fast',
      fallbackModels: ['backup/steady'],
      instructions: 'x',
    });

    await cog.run(writer, { input: 'draft', threadId: 't' });

    const all = await (await memoryOf(cog)).getPath!({ threadId: 't', types: 'all' });
    expect(all.success && all.data.map((e) => e.type)).toEqual([
      'message',
      'model_change',
      'message',
    ]);
    expect(all.success && all.data[1]?.event).toMatchObject({
      from: 'primary/fast',
      to: 'backup/steady',
    });
  });

  it('writes nothing to a thread of another user when the run is stopped before it starts', async () => {
    const cog = runtime(echoingBackend());
    const owned = await cog.run(agent, { input: 'mine', threadId: 't', userId: 'alice' });
    const controller = new AbortController();
    controller.abort(new Error('stopped'));

    await cog
      .run(agent, { input: 'x', threadId: 't', userId: 'bob', signal: controller.signal })
      .catch(() => undefined);

    const memory = await memoryOf(cog);
    const all = await memory.getPath!({ threadId: 't', types: 'all' });
    expect(all.success && all.data.map((e) => e.type)).toEqual(['message', 'message']);
    const thread = await memory.getThread('t');
    expect(thread.success && thread.data?.activeLeafId).toBe(owned.memory?.leafId);
  });

  it('records an interrupted run', async () => {
    const slow: LLMBackend = {
      provider: 'openai',
      chat: vi.fn(
        (_request: ChatRequest, signal?: AbortSignal) =>
          new Promise<ChatResponse>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })
      ),
      chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
        yield { id: 's', delta: {}, finishReason: 'stop' };
      }),
    };
    const cog = runtime(slow);
    const controller = new AbortController();

    const run = cog.run(agent, { input: 'wait', threadId: 't', signal: controller.signal });
    setTimeout(() => controller.abort(new Error('the user stopped it')), 20);
    await run.catch(() => undefined);

    const all = await (await memoryOf(cog)).getPath!({ threadId: 't', types: 'all' });
    expect(all.success && all.data.map((e) => e.type)).toEqual(['message', 'interrupt']);
  });

  it('replays forks of one run on branches that never see each other', async () => {
    const backend = echoingBackend();
    const cog = runtime(backend);
    await cog.run(agent, { input: 'before', threadId: 't' });
    const run = await cog.run(agent, { input: 'question', threadId: 't' });
    const tt = new TimeTravel(cog);
    const checkpoint = await tt.checkpoint(run, 0);

    const a = await tt.replay(agent, checkpoint.id, { mode: 'live' });
    const b = await tt.replay(agent, checkpoint.id, { mode: 'live' });

    expect(a.memory?.threadId).toBe('t');
    expect(a.memory?.branchPoint).toBe(run.memory?.branchPoint);
    expect(b.memory?.branchPoint).toBe(run.memory?.branchPoint);
    expect(contents(backend.requests.at(-1)!.messages.slice(1))).toEqual([
      'before',
      're: before',
      'question',
    ]);
    const thread = await (await memoryOf(cog)).getThread('t');
    expect(thread.success && thread.data?.activeLeafId).toBe(run.memory?.leafId);
  });

  it('forks with a new input on a branch, and keeps edits of the earlier conversation off memory', async () => {
    const backend = echoingBackend();
    const cog = runtime(backend);
    await cog.run(agent, { input: 'before', threadId: 't' });
    const run = await cog.run(agent, { input: 'question', threadId: 't' });
    const tt = new TimeTravel(cog);
    const checkpoint = await tt.checkpoint(run, 0);

    const forked = await tt.fork(agent, checkpoint.id, { input: 'another question' });
    expect(forked.result.memory).toMatchObject({
      threadId: 't',
      branchPoint: run.memory?.branchPoint,
    });
    expect(contents(backend.requests.at(-1)!.messages.slice(1))).toEqual([
      'before',
      're: before',
      'another question',
    ]);

    const edited = await tt.replay(agent, checkpoint.id, {
      mode: 'live',
      modifiedMessages: checkpoint.messages.map((message) =>
        message.content === 'before' ? { ...message, content: 'rewritten' } : message
      ),
    });
    expect(edited.memory?.threadId).toMatch(/^replay_/);
    expect(contents(backend.requests.at(-1)!.messages.slice(1))).toEqual(['question']);
  });

  it('replays on a branch of a user thread only as that user', async () => {
    const cog = runtime(echoingBackend());
    await cog.run(agent, { input: 'before', threadId: 't', userId: 'alice' });
    const run = await cog.run(agent, { input: 'question', threadId: 't', userId: 'alice' });
    const tt = new TimeTravel(cog);
    const checkpoint = await tt.checkpoint(run, 0);

    const anonymous = await tt.replay(agent, checkpoint.id, { mode: 'live' });
    const asAlice = await tt.fork(agent, checkpoint.id, { input: 'again', userId: 'alice' });

    expect(anonymous.memory?.threadId).toMatch(/^replay_/);
    expect(asAlice.result.memory).toMatchObject({
      threadId: 't',
      branchPoint: run.memory?.branchPoint,
    });
  });

  it('replays on a thread of its own once the place the run started from is gone', async () => {
    const backend = echoingBackend();
    const cog = runtime(backend);
    await cog.run(agent, { input: 'before', threadId: 't' });
    const run = await cog.run(agent, { input: 'question', threadId: 't' });
    const tt = new TimeTravel(cog);
    const checkpoint = await tt.checkpoint(run, 0);
    await (await memoryOf(cog)).deleteEntry(run.memory!.branchPoint!);

    const replayed = await tt.replay(agent, checkpoint.id, { mode: 'live' });

    expect(replayed.memory?.threadId).toMatch(/^replay_/);
    const system = String(backend.requests.at(-1)!.messages[0]?.content);
    expect(system).toContain('re: before');
    expect(contents(backend.requests.at(-1)!.messages.slice(1))).toEqual(['question']);
  });
});
