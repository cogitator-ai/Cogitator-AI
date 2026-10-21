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
      const lines = transcript.split('\n').filter((line) => /^\[\d+\] user: I live in/.test(line));
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
    const current = await items.query({ scope: { agentId: agent.id, userId: 'u1' } });
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

  it('refuses settings it cannot work with', async () => {
    await expect(
      runtime(backend(), { windowTokens: 0 }).run(agent, { input: 'x' })
    ).rejects.toThrow(/windowTokens/);
  });
});
