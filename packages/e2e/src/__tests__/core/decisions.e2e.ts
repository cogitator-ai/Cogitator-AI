import { describe, expect, it } from 'vitest';
import { Agent, Cogitator, decisionTool } from '@cogitator-ai/core';

const apiKey = process.env.OPENROUTER_API_KEY;
const JEV = 'openrouter/typesafe/jev-1.13';

const questions = {
  team: {
    type: 'choice',
    instructions: 'Which support team should answer this message?',
    criteria: {
      billing: 'Payments, invoices, charges and refunds',
      technical: 'Bugs, crashes, errors and how the product works',
      sales: 'Plans, pricing and buying more seats',
    },
  },
  spam: {
    type: 'noul',
    instructions: 'Is this message spam rather than a customer writing in?',
    criteria: {
      true: 'Advertising, scams or nonsense',
      false: 'A real customer with a real question',
    },
  },
  urgency: {
    type: 'score',
    instructions: 'How urgently should the team answer it?',
    criteria: ['can wait', 'this week', 'today'],
  },
} as const;

describe.skipIf(!apiKey)('decision models on OpenRouter', () => {
  const cog = new Cogitator({ llm: { providers: { openrouter: { apiKey: apiKey ?? '' } } } });

  it('answers every type of question with probabilities and a cost', async () => {
    const result = await cog.decide({
      model: JEV,
      state:
        'I was charged twice for my subscription this month, please refund one of the payments.',
      questions,
    });
    expect(['billing', 'technical', 'sales']).toContain(result.answers.team.choice);
    expect(result.answers.team.choice).toBe('billing');
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
      name: 'route_ticket',
      description: 'Pick the team for a support message',
      model: JEV,
      questions: { team: questions.team },
    });
    const result = await tool.execute(
      { state: 'The app crashes every time I open the settings page' },
      { agentId: 'a', runId: 'r', signal: new AbortController().signal }
    );
    expect(result.answers.team.choice).toBe('technical');
  }, 60_000);
});
