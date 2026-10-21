import { describe, it, expect, afterAll, vi } from 'vitest';
import { Agent, Cogitator, memoryAgentId } from '@cogitator-ai/core';
import type { RunResult } from '@cogitator-ai/types';
import { countTokens, isMemoryItemAdapter, MemoryItems } from '@cogitator-ai/memory';

const describeGoogle = process.env.GOOGLE_API_KEY ? describe : describe.skip;

const MODEL = 'google/gemini-3.5-flash-lite';

describeGoogle('Memory: hybrid recall of older turns and memory items', () => {
  const cog = new Cogitator({
    llm: {
      defaultModel: MODEL,
      providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } },
    },
    memory: {
      adapter: 'memory',
      embedding: { provider: 'google', apiKey: process.env.GOOGLE_API_KEY! },
      contextBuilder: { strategy: 'hybrid', maxTokens: 1500 },
    },
  });
  const agent = new Agent({
    name: 'recall-e2e',
    model: MODEL,
    instructions: 'Answer briefly from the conversation and from memory.',
  });

  afterAll(async () => {
    await cog.close();
  });

  async function seed(threadId: string, lines: string[], start: number): Promise<void> {
    const memory = await cog.getMemory();
    if (!memory) throw new Error('No memory');
    await memory.createThread(agent.id, {}, threadId);
    for (const [index, content] of lines.entries()) {
      const added = await memory.addEntry({
        threadId,
        message: { role: index % 2 === 0 ? 'user' : 'assistant', content },
        tokenCount: countTokens(content),
        createdAt: new Date(start + index * 3_600_000),
      });
      expect(added.success).toBe(true);
    }
  }

  /** What the run's last user message held: its input with what memory recalled for it */
  const sentWith = (result: RunResult) =>
    result.messages
      .filter((message) => message.role === 'user')
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .at(-1) ?? '';

  const filler = (count: number) =>
    Array.from(
      { length: count },
      (_, i) =>
        `Note ${i}: the bakery on the corner reopened, the tram was late again and it rained a little in the afternoon.`
    );

  it(
    'recalls an old turn past the history it keeps, dated, once the thread is indexed',
    { timeout: 180_000 },
    async () => {
      const threadId = 'hybrid-recall-turns';
      await seed(
        threadId,
        ['My locker code at the climbing gym is 4471.', 'Noted, 4471.', ...filler(80)],
        Date.UTC(2026, 0, 5, 9)
      );
      await cog.indexMemory(threadId);

      const result = await cog.run(agent, {
        input: 'What is my locker code at the climbing gym?',
        threadId,
        saveHistory: false,
        asOf: new Date(Date.UTC(2026, 0, 20)),
      });
      const recalled = sentWith(result);

      expect(recalled).toContain('Earlier in this conversation:');
      expect(recalled).toContain('[2026-01-05] user: My locker code at the climbing gym is 4471.');
      expect(result.output).toContain('4471');
    }
  );

  it(
    'recalls a memory item and counts it as sent once the run is done',
    { timeout: 180_000 },
    async () => {
      const memory = await cog.getMemory();
      if (!memory || !isMemoryItemAdapter(memory)) throw new Error('memory keeps no items');
      const items = new MemoryItems({ adapter: memory });
      const scope = { agentId: memoryAgentId(agent), userId: 'ana' };
      const [kept] = await items.write([
        {
          kind: 'fact',
          content: 'The user is allergic to peanuts',
          subject: 'user',
          attribute: 'allergy',
          value: 'peanuts',
          trust: 'user',
          confidence: 0.95,
          scope,
          evidence: [],
          verified: true,
          saidAt: new Date(Date.UTC(2026, 0, 2)),
          sessionAt: new Date(Date.UTC(2026, 0, 2)),
        },
      ]);
      const threadId = 'hybrid-recall-items';
      await seed(threadId, filler(10), Date.UTC(2026, 0, 10, 9));

      const result = await cog.run(agent, {
        input: 'Which food allergy do I have?',
        threadId,
        userId: 'ana',
        threadAccess: 'shared',
        saveHistory: false,
      });
      const recalled = sentWith(result);

      expect(recalled).toContain('From memory:\n- The user is allergic to peanuts');
      expect(result.output.toLowerCase()).toContain('peanut');
      await vi.waitFor(async () => expect((await items.get(kept!.id))?.timesRetrieved).toBe(1), {
        timeout: 10_000,
      });
    }
  );
});
