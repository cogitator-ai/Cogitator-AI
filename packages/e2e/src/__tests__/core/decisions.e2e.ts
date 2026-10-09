import { describe, expect, it } from 'vitest';
import { Agent, Cogitator, decisionTool } from '@cogitator-ai/core';

const apiKey = process.env.OPENROUTER_API_KEY;
const JEV = 'openrouter/typesafe/jev-1.13';

const questions = {
  desk: {
    type: 'choice',
    instructions: 'Which desk of a newsroom should cover this topic?',
    criteria: {
      tech: 'Software, AI, chips and other technology',
      world: 'Politics, diplomacy and world events',
      culture: 'Books, film, music and art',
    },
  },
  spam: {
    type: 'noul',
    instructions: 'Is this message spam rather than a reader writing in?',
    criteria: {
      true: 'Advertising, scams or nonsense',
      false: 'A real reader with a real question',
    },
  },
  urgency: {
    type: 'score',
    instructions: 'How urgently should the desk look at it?',
    criteria: ['can wait', 'this week', 'today'],
  },
} as const;

describe.skipIf(!apiKey)('decision models on OpenRouter', () => {
  const cog = new Cogitator({ llm: { providers: { openrouter: { apiKey: apiKey ?? '' } } } });

  it('answers every type of question with probabilities and a cost', async () => {
    const result = await cog.decide({
      model: JEV,
      state: 'A reader asks when the new open-weights model from a big lab will run on laptops.',
      questions,
    });
    expect(['tech', 'world', 'culture']).toContain(result.answers.desk.choice);
    expect(result.answers.desk.choice).toBe('tech');
    expect(result.answers.spam.probability).toBeGreaterThanOrEqual(0);
    expect(result.answers.spam.probability).toBeLessThanOrEqual(1);
    expect(result.answers.spam.value).toBe(false);
    expect(typeof result.answers.urgency.score).toBe('number');
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.cost).toBeGreaterThanOrEqual(0);
    expect(result.usage.priced).toBe(true);
  }, 60_000);

  it('tells spam apart', async () => {
    const result = await cog.decide({
      model: JEV,
      state: 'BUY CHEAP WATCHES NOW!!! click http://cheap-watches.example',
      questions: { spam: questions.spam },
    });
    expect(result.answers.spam.value).toBe(true);
  }, 60_000);

  it('refuses a chat run on a decision model', async () => {
    await expect(
      cog.run(new Agent({ name: 'x', model: JEV, instructions: 'x' }), { input: 'hello' })
    ).rejects.toThrow('is a decision model');
  });

  it('serves a decision tool', async () => {
    const tool = decisionTool(cog, {
      name: 'route_topic',
      description: 'Pick the desk for a topic',
      model: JEV,
      questions: { desk: questions.desk },
    });
    const result = await tool.execute(
      { state: 'A new novel wins a major literary prize' },
      { agentId: 'a', runId: 'r', signal: new AbortController().signal }
    );
    expect(result.answers.desk.choice).toBe('culture');
  }, 60_000);
});
