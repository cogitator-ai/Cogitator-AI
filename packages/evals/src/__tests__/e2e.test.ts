import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Cogitator, Agent } from '@cogitator-ai/core';
import {
  EvalSuite,
  EvalComparison,
  Dataset,
  exactMatch,
  contains,
  faithfulness,
  bindJudgeContext,
} from '../index';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const hasApiKey = !!GOOGLE_API_KEY || !!OPENAI_API_KEY;

function getModel(): string {
  if (GOOGLE_API_KEY) return 'google/gemini-2.0-flash';
  return 'openai/gpt-4o-mini';
}

describe.skipIf(!hasApiKey)('evals e2e', () => {
  let cogitator: Cogitator;

  beforeAll(() => {
    cogitator = new Cogitator({
      llm: { defaultModel: getModel() },
    });
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('simple QA eval with exactMatch', async () => {
    const dataset = Dataset.from([
      { input: 'What is 2 + 2? Reply with just the number.', expected: '4' },
      { input: 'What is 10 - 3? Reply with just the number.', expected: '7' },
      { input: 'What is 5 * 5? Reply with just the number.', expected: '25' },
      { input: 'What is 100 / 10? Reply with just the number.', expected: '10' },
      { input: 'What is 0 + 0? Reply with just the number.', expected: '0' },
    ]);

    const agent = new Agent({
      name: 'MathAgent',
      model: getModel(),
      instructions:
        'You are a math assistant. Reply with ONLY the numeric answer, nothing else. No words, no punctuation, just the number.',
      temperature: 0,
    });

    const suite = new EvalSuite({
      dataset,
      target: { agent, cogitator },
      metrics: [exactMatch(), contains()],
      concurrency: 2,
      timeout: 30_000,
    });

    const result = await suite.run();

    expect(result.results).toHaveLength(5);
    for (const r of result.results) {
      expect(r.output.length).toBeGreaterThan(0);
      expect(r.scores).toHaveLength(2);

      const emScore = r.scores.find((s) => s.name === 'exactMatch');
      expect(emScore).toBeDefined();
      expect(emScore!.score).toBeGreaterThanOrEqual(0);
      expect(emScore!.score).toBeLessThanOrEqual(1);

      const containsScore = r.scores.find((s) => s.name === 'contains');
      expect(containsScore).toBeDefined();
      expect(containsScore!.score).toBeGreaterThanOrEqual(0);
      expect(containsScore!.score).toBeLessThanOrEqual(1);
    }

    expect(result.aggregated.exactMatch).toBeDefined();
    expect(result.aggregated.exactMatch.mean).toBeGreaterThanOrEqual(0);
    expect(result.aggregated.exactMatch.mean).toBeLessThanOrEqual(1);
    expect(result.aggregated.contains).toBeDefined();

    expect(result.stats.duration).toBeGreaterThan(0);
    expect(result.stats.total).toBe(5);
  }, 60_000);

  it('LLM-as-judge with faithfulness', async () => {
    const dataset = Dataset.from([
      {
        input: 'Explain what TypeScript is in one sentence.',
        expected: 'TypeScript is a typed superset of JavaScript.',
      },
      {
        input: 'What is the main benefit of using version control?',
        expected: 'Tracking changes and collaboration.',
      },
      {
        input: 'Why is testing important in software development?',
        expected: 'To catch bugs and ensure quality.',
      },
    ]);

    const agent = new Agent({
      name: 'QAAgent',
      model: getModel(),
      instructions: 'Answer concisely and accurately.',
      temperature: 0,
    });

    const judgeAgent = new Agent({
      name: 'JudgeAgent',
      model: getModel(),
      instructions: 'You are an evaluation judge.',
      temperature: 0,
    });

    const judgeCogitator = new Cogitator({
      llm: { defaultModel: getModel() },
    });

    const boundFaithfulness = bindJudgeContext(faithfulness(), {
      cogitator: {
        run: async ({ input }: { input: string }) => {
          const result = await judgeCogitator.run(judgeAgent, { input });
          return { output: result.output };
        },
      },
      judgeConfig: { model: getModel(), temperature: 0 },
    });

    const suite = new EvalSuite({
      dataset,
      target: { agent, cogitator },
      metrics: [boundFaithfulness],
      concurrency: 1,
      timeout: 30_000,
    });

    const result = await suite.run();

    await judgeCogitator.close();

    expect(result.results).toHaveLength(3);
    for (const r of result.results) {
      expect(r.output.length).toBeGreaterThan(0);
      const score = r.scores.find((s) => s.name === 'faithfulness');
      expect(score).toBeDefined();
      expect(score!.score).toBeGreaterThanOrEqual(0);
      expect(score!.score).toBeLessThanOrEqual(1);
    }

    expect(result.aggregated.faithfulness).toBeDefined();
    expect(result.aggregated.faithfulness.mean).toBeGreaterThanOrEqual(0);
    expect(result.aggregated.faithfulness.mean).toBeLessThanOrEqual(1);
  }, 60_000);

  it('A/B comparison with different temperatures', async () => {
    const dataset = Dataset.from([
      { input: 'What is 2 + 2? Reply with just the number.', expected: '4' },
      { input: 'What is 10 - 3? Reply with just the number.', expected: '7' },
      { input: 'What is 5 * 5? Reply with just the number.', expected: '25' },
      { input: 'What is 100 / 10? Reply with just the number.', expected: '10' },
      { input: 'What is 0 + 0? Reply with just the number.', expected: '0' },
    ]);

    const baselineAgent = new Agent({
      name: 'BaselineAgent',
      model: getModel(),
      instructions: 'You are a math assistant. Reply with ONLY the numeric answer, nothing else.',
      temperature: 0,
    });

    const challengerAgent = new Agent({
      name: 'ChallengerAgent',
      model: getModel(),
      instructions: 'You are a math assistant. Reply with ONLY the numeric answer, nothing else.',
      temperature: 1,
    });

    const comparison = new EvalComparison({
      dataset,
      targets: {
        baseline: { agent: baselineAgent, cogitator },
        challenger: { agent: challengerAgent, cogitator },
      },
      metrics: [exactMatch()],
      concurrency: 1,
      timeout: 30_000,
    });

    const result = await comparison.run();

    expect(result.baseline).toBeDefined();
    expect(result.challenger).toBeDefined();
    expect(result.baseline.results).toHaveLength(5);
    expect(result.challenger.results).toHaveLength(5);

    expect(result.summary).toBeDefined();
    expect(result.summary.winner).toBeDefined();
    expect(['baseline', 'challenger', 'tie']).toContain(result.summary.winner);

    const emComparison = result.summary.metrics.exactMatch;
    expect(emComparison).toBeDefined();
    expect(emComparison.pValue).toBeGreaterThanOrEqual(0);
    expect(emComparison.pValue).toBeLessThanOrEqual(1);
    expect(emComparison.baseline).toBeGreaterThanOrEqual(0);
    expect(emComparison.baseline).toBeLessThanOrEqual(1);
    expect(emComparison.challenger).toBeGreaterThanOrEqual(0);
    expect(emComparison.challenger).toBeLessThanOrEqual(1);
  }, 60_000);
});
