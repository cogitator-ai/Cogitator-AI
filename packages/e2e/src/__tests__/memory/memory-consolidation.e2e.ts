import { describe, it, expect, afterAll } from 'vitest';
import { Agent, Cogitator } from '@cogitator-ai/core';
import {
  MemoryItems,
  OBSERVATIONS_DIRECTORY,
  PLAYBOOK_PATH,
  parsePlaybook,
  MemoryFiles,
} from '@cogitator-ai/memory';
import type {
  ChatRequest,
  MemoryFileAdapter,
  MemoryItemAdapter,
  MemoryItemScope,
  NewMemoryItem,
  RunMiddleware,
} from '@cogitator-ai/types';

const describeGoogle = process.env.GOOGLE_API_KEY ? describe : describe.skip;

const GEMINI = 'google/gemini-3.5-flash-lite';

const scope: MemoryItemScope = { agentId: 'concierge', userId: 'marta' };

function item(content: string, kind: NewMemoryItem['kind'] = 'fact'): NewMemoryItem {
  return {
    kind,
    content,
    subject: 'Marta',
    trust: 'user',
    confidence: 0.95,
    scope,
    evidence: [{ quote: content }],
    verified: true,
    status: 'active',
    saidAt: new Date('2026-10-01'),
    sessionAt: new Date('2026-10-01'),
  };
}

describeGoogle('Memory: brief, observations and consolidation on Gemini', () => {
  const seen: ChatRequest['messages'][] = [];
  const watcher: RunMiddleware = {
    name: 'test:watch',
    wrapModelCall(call, next) {
      seen.push(call.request.messages);
      return next(call);
    },
  };
  const cog = new Cogitator({
    llm: {
      defaultModel: GEMINI,
      providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } },
    },
    memory: {
      adapter: 'memory',
      contextBuilder: { strategy: 'recent', maxTokens: 8000, includeFacts: true },
      brief: { timeoutMs: 30_000 },
      observations: { minItems: 3 },
      consolidation: { everyRuns: 50 },
    },
    middleware: [watcher],
  });
  const agent = new Agent({
    name: 'concierge',
    model: GEMINI,
    instructions: 'You help Marta plan her week. Answer in one or two sentences.',
  });

  afterAll(async () => {
    await cog.close();
  });

  it(
    'folds a lesson into the playbook, marks a repeat stale and writes an observation, then uses them',
    { timeout: 240_000 },
    async () => {
      const memory = await cog.getMemory();
      if (!memory) throw new Error('No memory');
      const store = memory as typeof memory & MemoryItemAdapter & MemoryFileAdapter;
      const items = new MemoryItems({ adapter: store });
      const [vegetarian, noMeat] = await items.write([
        item('Marta is vegetarian.'),
        item('Marta does not eat meat at all.'),
        item('Marta swims every Tuesday at 7am.'),
        item('Marta works as an architect in Lisbon.'),
        item(
          'Booking a table without asking about dietary needs led to a steakhouse Marta could not use, so always check dietary needs before booking food.',
          'lesson'
        ),
      ]);

      const report = await cog.consolidateMemory(agent, { userId: 'marta' });

      expect(report.playbook?.path).toBe(PLAYBOOK_PATH);
      const files = new MemoryFiles({ adapter: store });
      const playbook = await files.read({ scope }, PLAYBOOK_PATH);
      expect(parsePlaybook(playbook!.content).rules.join(' ').toLowerCase()).toMatch(/diet/);
      expect(report.stale.map((mark) => [mark.itemId, mark.keptId].sort())).toContainEqual(
        [vegetarian!.id, noMeat!.id].sort()
      );
      expect(report.observations).toEqual([`${OBSERVATIONS_DIRECTORY}/marta.md`]);
      const observation = await files.read({ scope }, `${OBSERVATIONS_DIRECTORY}/marta.md`);
      expect(observation?.content).toMatch(/\[item:mem_/);

      const result = await cog.run(agent, {
        input: 'Can you book Marta a dinner table for Friday? Anything I should check first?',
        threadId: 'week',
        userId: 'marta',
      });

      const turn = [...(seen.at(-1) ?? [])].reverse().find((message) => message.role === 'user');
      const text = typeof turn?.content === 'string' ? turn.content : JSON.stringify(turn?.content);
      expect(text).toContain('The playbook memory keeps');
      expect(text).toContain('What memory makes of them');
      expect(text).toContain('A quick read of memory for this turn');
      expect(result.output.toLowerCase()).toMatch(/vegetarian|diet|meat/);
    }
  );
});
