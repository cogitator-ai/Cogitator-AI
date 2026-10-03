import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';

const describeGoogle = process.env.GOOGLE_API_KEY ? describe : describe.skip;
const describeHeavy = process.env.OLLAMA_API_KEY ? describe : describe.skip;

const OLLAMA_CLOUD_URL = process.env.OLLAMA_URL || 'https://ollama.com';
const QUESTION =
  'A train leaves at 09:40 and arrives at 13:15. How many minutes is the trip? Reply with the number only.';

describeGoogle('Core: reasoning on Gemini', () => {
  let cogitator: Cogitator;

  beforeAll(() => {
    cogitator = new Cogitator({
      llm: { providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } } },
    });
  });

  afterAll(async () => {
    await cogitator.close();
  });

  const thinker = (reasoning: Agent['config']['reasoning']) =>
    new Agent({
      name: 'thinker',
      model: 'google/gemini-3.5-flash-lite',
      instructions: 'Solve the problem.',
      reasoning,
    });

  it('returns a reasoning summary and bills thinking tokens', { timeout: 120_000 }, async () => {
    const result = await cogitator.run(thinker({ effort: 'medium', summary: true }), {
      input: QUESTION,
    });

    expect(result.output).toContain('215');
    expect(result.reasoning?.length).toBeGreaterThan(0);
    expect(result.usage.reasoningTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(result.usage.reasoningTokens ?? 0);
    expect(result.usage.cost).toBeGreaterThan(0);
  });

  it('streams the reasoning before the answer', { timeout: 240_000 }, async () => {
    let streamedReasoning = false;

    for (let attempt = 0; attempt < 3 && !streamedReasoning; attempt++) {
      const events: Array<'reasoning' | 'token'> = [];
      const result = await cogitator.run(thinker({ effort: 'high', summary: true }), {
        input: QUESTION,
        stream: true,
        onReasoning: () => events.push('reasoning'),
        onToken: () => events.push('token'),
      });

      expect(result.output).toContain('215');
      expect(events).toContain('token');
      if (events.includes('reasoning')) {
        streamedReasoning = true;
        expect(events[0]).toBe('reasoning');
        expect(events.lastIndexOf('reasoning')).toBeLessThan(events.indexOf('token'));
      }
    }

    expect(streamedReasoning).toBe(true);
  });

  it('thinks less at the lowest effort', { timeout: 120_000 }, async () => {
    const minimal = await cogitator.run(thinker({ effort: 'none' }), { input: QUESTION });
    const high = await cogitator.run(thinker({ effort: 'high' }), { input: QUESTION });

    expect(minimal.usage.reasoningTokens ?? 0).toBeLessThan(high.usage.reasoningTokens ?? 0);
  });

  it('keeps reasoning across a tool loop', { timeout: 120_000 }, async () => {
    const calls: string[] = [];
    const timetable = tool({
      name: 'timetable',
      description: 'Departure and arrival times of a train by its number',
      parameters: z.object({ train: z.string() }),
      execute: async ({ train }) => {
        calls.push(train);
        return { departs: '09:40', arrives: '13:15' };
      },
    });
    const agent = new Agent({
      name: 'traveler',
      model: 'google/gemini-3.5-flash-lite',
      instructions:
        'Look up the timetable with the tool, then answer with the number of minutes only.',
      tools: [timetable],
      reasoning: { effort: 'medium', summary: true },
    });

    const result = await cogitator.run(agent, { input: 'How long is the trip on train IC 512?' });

    expect(calls.length).toBeGreaterThan(0);
    expect(result.output).toContain('215');
    expect(result.reasoning?.length).toBeGreaterThan(0);
  });
});

describeHeavy('Core: reasoning on Ollama (gpt-oss)', () => {
  it('returns the thinking of a reasoning model', { timeout: 180_000 }, async () => {
    const cogitator = new Cogitator({
      llm: {
        providers: {
          ollama: { baseUrl: OLLAMA_CLOUD_URL, apiKey: process.env.OLLAMA_API_KEY },
        },
      },
    });
    const agent = new Agent({
      name: 'oss-thinker',
      model: 'ollama/gpt-oss:20b',
      instructions: 'Solve the problem.',
      reasoning: { effort: 'low' },
    });

    const result = await cogitator.run(agent, { input: QUESTION });

    expect(result.output).toContain('215');
    expect(result.reasoning?.length).toBeGreaterThan(0);
    await cogitator.close();
  });
});
