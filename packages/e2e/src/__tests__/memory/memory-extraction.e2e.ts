import { describe, it, expect, afterAll } from 'vitest';
import { Agent, Cogitator } from '@cogitator-ai/core';
import { MemoryItems, isMemoryItemAdapter } from '@cogitator-ai/memory';

const describeGoogle = process.env.GOOGLE_API_KEY ? describe : describe.skip;

describeGoogle('Memory: memory items extracted after each run', () => {
  const cog = new Cogitator({
    llm: {
      defaultModel: 'google/gemini-2.5-flash',
      providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } },
    },
    memory: {
      adapter: 'memory',
      extraction: { timeZone: 'Europe/Lisbon' },
      contextBuilder: { strategy: 'recent', includeFacts: true, maxTokens: 6000 },
    },
  });
  const agent = new Agent({
    name: 'concierge',
    model: 'google/gemini-2.5-flash',
    instructions: 'You are a concise personal assistant. Answer in one sentence.',
  });
  afterAll(() => cog.close());

  async function items() {
    const memory = await cog.getMemory();
    if (!memory || !isMemoryItemAdapter(memory)) throw new Error('memory keeps no items');
    return new MemoryItems({ adapter: memory });
  }

  it("keeps what the user said as the user's, with the date it names resolved", async () => {
    await cog.run(agent, {
      input: 'Quick update: I moved from Porto to Lisbon last month, and I am vegetarian.',
      threadId: 'extraction-e2e',
      userId: 'ana',
    });

    const kept = await (await items()).query({ scope: { agentId: agent.id, userId: 'ana' } });
    const text = kept.map((item) => item.content.toLowerCase()).join('\n');
    expect(text).toContain('lisbon');
    expect(text).toContain('vegetarian');
    expect(kept.every((item) => item.trust === 'user' && item.verified)).toBe(true);
    expect(kept.some((item) => item.about?.precision === 'month')).toBe(true);
  }, 120_000);

  it('answers a later run from the items, in another thread of the same user', async () => {
    const result = await cog.run(agent, {
      input: 'Which city do I live in now, and what should a dinner place offer me?',
      threadId: 'extraction-e2e-later',
      userId: 'ana',
    });

    expect(result.output.toLowerCase()).toContain('lisbon');
    expect(result.output.toLowerCase()).toMatch(/vegetarian|meat-free|plant/);
  }, 120_000);

  it('does not show one user what another user said', async () => {
    const result = await cog.run(agent, {
      input: 'Do you know which city I live in? Say "unknown" if you do not.',
      threadId: 'extraction-e2e-other',
      userId: 'bo',
    });

    expect(result.output.toLowerCase()).not.toContain('lisbon');
  }, 120_000);
});
