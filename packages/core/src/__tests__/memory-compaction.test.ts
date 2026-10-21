import { describe, it, expect, vi, afterEach } from 'vitest';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  CompactionEvent,
  LLMBackend,
} from '@cogitator-ai/types';
import { HISTORY_ENTRY_TYPES, compactedHistory } from '@cogitator-ai/memory';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { getLogger } from '../logger';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/** Answers a chapter request with one atom, every other request with a long echo */
function backend(): LLMBackend & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest): Promise<ChatResponse> => {
      requests.push(request);
      const system = String(request.messages[0]?.content ?? '');
      const content = system.startsWith('You compact')
        ? '[{"kind":"task","status":"open","text":"Plan the trip to Rome","evidence":[{"message":0,"quote":"plan the trip"}]}]'
        : `noted ${'word '.repeat(300)}`;
      return { id: 'r', content, finishReason: 'stop', usage };
    }),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    }),
  };
}

describe('memory.compaction', () => {
  const cogs: Cogitator[] = [];
  afterEach(async () => {
    for (const cog of cogs.splice(0)) await cog.close();
    vi.restoreAllMocks();
  });

  function runtime(llm: LLMBackend, compaction: object) {
    const cog = new Cogitator({
      llm: { backends: { mock: llm } },
      memory: { adapter: 'memory', compaction },
    });
    cogs.push(cog);
    return cog;
  }

  async function conversation(cog: Cogitator) {
    const memory = (await cog.getMemory())!;
    const path = await memory.getPath!({ threadId: 't', types: HISTORY_ENTRY_TYPES });
    if (!path.success) throw new Error(path.error);
    return compactedHistory(path.data);
  }

  const agent = new Agent({ name: 'a', model: 'mock/m', instructions: 'x' });

  it('compacts the thread after a run that outgrew the share of the window', async () => {
    const llm = backend();
    const afterCompact = vi.fn();
    const cog = runtime(llm, { at: 0.001, keepRecentTokens: 1, afterCompact });

    await cog.run(agent, { input: 'please plan the trip', threadId: 't' });
    await cog.run(agent, { input: 'and the hotel', threadId: 't' });

    const [summary] = await conversation(cog);
    expect(summary?.type).toBe('compaction');
    expect(String(summary?.message.content)).toContain('- Plan the trip to Rome');
    expect((summary?.event as unknown as CompactionEvent).levels?.chapters.length).toBeGreaterThan(
      0
    );
    expect(afterCompact).toHaveBeenCalled();
  });

  it('lets beforeCompact cancel, and leaves threads under the share alone', async () => {
    const beforeCompact = vi.fn(() => false as const);
    const cancelled = runtime(backend(), { at: 0.001, beforeCompact });
    await cancelled.run(agent, { input: 'please plan the trip', threadId: 't' });
    expect(beforeCompact).toHaveBeenCalled();
    expect((await conversation(cancelled)).some((e) => e.type === 'compaction')).toBe(false);

    const roomy = runtime(backend(), { at: 1 });
    await roomy.run(agent, { input: 'please plan the trip', threadId: 't' });
    expect((await conversation(roomy)).some((e) => e.type === 'compaction')).toBe(false);
  });

  it('does not compact again right after a compaction, and keeps the result when it fails', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const cog = runtime(backend(), { at: 0.001, keepRecentTokens: 1 });
    await cog.run(agent, { input: 'please plan the trip', threadId: 't' });
    await cog.run(agent, { input: 'and the hotel', threadId: 't' });

    await cog.run(agent, { input: 'and the flights', threadId: 't' });

    expect(
      warn.mock.calls.some(([message]) => String(message).includes('clear tool outputs'))
    ).toBe(true);

    const failing = backend();
    vi.mocked(failing.chat).mockImplementation(async (request) => {
      if (String(request.messages[0]?.content).startsWith('You compact')) throw new Error('down');
      return { id: 'r', content: 'ok', finishReason: 'stop', usage };
    });
    const broken = runtime(failing, { at: 0.001 });
    const result = await broken.run(agent, { input: 'please plan the trip', threadId: 't' });
    expect(result.output).toBe('ok');
  });

  it('leaves alone a run that wrote aside of the active branch', async () => {
    const cog = runtime(backend(), { at: 0.001, keepRecentTokens: 1 });
    const memory = (await cog.getMemory())!;
    const count = async () => {
      const all = await memory.getEntries({ threadId: 't', types: 'all' });
      return all.success ? all.data.filter((e) => e.type === 'compaction').length : -1;
    };
    const root = await cog.run(agent, { input: 'please plan the trip', threadId: 't' });
    const before = await count();

    await cog.run(agent, {
      input: 'what about Paris',
      threadId: 't',
      branch: { fromEntryId: root.memory!.branchPoint, activate: false },
    });

    expect(await count()).toBe(before);
  });
});
