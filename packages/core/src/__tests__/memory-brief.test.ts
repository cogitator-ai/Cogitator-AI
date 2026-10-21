import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ChatRequest, ChatResponse, ChatStreamChunk, LLMBackend } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { InMemoryAdapter } from '@cogitator-ai/memory';
import { memoryBriefMiddleware } from '../middleware/memory-brief';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

const isBrief = (request: ChatRequest) =>
  String(request.messages[0]?.content ?? '').startsWith('You read what long-term memory found');

/** A model that answers a brief with `briefAnswer` and every other turn with "done" */
function backend(
  briefAnswer: (request: ChatRequest) => Promise<string>
): LLMBackend & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest): Promise<ChatResponse> => {
      requests.push(request);
      const content = isBrief(request) ? await briefAnswer(request) : 'done';
      return { id: 'r', content, finishReason: 'stop', usage };
    }),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    }),
  };
}

const lastUser = (request: ChatRequest | undefined) =>
  String([...(request?.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '');

describe('memory.brief', () => {
  const cogs: Cogitator[] = [];
  afterEach(async () => {
    for (const cog of cogs.splice(0)) await cog.close();
  });

  async function runtime(llm: LLMBackend, brief: object = {}) {
    const cog = new Cogitator({
      llm: { backends: { mock: llm } },
      memory: { adapter: 'memory', brief },
    });
    cogs.push(cog);
    const memory = await cog.getMemory();
    if (!memory) throw new Error('no memory');
    await memory.createThread('helper', { userId: 'ana' }, 't');
    await memory.addEntry({
      threadId: 't',
      message: { role: 'user', content: 'Please always answer me in Portuguese, it is easier.' },
      tokenCount: 10,
    });
    await memory.addEntry({
      threadId: 't',
      message: { role: 'assistant', content: 'Combinado.' },
      tokenCount: 2,
    });
    return cog;
  }

  const agent = new Agent({ name: 'helper', model: 'mock/m', instructions: 'x' });

  it('puts the cards whose quotes hold into the turn, as a hint', async () => {
    const llm = backend(async (request) => {
      const ref = /ref="(turn:[^"]+)"/.exec(String(request.messages[1]?.content))?.[1];
      return JSON.stringify([
        {
          kind: 'constraint',
          text: 'Answer in Portuguese.',
          quote: 'always answer me in Portuguese',
          source: ref,
        },
        { kind: 'knowledge', text: 'Invented.', quote: 'lives on Mars', source: ref },
      ]);
    });
    const cog = await runtime(llm);

    await cog.run(agent, {
      input: 'How do I answer my Portuguese email?',
      threadId: 't',
      userId: 'ana',
    });

    const answer = llm.requests.find((request) => !isBrief(request));
    const turn = lastUser(answer);
    expect(turn).toContain('A quick read of memory for this turn (a hint that may be wrong');
    expect(turn).toContain('- constraint: Answer in Portuguese.');
    expect(turn).not.toContain('Invented.');
    const system = String(answer?.messages.find((m) => m.role === 'system')?.content ?? '');
    expect(system).not.toContain('Answer in Portuguese.');
  });

  it('leaves the turn as it was when the brief fails or takes too long', async () => {
    const failing = backend(async () => {
      throw new Error('brief model down');
    });
    const cog = await runtime(failing);
    const result = await cog.run(agent, {
      input: 'Answer my Portuguese email',
      threadId: 't',
      userId: 'ana',
    });
    expect(result.output).toBe('done');
    expect(lastUser(failing.requests.at(-1))).not.toContain('A quick read of memory');

    const slow = backend(() => new Promise<string>(() => undefined));
    const late = await runtime(slow, { timeoutMs: 50 });
    const second = await late.run(agent, {
      input: 'Answer my Portuguese email',
      threadId: 't',
      userId: 'ana',
    });
    expect(second.output).toBe('done');
  });

  it('writes no brief for a run the runtime let into no thread', async () => {
    const llm = backend(async () => '[]');
    const cog = await runtime(llm);

    await cog.run(agent, {
      input: 'Answer my Portuguese email',
      userId: 'ana',
      threadId: 't',
      useMemory: false,
    });

    expect(llm.requests.some(isBrief)).toBe(false);
  });

  it('gives up on a slow read of memory once the brief runs out of time', async () => {
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    adapter.getPath = () => new Promise(() => undefined);
    const summarizer = vi.fn(() => async () => '[]');
    const layer = memoryBriefMiddleware(
      { timeoutMs: 30 },
      { memory: () => adapter, summarizer, placeOf: () => ({ threadId: 't' }) }
    );
    const started = Date.now();

    const update = await layer.beforeModel?.(
      { messages: [{ role: 'user', content: 'Answer my email' }], model: 'mock/m' } as never,
      {
        runId: 'r',
        agentId: 'helper',
        memoryAgentId: 'helper',
        iteration: 1,
        signal: new AbortController().signal,
        state: new Map(),
      } as never
    );

    expect(update).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(summarizer).not.toHaveBeenCalled();
  });
});
