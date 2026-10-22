import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cogitator, Agent } from '@cogitator-ai/core';
import {
  EvalSuite,
  Dataset,
  contains,
  relevance,
  maxErrorRate,
  threshold,
  type JudgeCogitator,
} from '@cogitator-ai/evals';
import { describeEval } from '@cogitator-ai/evals/vitest';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const hasApiKey = !!GOOGLE_API_KEY || !!OPENAI_API_KEY;

function getModel(): string {
  if (GOOGLE_API_KEY) return 'google/gemini-3.5-flash-lite';
  return 'openai/gpt-6-luna';
}

function createCogitator(): Cogitator {
  return new Cogitator({
    llm: {
      defaultModel: getModel(),
      providers: {
        ...(GOOGLE_API_KEY && { google: { apiKey: GOOGLE_API_KEY } }),
        ...(OPENAI_API_KEY && { openai: { apiKey: OPENAI_API_KEY } }),
      },
    },
  });
}

function answerer(): Agent {
  return new Agent({
    name: 'Answerer',
    model: getModel(),
    instructions: 'Answer correctly in one short sentence.',
    temperature: 0,
  });
}

const describeIf = hasApiKey ? describe : describe.skip;

describeIf('Evals CI E2E', () => {
  let cogitator: Cogitator;
  let dir: string;

  beforeAll(() => {
    cogitator = createCogitator();
    dir = mkdtempSync(join(tmpdir(), 'evals-ci-e2e-'));
  });

  afterAll(async () => {
    await cogitator.close();
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('reuses judge verdicts from the cache and keeps the judge under its concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const judgeRuntime: JudgeCogitator = {
      run: async (agent, options) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        try {
          return await cogitator.run(agent as Agent, options);
        } finally {
          inFlight--;
        }
      },
    };
    const judgeRun = vi.spyOn(judgeRuntime, 'run');
    const answers: Record<string, string> = {
      'What is the capital of France?': 'Paris is the capital of France.',
      'How many legs does a spider have?': 'A spider has eight legs.',
      'What color is the sky on a clear day?': 'The sky is blue on a clear day.',
    };
    const suite = new EvalSuite({
      dataset: Dataset.from(Object.keys(answers).map((input) => ({ input }))),
      target: { fn: async (input) => answers[input] ?? '' },
      metrics: [relevance()],
      judge: { model: getModel(), cache: true, concurrency: 1, cogitator: judgeRuntime },
      concurrency: 3,
    });

    const first = await suite.run();
    const second = await suite.run();

    expect(judgeRun).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
    for (const result of [first, second]) {
      expect(result.aggregated.relevance.count).toBe(3);
      expect(result.aggregated.relevance.mean).toBeGreaterThan(0.5);
    }
    expect(second.stats.judgeCost).toBe(0);
    expect(second.aggregated.relevance.mean).toBe(first.aggregated.relevance.mean);
  }, 180_000);

  it('leaves a failed case unscored, judging only the answers, and fails maxErrorRate', async () => {
    const judgeRuntime: JudgeCogitator = {
      run: (agent, options) => cogitator.run(agent as Agent, options),
    };
    const judgeRun = vi.spyOn(judgeRuntime, 'run');
    const agent = answerer();
    const suite = new EvalSuite({
      dataset: Dataset.from([
        { input: 'What is the capital of Italy?', expected: 'Rome' },
        { input: 'What is the capital of Japan?', expected: 'Tokyo' },
        { input: 'fail this case', expected: 'never' },
      ]),
      target: {
        fn: async (input) => {
          if (input === 'fail this case') throw new Error('the target is down');
          return (await cogitator.run(agent, { input, useMemory: false })).output;
        },
      },
      metrics: [contains(), relevance()],
      judge: { model: getModel(), cogitator: judgeRuntime },
      assertions: [threshold('contains', 0.5), maxErrorRate(0.2)],
      retries: 1,
    });

    const result = await suite.run();

    expect(result.stats.errors).toBe(1);
    const failed = result.results.find((r) => r.case.input === 'fail this case');
    expect(failed?.error).toContain('the target is down');
    expect(failed?.scores).toEqual([]);
    expect(judgeRun).toHaveBeenCalledTimes(2);
    expect(result.aggregated.contains).toMatchObject({ count: 2, mean: 1 });
    expect(result.aggregated.relevance.count).toBe(2);
    expect(result.assertions.map((a) => a.passed)).toEqual([true, false]);
  }, 180_000);

  it('writes a JUnit report and a GitHub job summary of a real run', async () => {
    const summary = join(dir, 'summary.md');
    vi.stubEnv('GITHUB_STEP_SUMMARY', summary);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const agent = answerer();
    const suite = new EvalSuite({
      dataset: Dataset.from([
        { input: 'What is the capital of Germany? Answer in one word.', expected: 'Berlin' },
        { input: 'What is 3 + 4? Answer with the number only.', expected: '7' },
      ]),
      target: { agent, cogitator },
      metrics: [contains()],
      assertions: [threshold('contains', 2)],
      retries: 1,
    });

    const result = await suite.run();
    result.report(['junit', 'github'], { path: join(dir, 'qa') });

    const xml = readFileSync(join(dir, 'qa.xml'), 'utf-8');
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
    expect(xml).toContain('tests="3"');
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('What is the capital of Germany?');

    const annotations = log.mock.calls.map(([line]) => String(line));
    expect(annotations.some((line) => line.startsWith('::error'))).toBe(true);
    const written = readFileSync(summary, 'utf-8');
    expect(written).toContain('## Eval results');
    expect(written).toContain('**fail**');
  }, 180_000);
});

if (hasApiKey) {
  const cogitator = createCogitator();
  const qa = describeEval('Evals describeEval E2E', {
    suite: new EvalSuite({
      dataset: Dataset.from([
        { input: 'What is the capital of Spain? Answer in one word.', expected: 'Madrid' },
        { input: 'What is the largest planet? Answer in one word.', expected: 'Jupiter' },
      ]),
      target: { agent: answerer(), cogitator },
      metrics: [contains()],
      assertions: [threshold('contains', 0.5)],
      retries: 2,
    }),
    timeout: 120_000,
  });

  describe('Evals describeEval E2E result', () => {
    afterAll(async () => {
      await cogitator.close();
    });

    it('hands the finished run to the tests after the describe block', () => {
      const result = qa.result();
      expect(result.results).toHaveLength(2);
      expect(result.assertions.every((a) => a.passed)).toBe(true);
    });
  });
}
