import { Agent, Cogitator } from '@cogitator-ai/core';
import { MemoryItems, countTokens, isMemoryItemAdapter } from '@cogitator-ai/memory';
import type {
  ChatRequest,
  EmbeddingService,
  LLMBackend,
  MemoryAdapter,
  MemoryEntry,
  Message,
  NewMemoryItem,
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

/** Context budget of the suite: small enough that the history does not fit and each strategy picks. */
const SUITE_TOKENS = 600;

/** Filler turns of a history, together well over {@link SUITE_TOKENS}. */
const FILLERS = 24;

const filler = (i: number) =>
  `Small talk number ${i} about the weather, the traffic downtown, the new bakery on the corner ` +
  'and the football match last weekend.';

const fillersIn = (context: string) => context.match(/Small talk number \d+ /g)?.length ?? 0;

/**
 * Checks that a branch of a conversation never shows another branch's turns, that rewound or
 * deleted turns never come back, and that forgetting, redacting or rewinding a turn takes the
 * memory items from it out of the context while the rest of memory stays, for each memory
 * strategy. The history is longer than the
 * context budget, so every strategy has to choose turns, and each absence is paired with a
 * presence (the branch sees its own turn, the rewound turn was seen before the rewind) so an empty
 * context cannot pass. A fork here is what the runtime offers today: a new thread with the turns
 * copied up to the fork point. The model is a stub that only records what it was sent, so the
 * suite costs nothing. A memory error fails the strategy: a fallback would test something else.
 */
export async function runConsistencySuite(
  strategies: readonly ('recent' | 'relevant' | 'hybrid')[] = ['recent', 'relevant', 'hybrid']
): Promise<ConsistencyCheck[]> {
  const checks: ConsistencyCheck[] = [];
  for (const strategy of strategies) {
    const requests: ChatRequest[] = [];
    const memoryErrors: string[] = [];
    const cog = new Cogitator({
      llm: {
        backends: { stub: recordingBackend(requests) },
        pricing: { 'stub/m': { input: 0, output: 0 } },
      },
      memory: {
        adapter: 'memory',
        embedding: new HashedWordsEmbedding(),
        contextBuilder: { strategy, maxTokens: SUITE_TOKENS },
      },
    });
    const agent = new Agent({ name: 'consistency', model: 'stub/m', instructions: 'Answer.' });
    const memory = await cog.getMemory();
    if (!memory) throw new Error('No memory');
    const ask = async (threadId: string, input: string) => {
      requests.length = 0;
      await cog.run(agent, {
        input,
        threadId,
        saveHistory: false,
        onMemoryError: (error) => memoryErrors.push(error.message),
      });
      return textOf(requests[0]?.messages ?? []);
    };
    const check = (name: string, passed: boolean, detail: string) =>
      checks.push({ name, strategy, passed, detail: passed ? 'ok' : detail });

    try {
      await memory.createThread(agent.id, {}, 'main');
      const shared = [
        ...Array.from({ length: FILLERS * 2 }, (_, i) =>
          i % 2 === 0 ? filler(i) : 'Sounds nice.'
        ),
        'I am planning a trip in May, my sister in Lisbon will host me on the way.',
        'Where would you like to go after Lisbon?',
      ];
      for (const [index, content] of shared.entries()) await add(memory, 'main', content, index);

      const entries = await memory.getEntries({ threadId: 'main' });
      if (!entries.success) throw new Error(entries.error);
      await memory.createThread(agent.id, { forkOf: 'main' }, 'branch');
      for (const [index, entry] of entries.data.entries()) {
        const content = typeof entry.message.content === 'string' ? entry.message.content : '';
        await add(memory, 'branch', content, index);
      }
      await add(memory, 'branch', 'On this branch I chose Kyoto for the trip.', shared.length);
      await add(memory, 'main', 'On the main line I chose Reykjavik for the trip.', shared.length);

      const onMain = await ask('main', 'Where is my trip going?');
      const onBranch = await ask('branch', 'Where is my trip going?');
      check(
        'budget: the history does not fit, the strategy picks turns',
        fillersIn(onMain) < FILLERS,
        'every turn reached the model, the budget chose nothing'
      );
      check(
        'fork: each line sees its own turn after the fork',
        onMain.includes('Reykjavik') && onBranch.includes('Kyoto'),
        'a line is missing its own latest turn'
      );
      check(
        'fork: the main line does not see the branch',
        !onMain.includes('Kyoto'),
        'the branch-only turn reached the main line'
      );
      check(
        'fork: the branch does not see the main line after the fork',
        !onBranch.includes('Reykjavik'),
        'a main-line turn after the fork reached the branch'
      );
      check(
        'fork: the branch keeps the shared history',
        onBranch.includes('Lisbon'),
        'a turn before the fork is missing on the branch'
      );

      await memory.createThread(agent.id, {}, 'rewind');
      await add(memory, 'rewind', 'My favourite colour is teal.', 0);
      await add(memory, 'rewind', 'Teal it is.', 1);
      for (let i = 0; i < FILLERS; i++) await add(memory, 'rewind', filler(i), i + 2);
      const doomed = await add(
        memory,
        'rewind',
        'Actually my favourite colour is crimson.',
        FILLERS + 2
      );
      const beforeRewind = await ask('rewind', 'What is my favourite colour?');
      const deleted = await memory.deleteEntry(doomed.id);
      if (!deleted.success) throw new Error(deleted.error);
      const afterRewind = await ask('rewind', 'What is my favourite colour?');
      check(
        'rewind: the turn is seen before the rewind',
        beforeRewind.includes('crimson'),
        'the latest turn did not reach the model before the rewind'
      );
      check(
        'rewind: a rewound turn does not come back, the rest of the thread does',
        !afterRewind.includes('crimson') && fillersIn(afterRewind) > 0,
        afterRewind.includes('crimson')
          ? 'the rewound turn reached the model'
          : 'nothing of the thread reached the model after the rewind'
      );
      if (!isMemoryItemAdapter(memory)) throw new Error('The suite needs memory items');
      const items = new MemoryItems({ adapter: memory });
      const fact = (content: string, entry: MemoryEntry): NewMemoryItem => ({
        kind: 'fact',
        content,
        subject: 'the user',
        trust: 'user',
        confidence: 0.95,
        scope: { agentId: agent.id },
        evidence: [{ entryId: entry.id, quote: content }],
        verified: true,
        status: 'active',
        saidAt: entry.createdAt,
        sessionAt: entry.createdAt,
      });
      const thread = async (id: string, secret: string, item: string) => {
        await memory.createThread(agent.id, {}, id);
        for (let i = 0; i < FILLERS; i++) await add(memory, id, filler(i), i);
        const told = await add(memory, id, secret, FILLERS);
        await add(memory, id, 'Noted.', FILLERS + 1);
        await items.write([fact(item, told)]);
        return told;
      };

      const cutAt = await add(memory, 'rewind', 'Back to the plans.', FILLERS + 3);
      const crimson = await add(memory, 'rewind', 'My car is crimson too.', FILLERS + 4);
      await items.write([fact('The car of the user is crimson.', crimson)]);
      const beforeCascade = await ask('rewind', 'What colour is my car?');
      await cog.rewind('rewind', cutAt.id, { agents: [agent] });
      const afterCascade = await ask('rewind', 'What colour is my car?');
      check(
        'rewind: an item from a rewound turn reaches the model before the rewind only',
        beforeCascade.includes('crimson') && !afterCascade.includes('crimson'),
        beforeCascade.includes('crimson')
          ? 'the item of the rewound turn still reached the model'
          : 'the item did not reach the model before the rewind'
      );

      const locker = await thread('forget', 'My locker code is 8812.', 'The locker code is 8812.');
      const beforeForget = await ask('forget', 'What is my locker code?');
      await cog.forget({ entryIds: [locker.id] }, { agents: [agent] });
      const afterForget = await ask('forget', 'What is my locker code?');
      check(
        'forget: a forgotten turn and the item from it are gone, the rest stays',
        beforeForget.includes('8812') &&
          !afterForget.includes('8812') &&
          fillersIn(afterForget) > 0,
        afterForget.includes('8812')
          ? 'the forgotten code still reached the model'
          : 'the code was not seen before, or nothing of the thread came after'
      );

      const passport = await thread(
        'redact',
        'My passport is X91-4471.',
        'The passport is X91-4471.'
      );
      const beforeRedact = await ask('redact', 'What is my passport?');
      await cog.redactEntries([passport.id], { agents: [agent] });
      const afterRedact = await ask('redact', 'What is my passport?');
      const kept = await memory.getEntries({ threadId: 'redact' });
      check(
        'redact: a redacted turn keeps its place and nothing of what it said',
        beforeRedact.includes('X91-4471') &&
          !afterRedact.includes('X91-4471') &&
          kept.success &&
          kept.data.some((entry) => entry.id === passport.id),
        afterRedact.includes('X91-4471')
          ? 'the redacted passport still reached the model'
          : 'the passport was not seen before, or the redacted turn lost its place'
      );

      const other = await thread('kept', 'My bike is green.', 'The bike of the user is green.');
      await cog.forget({ threadId: 'forget' }, { agents: [agent] });
      const afterThread = await ask('kept', 'What colour is my bike?');
      check(
        'forget: forgetting one thread leaves the others whole',
        afterThread.includes('green') && other.id.length > 0,
        'a turn or item of another thread went with it'
      );
      check('memory: no errors, no fallback', memoryErrors.length === 0, memoryErrors.join('; '));
    } catch (error) {
      check('suite', false, error instanceof Error ? error.message : String(error));
    } finally {
      await cog.close();
    }
  }
  return checks;
}
