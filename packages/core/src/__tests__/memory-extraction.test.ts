import { describe, it, expect, vi, afterEach } from 'vitest';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  MemoryItemAdapter,
} from '@cogitator-ai/types';
import { MemoryItems } from '@cogitator-ai/memory';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { z } from 'zod';
import { getLogger } from '../logger';
import { EXTRACTION_CURSOR } from '../middleware/memory-extraction';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

const isExtraction = (request: ChatRequest) =>
  String(request.messages[0]?.content ?? '').startsWith('You keep the long-term memory');

/** Answers an extraction with the city the user names, every other request with "noted" */
function backend(): LLMBackend & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest): Promise<ChatResponse> => {
      requests.push(request);
      if (!isExtraction(request)) {
        return { id: 'r', content: 'noted', finishReason: 'stop', usage };
      }
      const transcript = String(request.messages[1]?.content ?? '');
      const lines = transcript
        .split('\n')
        .filter((line) => /^\[\d+\] user(?: \([^)]*\))?: I live in/.test(line));
      return {
        id: 'r',
        content: JSON.stringify(
          lines.map((line) => {
            const city = /I live in (\w+)/.exec(line)?.[1] ?? '';
            return {
              kind: 'fact',
              content: `The user lives in ${city}`,
              subject: 'user',
              attribute: 'home city',
              value: city,
              confidence: 0.9,
              evidence: [
                { message: Number(/^\[(\d+)\]/.exec(line)?.[1]), quote: `I live in ${city}` },
              ],
            };
          })
        ),
        finishReason: 'stop',
        usage,
      };
    }),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    }),
  };
}

describe('memory.extraction', () => {
  const cogs: Cogitator[] = [];
  afterEach(async () => {
    for (const cog of cogs.splice(0)) await cog.close();
    vi.restoreAllMocks();
  });

  function runtime(llm: LLMBackend, extraction: object = {}) {
    const cog = new Cogitator({
      llm: { backends: { mock: llm } },
      memory: { adapter: 'memory', extraction },
    });
    cogs.push(cog);
    return cog;
  }

  const agent = new Agent({ name: 'a', model: 'mock/m', instructions: 'x' });

  async function itemsOf(cog: Cogitator) {
    const adapter = (await cog.getMemory()) as unknown as MemoryItemAdapter;
    return new MemoryItems({ adapter });
  }

  it("extracts what the user said after a run, as the user's, and moves on from there", async () => {
    const llm = backend();
    const afterExtract = vi.fn();
    const cog = runtime(llm, { afterExtract });

    await cog.run(agent, { input: 'I live in Porto', threadId: 't', userId: 'u1' });
    await cog.run(agent, { input: 'I live in Lisbon now', threadId: 't', userId: 'u1' });

    const items = await itemsOf(cog);
    const current = await items.query({ scope: { agentId: agent.name, userId: 'u1' } });
    expect(current.map((item) => [item.value, item.trust, item.status])).toEqual([
      ['Lisbon', 'user', 'active'],
    ]);
    const extractions = llm.requests.filter(isExtraction);
    expect(extractions).toHaveLength(2);
    expect(String(extractions[1]?.messages[1]?.content)).not.toContain('Porto');
    expect(afterExtract).toHaveBeenCalledTimes(2);
    const thread = await (await cog.getMemory())!.getThread('t');
    expect(thread.success && thread.data?.metadata[EXTRACTION_CURSOR]).toMatchObject({
      through: expect.any(String),
    });
  });

  it('feeds what it extracted into the facts of the next run', async () => {
    const llm = backend();
    const cog = new Cogitator({
      llm: { backends: { mock: llm } },
      memory: {
        adapter: 'memory',
        extraction: {},
        contextBuilder: { includeFacts: true, maxTokens: 4000 },
      },
    });
    cogs.push(cog);

    await cog.run(agent, { input: 'I live in Porto', threadId: 't', userId: 'u1' });
    await cog.run(agent, { input: 'What do you know?', threadId: 't', userId: 'u1' });

    const answer = llm.requests.filter((request) => !isExtraction(request)).at(-1);
    expect(JSON.stringify(answer?.messages)).toContain('The user lives in Porto');
  });

  it('keeps the run when the extraction fails and waits before trying again', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const llm = backend();
    let tries = 0;
    vi.mocked(llm.chat).mockImplementation(async (request) => {
      if (isExtraction(request)) {
        tries++;
        return { id: 'r', content: 'no', finishReason: 'stop', usage };
      }
      return { id: 'r', content: 'noted', finishReason: 'stop', usage };
    });
    const cog = runtime(llm);

    const result = await cog.run(agent, { input: 'I live in Porto', threadId: 't' });
    await cog.run(agent, { input: 'I live in Lisbon', threadId: 't' });

    expect(result.output).toBe('noted');
    expect(tries).toBe(3);
    expect(warn.mock.calls.some(([message]) => String(message).includes('extract'))).toBe(true);
  });

  it('takes the entries of a first extraction that failed into the next one', async () => {
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['Date'] });
    const llm = backend();
    const answer = vi.mocked(llm.chat).getMockImplementation()!;
    let failures = 3;
    vi.mocked(llm.chat).mockImplementation(async (request) => {
      if (isExtraction(request) && failures > 0) {
        failures--;
        return { id: 'r', content: 'no', finishReason: 'stop', usage };
      }
      return answer(request);
    });
    const cog = runtime(llm);

    try {
      await cog.run(agent, { input: 'I live in Porto', threadId: 't', userId: 'u1' });
      vi.setSystemTime(Date.now() + 2 * 3600_000);
      await cog.run(agent, { input: 'Nice weather', threadId: 't', userId: 'u1' });
    } finally {
      vi.useRealTimers();
    }

    const last = llm.requests.filter(isExtraction).at(-1);
    expect(String(last?.messages[1]?.content)).toContain('I live in Porto');
    const items = await itemsOf(cog);
    const later = new Date(Date.now() + 3 * 3600_000);
    expect(
      (await items.query({ scope: { agentId: agent.name, userId: 'u1' }, knownAt: later })).map(
        (i) => i.value
      )
    ).toEqual(['Porto']);
  });

  it('keeps a run without a user to its thread, so visitors never share memory', async () => {
    const cog = runtime(backend());

    await cog.run(agent, { input: 'I live in Porto', threadId: 'visitor-1' });

    const items = await itemsOf(cog);
    expect(await items.query({ scope: { agentId: agent.name } })).toEqual([]);
    const [kept] = await items.query({ scope: { agentId: agent.name, threadId: 'visitor-1' } });
    expect(kept?.scope).toEqual({ agentId: agent.name, threadId: 'visitor-1' });
  });

  it('keeps memory under the agent name, so a new instance of the agent finds it', async () => {
    const llm = backend();
    const cog = new Cogitator({
      llm: { backends: { mock: llm } },
      memory: { adapter: 'memory', extraction: {}, contextBuilder: { includeFacts: true } },
    });
    cogs.push(cog);

    await cog.run(new Agent({ name: 'concierge', model: 'mock/m', instructions: 'x' }), {
      input: 'I live in Porto',
      threadId: 't1',
      userId: 'u1',
    });
    await cog.run(new Agent({ name: 'concierge', model: 'mock/m', instructions: 'x' }), {
      input: 'Where do I live?',
      threadId: 't2',
      userId: 'u1',
    });

    const answer = llm.requests.filter((request) => !isExtraction(request)).at(-1);
    expect(JSON.stringify(answer?.messages)).toContain('The user lives in Porto');
  });

  it('counts the memory items a run sent before it paused, once across the resume', async () => {
    const llm = backend();
    const answer = llm.chat;
    let refundAsked = false;
    llm.chat = vi.fn(async (request: ChatRequest) => {
      const last = String(request.messages.at(-1)?.content ?? '');
      if (!isExtraction(request) && last.includes('refund') && !refundAsked) {
        refundAsked = true;
        llm.requests.push(request);
        return {
          id: 'r',
          content: '',
          toolCalls: [{ id: 'c1', name: 'refund', arguments: { order: '7' } }],
          finishReason: 'tool_calls' as const,
          usage,
        };
      }
      return answer(request);
    });
    const refund = tool({
      name: 'refund',
      description: 'Refund',
      parameters: z.object({ order: z.string() }),
      requiresApproval: true,
      execute: async ({ order }) => `refunded ${order}`,
    });
    const refunds = new Agent({ name: 'a', model: 'mock/m', instructions: 'x', tools: [refund] });
    const cog = new Cogitator({
      llm: { backends: { mock: llm } },
      memory: { adapter: 'memory', extraction: {}, contextBuilder: { includeFacts: true } },
    });
    cogs.push(cog);
    await cog.run(refunds, { input: 'I live in Porto', threadId: 't', userId: 'u1' });

    const paused = await cog.run(refunds, {
      input: 'please refund 7',
      threadId: 't',
      userId: 'u1',
    });
    expect(paused.status).toBe('paused');
    const items = await itemsOf(cog);
    const porto = async () =>
      (await items.query({ scope: { agentId: refunds.name, userId: 'u1' } }))[0];
    await vi.waitFor(async () => expect((await porto())?.timesRetrieved).toBe(1));

    const counted = vi.spyOn(MemoryItems.prototype, 'noteRetrieved');
    await cog.resume(refunds, paused.checkpoint!, { decisions: { c1: { approved: true } } });
    await cog.close();
    cogs.splice(cogs.indexOf(cog), 1);
    expect(counted).not.toHaveBeenCalled();
  });

  it('counts the memory items a finished run sent to the model', async () => {
    const cog = new Cogitator({
      llm: { backends: { mock: backend() } },
      memory: { adapter: 'memory', extraction: {}, contextBuilder: { includeFacts: true } },
    });
    cogs.push(cog);
    await cog.run(agent, { input: 'I live in Porto', threadId: 't', userId: 'u1' });
    await cog.run(agent, { input: 'What about me?', threadId: 't', userId: 'u1' });

    const items = await itemsOf(cog);
    await vi.waitFor(async () => {
      const [porto] = await items.query({ scope: { agentId: agent.name, userId: 'u1' } });
      expect(porto?.timesRetrieved).toBe(1);
      expect(porto?.lastRetrievedAt).toBeInstanceOf(Date);
    });
  });

  it('extracts the runs of one thread one after another, each entry once', async () => {
    const llm = backend();
    const cog = runtime(llm);

    await Promise.all(
      ['I live in Porto', 'I live in Lisbon', 'I live in Braga'].map((input) =>
        cog.run(agent, { input, threadId: 't', userId: 'u1' })
      )
    );

    const transcripts = llm.requests
      .filter(isExtraction)
      .map((r) => String(r.messages[1]?.content));
    for (const city of ['Porto', 'Lisbon', 'Braga']) {
      expect(transcripts.filter((text) => text.includes(`I live in ${city}`))).toHaveLength(1);
    }
  });

  it('keeps its place window by window and leaves out a window that keeps failing', async () => {
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['Date'] });
    const llm = backend();
    const answer = vi.mocked(llm.chat).getMockImplementation()!;
    vi.mocked(llm.chat).mockImplementation(async (request) =>
      isExtraction(request) && String(request.messages[1]?.content).includes('poison')
        ? { id: 'r', content: 'no', finishReason: 'stop', usage }
        : answer(request)
    );
    const cog = runtime(llm, { windowTokens: 40 });

    try {
      await cog.run(agent, {
        input: `poison ${'word '.repeat(60)}`,
        threadId: 't',
        userId: 'u1',
      });
      for (let attempt = 0; attempt < 3; attempt++) {
        vi.setSystemTime(Date.now() + 2 * 3600_000);
        await cog.run(agent, { input: 'I live in Porto', threadId: 't', userId: 'u1' });
      }
    } finally {
      vi.useRealTimers();
    }

    const items = await itemsOf(cog);
    const later = new Date(Date.now() + 10 * 3600_000);
    expect(
      (await items.query({ scope: { agentId: agent.name, userId: 'u1' }, knownAt: later })).map(
        (item) => item.value
      )
    ).toContain('Porto');
    const thread = await (await cog.getMemory())!.getThread('t');
    expect(thread.success && thread.data?.metadata[EXTRACTION_CURSOR]).not.toHaveProperty(
      'failures'
    );
  });

  it('never leaves a window out for a provider failure, however long it lasts', async () => {
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['Date'] });
    const llm = backend();
    const answer = vi.mocked(llm.chat).getMockImplementation()!;
    let down = 4;
    vi.mocked(llm.chat).mockImplementation(async (request) => {
      if (isExtraction(request) && down > 0) {
        down--;
        throw new Error('overloaded');
      }
      return answer(request);
    });
    const cog = runtime(llm);

    try {
      await cog.run(agent, { input: 'I live in Porto', threadId: 't', userId: 'u1' });
      for (let attempt = 0; attempt < 4; attempt++) {
        vi.setSystemTime(Date.now() + 2 * 3600_000);
        await cog.run(agent, { input: 'Thanks', threadId: 't', userId: 'u1' });
      }
    } finally {
      vi.useRealTimers();
    }

    const items = await itemsOf(cog);
    const later = new Date(Date.now() + 20 * 3600_000);
    expect(
      (await items.query({ scope: { agentId: agent.name, userId: 'u1' }, knownAt: later })).map(
        (item) => item.value
      )
    ).toEqual(['Porto']);
  });

  it('leaves alone a run on another branch', async () => {
    const llm = backend();
    const cog = runtime(llm);
    const root = await cog.run(agent, { input: 'I live in Porto', threadId: 't', userId: 'u1' });

    await cog.run(agent, {
      input: 'I live in Faro',
      threadId: 't',
      userId: 'u1',
      branch: { fromEntryId: root.memory!.branchPoint!, activate: false },
    });

    const transcripts = llm.requests
      .filter(isExtraction)
      .map((r) => String(r.messages[1]?.content));
    expect(transcripts.some((text) => text.includes('Faro'))).toBe(false);
  });

  it('refuses settings it cannot work with', async () => {
    await expect(
      runtime(backend(), { windowTokens: 0 }).run(agent, { input: 'x' })
    ).rejects.toThrow(/windowTokens/);
  });
});
