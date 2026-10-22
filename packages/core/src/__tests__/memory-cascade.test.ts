import { describe, it, expect, vi, afterEach } from 'vitest';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  MemoryAdapter,
  MemoryItemScope,
  NewMemoryItem,
} from '@cogitator-ai/types';
import { InMemoryAdapter, MemoryItems } from '@cogitator-ai/memory';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/** A model that answers memory calls with `memoryCall`, every run with "done" */
function backend(memoryCall: (request: ChatRequest) => Promise<string> | string = () => '[]') {
  const requests: ChatRequest[] = [];
  const llm: LLMBackend = {
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest): Promise<ChatResponse> => {
      requests.push(request);
      const system = String(request.messages[0]?.content ?? '');
      const content = system === 'x' ? 'done' : await memoryCall(request);
      return { id: 'r', content, finishReason: 'stop', usage };
    }),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    }),
  };
  return { llm, requests };
}

const scope: MemoryItemScope = { agentId: 'helper', userId: 'ana' };

function item(content: string, entryIds: string[]): NewMemoryItem {
  return {
    kind: 'fact',
    content,
    subject: 'Ana',
    trust: 'user',
    confidence: 0.9,
    scope,
    evidence: entryIds.map((entryId) => ({ entryId, quote: content })),
    verified: true,
    status: 'active',
    saidAt: new Date('2026-10-01'),
    sessionAt: new Date('2026-10-01'),
  };
}

describe('forget, redactEntries and rewind', () => {
  const cogs: Cogitator[] = [];
  afterEach(async () => {
    for (const cog of cogs.splice(0)) await cog.close();
  });

  const agent = new Agent({ name: 'helper', model: 'mock/m', instructions: 'x' });

  async function runtime(llm: LLMBackend, memory: object = {}) {
    const cog = new Cogitator({
      llm: { backends: { mock: llm } },
      memory: { adapter: 'memory', ...memory },
    });
    cogs.push(cog);
    const store = (await cog.getMemory()) as InMemoryAdapter;
    return { cog, store, items: new MemoryItems({ adapter: store }) };
  }

  async function said(store: MemoryAdapter, threadId: string, contents: string[]) {
    const ids: string[] = [];
    for (const [at, content] of contents.entries()) {
      const added = await store.addEntry({
        threadId,
        message: { role: at % 2 === 0 ? 'user' : 'assistant', content },
        tokenCount: 5,
      });
      if (!added.success) throw new Error(added.error);
      ids.push(added.data.id);
    }
    return ids;
  }

  it('forgets entries with the items that stand on them, going through the agent named', async () => {
    const { llm } = backend();
    const { cog, store, items } = await runtime(llm);
    await store.createThread(agent.id, { userId: 'ana' }, 't');
    const [card, noted, city] = await said(store, 't', [
      'My card is 4111.',
      'Noted.',
      'I live in Porto.',
    ]);
    const [cardItem, cityItem] = await items.write([
      item('Ana has card 4111.', [card!]),
      item('Ana lives in Porto.', [city!]),
    ]);

    const report = await cog.forget({ entryIds: [card!] }, { agents: [agent] });

    expect(report.entries.deleted.sort()).toEqual([card, noted].sort());
    expect(report.items.purged).toEqual([cardItem!.id]);
    expect(await items.get(cityItem!.id)).not.toBeNull();
  });

  it('forgets a user across threads, with the agents its threads name', async () => {
    const { llm } = backend();
    const { cog, store, items } = await runtime(llm);
    await cog.run(agent, { input: 'My card is 4111.', threadId: 'a', userId: 'ana' });
    await cog.run(agent, { input: 'Another chat.', threadId: 'b', userId: 'ana' });
    await cog.run(agent, { input: 'Hello.', threadId: 'c', userId: 'bob' });
    await items.write([item('Ana has card 4111.', [])]);

    await expect(cog.forget({ userId: 'nobody' })).rejects.toThrow('needs the agents');
    const report = await cog.forget({ userId: 'ana' });

    expect(report.threads.sort()).toEqual(['a', 'b']);
    expect((await store.getThread('c')).success).toBe(true);
    expect(await items.query({ scope })).toEqual([]);
  });

  it('redacts entries in place, keeping the thread whole', async () => {
    const { llm } = backend();
    const { cog, store, items } = await runtime(llm);
    await store.createThread(agent.id, { userId: 'ana' }, 't');
    const [card, noted] = await said(store, 't', ['My card is 4111.', 'Noted.']);
    await items.write([item('Ana has card 4111.', [card!])]);

    const report = await cog.redactEntries([card!], { agents: [agent], reason: 'asked' });

    expect(report.entries.redacted).toEqual([card, noted]);
    expect(report.items.purged).toHaveLength(1);
    const entry = await store.getEntry(card!);
    expect(entry.success && entry.data?.message.content).toBe('[redacted]');
  });

  it('rewinds a thread, leaving stale what stood only on the branch it left', async () => {
    const { llm } = backend();
    const { cog, store, items } = await runtime(llm);
    await store.createThread(agent.id, { userId: 'ana' }, 't');
    const [first, , later] = await said(store, 't', [
      'I live in Porto.',
      'Ok.',
      'I moved to Braga.',
    ]);
    const [braga] = await items.write([item('Ana lives in Braga.', [later!])]);

    const report = await cog.rewind('t', first!, { agents: [agent] });

    expect(report.items.stale).toEqual([braga!.id]);
    const thread = await store.getThread('t');
    expect(thread.success && thread.data?.activeLeafId).toBe(first);
  });

  it('finds the agents a thread names, and asks for them for a thread that names none', async () => {
    const { llm } = backend();
    const { cog, store, items } = await runtime(llm);
    await cog.run(agent, { input: 'My card is 4111.', threadId: 'named', userId: 'ana' });
    const thread = await store.getThread('named');
    expect(thread.success && thread.data?.metadata.memoryAgentIds).toEqual(['helper']);
    const path = await store.getEntries({ threadId: 'named' });
    const asked = path.success ? path.data[0] : undefined;
    const [card] = await items.write([item('Ana has card 4111.', [asked!.id])]);

    const report = await cog.forget({ entryIds: [asked!.id] });
    expect(report.items.purged).toEqual([card!.id]);

    await store.createThread('legacy-agent', {}, 'legacy');
    const [old] = await said(store, 'legacy', ['Old turn.']);
    await expect(cog.forget({ entryIds: [old!] })).rejects.toThrow('pass agents');
  });

  it('writes no item from a turn forgotten while the model extracted it', async () => {
    let cog: Cogitator | undefined;
    let store: InMemoryAdapter | undefined;
    const { llm } = backend(async (request) => {
      if (!String(request.messages[0]?.content).startsWith('You keep the long-term memory')) {
        return '[]';
      }
      const turns = await store!.getEntries({ threadId: 'race' });
      const asked = turns.success
        ? turns.data.find((entry) => entry.message.role === 'user')
        : undefined;
      if (asked) await cog!.forget({ entryIds: [asked.id] }, { agents: [agent] });
      return JSON.stringify([
        {
          kind: 'fact',
          content: 'The locker code is 8812.',
          subject: 'the user',
          attribute: 'locker code',
          value: '8812',
          confidence: 0.95,
          evidence: [{ message: 0, quote: 'locker code is 8812' }],
        },
      ]);
    });
    const made = await runtime(llm, { extraction: {} });
    cog = made.cog;
    store = made.store;

    await cog.run(agent, { input: 'My locker code is 8812.', threadId: 'race', userId: 'ana' });

    expect(await made.items.query({ scope })).toEqual([]);
  });

  it('names every agent a run handed over to on the thread', async () => {
    const billing = new Agent({ name: 'billing', model: 'mock/m', instructions: 'billing' });
    const triage = new Agent({
      name: 'triage',
      model: 'mock/m',
      instructions: 'triage',
      handoffs: [billing],
    });
    const llm: LLMBackend = {
      provider: 'openai',
      chat: vi.fn(async (request: ChatRequest): Promise<ChatResponse> =>
        String(request.messages[0]?.content) === 'triage'
          ? {
              id: 't',
              content: '',
              toolCalls: [{ id: 'h', name: 'transfer_to_billing', arguments: { reason: 'money' } }],
              finishReason: 'tool_calls',
              usage,
            }
          : { id: 'b', content: 'billing here', finishReason: 'stop', usage }
      ),
      chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
        yield { id: 's', delta: {}, finishReason: 'stop' };
      }),
    };
    const { cog, store } = await runtime(llm);

    await cog.run(triage, { input: 'refund please', threadId: 'h', userId: 'ana' });

    const thread = await store.getThread('h');
    expect(thread.success && thread.data?.metadata.memoryAgentIds).toEqual(['triage', 'billing']);
  });

  it('drops the paused run of a thread whose entries it forgets', async () => {
    const { llm } = backend();
    const { cog, store } = await runtime(llm);
    await store.createThread(agent.id, { userId: 'ana', memoryAgentIds: ['helper'] }, 't');
    const [card] = await said(store, 't', ['My card is 4111.', 'Noted.']);
    await store.updateThread('t', {
      pausedRun: {
        version: 1,
        threadId: 't',
        messages: [{ role: 'user', content: 'My card is 4111.' }],
      },
    });

    await cog.forget({ entryIds: [card!] });

    const thread = await store.getThread('t');
    expect(thread.success && thread.data?.metadata.pausedRun).toBeNull();
  });

  it('stops extracting a branch a rewind left, before its next model call', async () => {
    let store: InMemoryAdapter | undefined;
    let first: string | undefined;
    let calls = 0;
    const { llm } = backend(async (request) => {
      if (!String(request.messages[0]?.content).startsWith('You keep the long-term memory')) {
        return '[]';
      }
      calls++;
      if (calls === 1 && store && first) await store.checkout('t', first);
      return '[]';
    });
    const made = await runtime(llm, { extraction: { windowTokens: 30 } });
    store = made.store;
    await store.createThread(agent.id, { userId: 'ana' }, 't');
    const ids = await said(
      store,
      't',
      Array.from({ length: 12 }, (_, at) => `Turn ${at} with some words to fill the window up.`)
    );
    first = ids[0];
    await store.updateThread('t', { memoryExtraction: { through: null } });

    await made.cog.run(agent, { input: 'one more', threadId: 't', userId: 'ana' });

    expect(calls).toBe(1);
  });

  it('stops compacting a branch a rewind left, before its next model call', async () => {
    let store: InMemoryAdapter | undefined;
    let first: string | undefined;
    let chapters = 0;
    const { llm } = backend(async (request) => {
      if (!String(request.messages[0]?.content).startsWith('You compact')) return 'noted';
      chapters++;
      if (chapters === 1 && store && first) await store.checkout('t', first);
      return '[]';
    });
    const made = await runtime(llm, {
      compaction: { at: 0.001, keepRecentTokens: 1, chapterTokens: 20 },
    });
    store = made.store;
    await store.createThread(agent.id, {}, 't');
    const ids = await said(
      store,
      't',
      Array.from({ length: 16 }, (_, at) => `Turn ${at} with some words to fill a chapter.`)
    );
    first = ids[0];

    await made.cog.run(agent, { input: 'one more', threadId: 't' });

    expect(chapters).toBe(1);
    const all = await store.getEntries({ threadId: 't', types: 'all' });
    expect(all.success && all.data.some((entry) => entry.type === 'compaction')).toBe(false);
  });
});
