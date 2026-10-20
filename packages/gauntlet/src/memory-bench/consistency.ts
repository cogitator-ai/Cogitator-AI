import { Agent, Cogitator } from '@cogitator-ai/core';
import { countTokens } from '@cogitator-ai/memory';
import type {
  ChatRequest,
  EmbeddingService,
  LLMBackend,
  MemoryAdapter,
  Message,
} from '@cogitator-ai/types';

/** One check of the suite: whether it held, and what was seen when it did not. */
export interface ConsistencyCheck {
  name: string;
  strategy: string;
  passed: boolean;
  detail: string;
}

/** Words hashed into a fixed number of buckets: a free, deterministic stand-in for embeddings. */
export class HashedWordsEmbedding implements EmbeddingService {
  readonly model = 'hashed-words';
  readonly dimensions = 64;

  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(this.dimensions).fill(0);
    for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let hash = 0;
      for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
      vector[hash % this.dimensions] += 1;
    }
    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }
}

function recordingBackend(requests: ChatRequest[]): LLMBackend {
  return {
    provider: 'openai',
    async chat(request) {
      requests.push({ ...request, messages: [...request.messages] });
      return {
        id: 'stub',
        content: 'noted',
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    },
    async *chatStream() {
      yield { id: 'stub', delta: {}, finishReason: 'stop' };
    },
  };
}

const textOf = (messages: readonly Message[]): string =>
  messages
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n');

async function add(memory: MemoryAdapter, threadId: string, content: string, at: number) {
  const role = at % 2 === 0 ? 'user' : 'assistant';
  const result = await memory.addEntry({
    threadId,
    message: { role, content },
    tokenCount: countTokens(content),
    createdAt: new Date(Date.UTC(2026, 0, 1) + at * 1000),
  });
  if (!result.success) throw new Error(result.error);
  return result.data;
}

/**
 * Checks that a branch of a conversation never shows another branch's turns, and that rewound or
 * deleted turns never come back, for each memory strategy. A fork here is what the runtime offers
 * today: a new thread with the turns copied up to the fork point. The model is a stub that only
 * records what it was sent, so the suite costs nothing.
 */
export async function runConsistencySuite(
  strategies: readonly ('recent' | 'relevant' | 'hybrid')[] = ['recent', 'relevant', 'hybrid']
): Promise<ConsistencyCheck[]> {
  const checks: ConsistencyCheck[] = [];
  for (const strategy of strategies) {
    const requests: ChatRequest[] = [];
    const cog = new Cogitator({
      llm: {
        backends: { stub: recordingBackend(requests) },
        pricing: { 'stub/m': { input: 0, output: 0 } },
      },
      memory: {
        adapter: 'memory',
        embedding: new HashedWordsEmbedding(),
        contextBuilder: { strategy, maxTokens: 4000 },
      },
    });
    const agent = new Agent({ name: 'consistency', model: 'stub/m', instructions: 'Answer.' });
    const memory = await cog.getMemory();
    if (!memory) throw new Error('No memory');
    const ask = async (threadId: string, input: string) => {
      requests.length = 0;
      await cog.run(agent, { input, threadId, saveHistory: false });
      return textOf(requests[0]?.messages ?? []);
    };
    const check = (name: string, passed: boolean, detail: string) =>
      checks.push({ name, strategy, passed, detail });

    try {
      await memory.createThread(agent.id, {}, 'main');
      const shared = [
        'My sister lives in Lisbon.',
        'Good to know.',
        'I am planning a trip in May.',
        'Where would you like to go?',
      ];
      for (const [index, content] of shared.entries()) await add(memory, 'main', content, index);

      const entries = await memory.getEntries({ threadId: 'main' });
      if (!entries.success) throw new Error(entries.error);
      await memory.createThread(agent.id, { forkOf: 'main' }, 'branch');
      for (const [index, entry] of entries.data.entries()) {
        const content = typeof entry.message.content === 'string' ? entry.message.content : '';
        await add(memory, 'branch', content, index);
      }
      await add(memory, 'branch', 'On this branch I chose Kyoto for the trip.', 10);
      await add(memory, 'main', 'On the main line I chose Reykjavik for the trip.', 10);

      const onMain = await ask('main', 'Where is my trip going?');
      check(
        'fork: the main line does not see the branch',
        !onMain.includes('Kyoto'),
        onMain.includes('Kyoto') ? 'the branch-only turn reached the main line' : 'ok'
      );
      const onBranch = await ask('branch', 'Where is my trip going?');
      check(
        'fork: the branch does not see the main line after the fork',
        !onBranch.includes('Reykjavik'),
        onBranch.includes('Reykjavik') ? 'a main-line turn after the fork reached the branch' : 'ok'
      );
      check(
        'fork: the branch keeps the shared history',
        onBranch.includes('Lisbon'),
        onBranch.includes('Lisbon') ? 'ok' : 'a turn before the fork is missing on the branch'
      );

      await memory.createThread(agent.id, {}, 'rewind');
      await add(memory, 'rewind', 'My favourite colour is teal.', 0);
      await add(memory, 'rewind', 'Teal it is.', 1);
      const doomed = await add(memory, 'rewind', 'Actually my favourite colour is crimson.', 2);
      await ask('rewind', 'What is my favourite colour?');
      const deleted = await memory.deleteEntry(doomed.id);
      if (!deleted.success) throw new Error(deleted.error);
      const afterRewind = await ask('rewind', 'What is my favourite colour?');
      check(
        'rewind: a rewound turn does not come back',
        !afterRewind.includes('crimson'),
        afterRewind.includes('crimson') ? 'the rewound turn reached the model' : 'ok'
      );
    } catch (error) {
      check('suite', false, error instanceof Error ? error.message : String(error));
    } finally {
      await cog.close();
    }
  }
  return checks;
}
