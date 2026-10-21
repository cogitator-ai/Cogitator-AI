import { describe, it, expect, vi, afterEach } from 'vitest';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  MemoryItemScope,
  NewMemoryItem,
} from '@cogitator-ai/types';
import { InMemoryAdapter, MemoryItems, OBSERVATIONS_DIRECTORY } from '@cogitator-ai/memory';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { memoryUpkeepMiddleware } from '../middleware/memory-consolidation';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

type Answer = (request: ChatRequest) => Promise<string> | string;

/** A model that answers each kind of memory call with its own answer, and every run with "done" */
function backend(answers: { observe?: Answer; dedupe?: Answer; playbook?: Answer }) {
  const requests: ChatRequest[] = [];
  const llm: LLMBackend = {
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest): Promise<ChatResponse> => {
      requests.push(request);
      const system = String(request.messages[0]?.content ?? '');
      const answer = system.startsWith('You write what long-term memory makes')
        ? answers.observe
        : system.startsWith('You keep the long-term memory of an assistant tidy')
          ? answers.dedupe
          : system.startsWith('You keep the playbook')
            ? answers.playbook
            : undefined;
      const content = answer ? await answer(request) : 'done';
      return { id: 'r', content, finishReason: 'stop', usage };
    }),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    }),
  };
  return { llm, requests };
}

const idsIn = (request: ChatRequest) =>
  [...String(request.messages[1]?.content).matchAll(/id="(mem_[^"]+)"/g)].map((m) => m[1]!);

const scope: MemoryItemScope = { agentId: 'helper', userId: 'ana' };

function item(content: string, kind: NewMemoryItem['kind'] = 'fact'): NewMemoryItem {
  return {
    kind,
    content,
    subject: 'Ana',
    trust: 'user',
    confidence: 0.9,
    scope,
    evidence: [{ quote: content }],
    verified: true,
    status: 'active',
    saidAt: new Date('2026-10-01'),
    sessionAt: new Date('2026-10-01'),
  };
}

const lastUser = (request: ChatRequest | undefined) =>
  String([...(request?.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '');

describe('memory upkeep', () => {
  const cogs: Cogitator[] = [];
  afterEach(async () => {
    for (const cog of cogs.splice(0)) await cog.close();
  });

  const agent = new Agent({ name: 'helper', model: 'mock/m', instructions: 'x' });

  async function runtime(llm: LLMBackend, memory: object) {
    const cog = new Cogitator({
      llm: { backends: { mock: llm } },
      memory: {
        adapter: 'memory',
        contextBuilder: { maxTokens: 8000, strategy: 'recent', includeFacts: true },
        ...memory,
      },
    });
    cogs.push(cog);
    const store = await cog.getMemory();
    if (!(store instanceof InMemoryAdapter)) throw new Error('no memory');
    return { cog, items: new MemoryItems({ adapter: store }), store };
  }

  it('writes observations after a run without holding it back, and shows them when named', async () => {
    let release: (() => void) | undefined;
    const { llm, requests } = backend({
      observe: async (request) => {
        await new Promise<void>((resolve) => (release = resolve));
        return JSON.stringify([
          { text: 'Ana works nights as a nurse in Porto.', items: idsIn(request) },
        ]);
      },
    });
    const { cog, items, store } = await runtime(llm, { observations: {} });
    await items.write([
      item('Ana lives in Porto.'),
      item('Ana works as a nurse.'),
      item('Ana works night shifts.'),
    ]);

    const first = await cog.run(agent, { input: 'hello', threadId: 't', userId: 'ana' });
    expect(first.output).toBe('done');
    await vi.waitFor(() => expect(release).toBeDefined());
    release?.();
    await vi.waitFor(async () => {
      const files = await store.findFileVersions({ agentId: 'helper', visibleTo: scope });
      expect(
        files.success && files.data.some((v) => v.path === `${OBSERVATIONS_DIRECTORY}/ana.md`)
      ).toBe(true);
    });

    await cog.run(agent, { input: 'When can I call Ana?', threadId: 't', userId: 'ana' });
    const turn = lastUser(requests.filter((r) => String(r.messages[0]?.content) === 'x').at(-1));
    expect(turn).toContain('What memory makes of them');
    expect(turn).toContain('Ana works nights as a nurse in Porto.');
  });

  it('consolidates every few runs: repeats go stale and lessons reach the playbook the next run sees', async () => {
    const { llm, requests } = backend({
      dedupe: (request) => {
        const [keep, drop] = idsIn(request);
        return JSON.stringify([{ keep, drop: [drop], reason: 'duplicate' }]);
      },
      playbook: (request) => {
        const lesson = /id="(mem_[^"]+)"/.exec(String(request.messages[1]?.content))?.[1];
        return JSON.stringify([
          { add: 'Confirm the time zone before booking.', lessons: [lesson] },
        ]);
      },
    });
    const { cog, items } = await runtime(llm, { consolidation: { everyRuns: 2 } });
    const [porto, oporto] = await items.write([
      item('Ana lives in Porto.'),
      item('Ana is based in Oporto.'),
      item('Asking the time zone first avoided a wrong booking.', 'lesson'),
    ]);

    await cog.run(agent, { input: 'one', threadId: 't', userId: 'ana' });
    expect(requests.some((r) => String(r.messages[0]?.content).startsWith('You keep'))).toBe(false);

    await cog.run(agent, { input: 'two', threadId: 't', userId: 'ana' });
    await vi.waitFor(async () => expect((await items.get(oporto!.id))?.status).toBe('stale'));
    expect((await items.get(porto!.id))?.status).toBe('active');

    await vi.waitFor(async () => {
      await cog.run(agent, { input: 'three', threadId: 't', userId: 'ana' });
      const turn = lastUser(requests.filter((r) => String(r.messages[0]?.content) === 'x').at(-1));
      expect(turn).toContain('The playbook memory keeps');
      expect(turn).toContain('Confirm the time zone before booking.');
    });
    const other = await cog.run(agent, { input: 'hi', threadId: 'b', userId: 'bob' });
    expect(other.output).toBe('done');
    const bobTurn = lastUser(requests.filter((r) => String(r.messages[0]?.content) === 'x').at(-1));
    expect(bobTurn).not.toContain('The playbook memory keeps');
  });

  it('runs a pass on demand and reports what it changed', async () => {
    const { llm } = backend({
      playbook: (request) => {
        const lesson = /id="(mem_[^"]+)"/.exec(String(request.messages[1]?.content))?.[1];
        return JSON.stringify([{ add: 'Keep answers short.', lessons: [lesson] }]);
      },
    });
    const { cog, items } = await runtime(llm, { consolidation: { playbook: 'shadow' } });
    await items.write([item('Short answers worked better.', 'lesson')]);

    const report = await cog.consolidateMemory(agent, { userId: 'ana' });

    expect(report.scope).toEqual(scope);
    expect(report.playbook).toMatchObject({ path: '/memories/playbook.next.md', edits: 1 });
    expect(report.stale).toEqual([]);
    await expect(cog.consolidateMemory(agent)).rejects.toThrow('needs a userId');
  });

  it('refuses a pass on demand when no upkeep is set up', async () => {
    const { llm } = backend({});
    const { cog } = await runtime(llm, {});
    await expect(cog.consolidateMemory(agent, { userId: 'ana' })).rejects.toThrow(
      'consolidateMemory needs memory.consolidation or memory.observations'
    );
  });
});

describe('memoryUpkeepMiddleware', () => {
  it('passes after a compaction before the runs add up, and stops passes on close', async () => {
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    await adapter.createThread('helper', { userId: 'ana' }, 't');
    let calls = 0;
    const upkeep = memoryUpkeepMiddleware(
      { consolidation: { everyRuns: 50, playbook: false } },
      {
        memory: () => adapter,
        summarizer: (_model, run) => async () => {
          run.signal?.throwIfAborted();
          calls++;
          return '[]';
        },
      }
    );
    await new MemoryItems({ adapter }).write([item('Ana likes tea.'), item('Ana enjoys tea.')]);
    const event = {
      result: {
        runId: 'r',
        agentId: 'helper',
        memory: { threadId: 't', leafId: null, branchPoint: null },
      },
      model: 'mock/m',
      memoryAgentId: 'helper',
    } as unknown as Parameters<NonNullable<typeof upkeep.afterRun>>[0];
    const context = {
      runId: 'r',
      agentId: 'helper',
      userId: 'ana',
      iteration: 1,
      signal: new AbortController().signal,
      state: new Map(),
    } as unknown as Parameters<NonNullable<typeof upkeep.afterRun>>[1];

    await upkeep.afterRun?.(event, context);
    await upkeep.close();
    expect(calls).toBe(0);

    const again = memoryUpkeepMiddleware(
      { consolidation: { everyRuns: 50, playbook: false } },
      {
        memory: () => adapter,
        summarizer: (_model, run) => async () => {
          run.signal?.throwIfAborted();
          calls++;
          return '[]';
        },
      }
    );
    again.noteCompaction('t');
    await again.afterRun?.(event, context);
    await vi.waitFor(() => expect(calls).toBe(1));
    const thread = await adapter.getThread('t');
    expect(thread.success && thread.data?.metadata.memoryConsolidation).toMatchObject({ runs: 0 });
    await again.close();
  });

  it('refuses settings it cannot run with', () => {
    const deps = { memory: () => undefined, summarizer: () => async () => '' };
    expect(() => memoryUpkeepMiddleware({ consolidation: { everyRuns: 0 } }, deps)).toThrow(
      'memory.consolidation.everyRuns must be a whole number above 0'
    );
    expect(() => memoryUpkeepMiddleware({ observations: { minItems: 1.5 } }, deps)).toThrow(
      'memory.observations.minItems must be a whole number above 0'
    );
  });
});
