import { describe, it, expect, vi, beforeAll } from 'vitest';
import { bindJudgeContext, judgeContextFor, llmMetric, relevance } from '../metrics/llm-judge';
import type { JudgeContext, JudgeRunOptions } from '../metrics/llm-judge';
import { gEval, stepsOf } from '../metrics/g-eval';
import { JudgeConfigSchema } from '../schema';
import type { JudgeCache, JudgeCogitator } from '../schema';
import type { EvalCaseResult } from '../metrics/types';

const caseResult = (output = 'a', input = 'q'): EvalCaseResult => ({
  case: { input },
  output,
  duration: 1,
});

const spent = (cost: number) => ({ inputTokens: 10, outputTokens: 5, totalTokens: 15, cost });

type Answer = { output: string; usage?: ReturnType<typeof spent> } | Error;

/** A judge context answering each call with the next of `answers`, the last one repeating */
function scriptedJudge(answers: Answer[], samples?: number) {
  let at = 0;
  const run = vi.fn(async (_opts: JudgeRunOptions) => {
    const answer = answers[Math.min(at++, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const context: JudgeContext = {
    cogitator: { run },
    judgeConfig: { model: 'judge', temperature: 0.7, ...(samples !== undefined && { samples }) },
  };
  return { context, run };
}

const verdict = (score: number | string, reasoning = 'because', cost?: number): Answer => ({
  output: JSON.stringify({ score, reasoning }),
  ...(cost !== undefined && { usage: spent(cost) }),
});

describe('judge.samples', () => {
  it('is a positive integer when given', () => {
    expect(JudgeConfigSchema.parse({ model: 'm', samples: 3 }).samples).toBe(3);
    expect(JudgeConfigSchema.parse({ model: 'm' }).samples).toBeUndefined();
    for (const samples of [0, -1, 1.5]) {
      expect(() => JudgeConfigSchema.parse({ model: 'm', samples })).toThrow();
    }
  });

  it('scores the mean of several verdicts, with their spread and summed usage', async () => {
    const judge = scriptedJudge(
      [verdict(0.6, 'meh', 0.01), verdict(0.9, 'good', 0.02), verdict(0.6, 'meh', 0.03)],
      3
    );
    const score = await bindJudgeContext(relevance(), judge.context)(caseResult());

    expect(judge.run).toHaveBeenCalledTimes(3);
    expect(judge.run.mock.calls.map(([opts]) => opts.sample)).toEqual([0, 1, 2]);
    expect(score.score).toBeCloseTo(0.7);
    expect(score.details).toBe('mean of 3 verdicts, spread 0.6..0.9');
    expect(score.usage?.cost).toBeCloseTo(0.06);
    expect(score.metadata).toEqual({
      samples: [
        { score: 0.6, reasoning: 'meh' },
        { score: 0.9, reasoning: 'good' },
        { score: 0.6, reasoning: 'meh' },
      ],
    });
    expect(score.error).toBeUndefined();
  });

  it('averages the verdicts it could read and reports the ones that failed', async () => {
    const judge = scriptedJudge(
      [verdict(1), { output: 'no verdict' }, new Error('rate limited')],
      3
    );
    const score = await bindJudgeContext(relevance(), judge.context)(caseResult());

    expect(score.score).toBe(1);
    expect(score.error).toBeUndefined();
    expect(score.details).toBe(
      'mean of 1 verdict, spread 1..1, 2 of 3 failed: could not parse judge response'
    );
    expect(score.metadata?.samples).toEqual([
      { score: 1, reasoning: 'because' },
      { error: 'could not parse judge response' },
      { error: 'rate limited' },
    ]);
  });

  it('scores 0 with an error when no verdict could be read', async () => {
    const judge = scriptedJudge([new Error('down')], 2);
    const score = await bindJudgeContext(relevance(), judge.context)(caseResult());
    expect(score).toEqual({
      name: 'relevance',
      score: 0,
      details: 'judge error: down',
      error: 'down',
    });
  });

  describe('with the cache', () => {
    beforeAll(async () => {
      await import('@cogitator-ai/core');
    }, 60_000);

    it('keeps each sample under its own key, so samples are not one cached verdict', async () => {
      const store = new Map<string, string>();
      const cache: JudgeCache = {
        get: (key) => store.get(key),
        set: (key, value) => void store.set(key, value),
      };
      let calls = 0;
      const run = vi.fn(async () => ({
        output: JSON.stringify({ score: [0.2, 0.4, 0.9][calls++ % 3], reasoning: 'r' }),
      }));
      const config = JudgeConfigSchema.parse({ model: 'm', temperature: 1, cache, samples: 3 });
      const metric = bindJudgeContext(
        relevance(),
        judgeContextFor({ run } as unknown as JudgeCogitator, config)
      );

      const first = await metric(caseResult());
      const again = await metric(caseResult());

      expect(run).toHaveBeenCalledTimes(3);
      expect(store.size).toBe(3);
      expect(first.score).toBeCloseTo(0.5);
      expect(again.score).toBeCloseTo(0.5);
      expect(again.usage).toBeUndefined();
      const keys = [...store.keys()].map((key) => JSON.parse(key) as unknown[]);
      expect(keys.map((key) => key[0])).toEqual([2, 2, 2]);
      expect(new Set(keys.map((key) => key[6]))).toEqual(new Set([0, 1, 2]));
    });
  });
});

describe('llmMetric with a rubric', () => {
  const rubric = [
    { score: 1, description: 'wrong or missing' },
    { score: 3, description: 'partly right' },
    { score: 5, description: 'fully right' },
  ];

  it('normalizes the level the judge picks by the lowest and highest level', async () => {
    const metric = llmMetric({ name: 'grade', rubric });
    for (const [picked, expected] of [
      [1, 0],
      [3, 0.5],
      [5, 1],
    ] as const) {
      const judge = scriptedJudge([verdict(picked)]);
      expect((await bindJudgeContext(metric, judge.context)(caseResult())).score).toBe(expected);
    }
  });

  it('never caches a level the rubric does not have, so the judge is asked again', async () => {
    const store = new Map<string, string>();
    const cache: JudgeCache = {
      get: (key) => store.get(key),
      set: (key, value) => void store.set(key, value),
    };
    const run = vi
      .fn()
      .mockResolvedValueOnce({ output: JSON.stringify({ score: 4, reasoning: 'between' }) })
      .mockResolvedValue({ output: JSON.stringify({ score: 5, reasoning: 'right' }) });
    const metric = bindJudgeContext(
      llmMetric({ name: 'grade', rubric }),
      judgeContextFor(
        { run } as unknown as JudgeCogitator,
        JudgeConfigSchema.parse({ model: 'm', cache })
      )
    );

    const first = await metric(caseResult());
    const again = await metric(caseResult());

    expect(first.error).toBeDefined();
    expect(again.score).toBe(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect([...store.values()]).toEqual([JSON.stringify({ score: 5, reasoning: 'right' })]);
  });

  it('shows the judge every level in order, with the prompt when given', async () => {
    const judge = scriptedJudge([verdict(3)]);
    const metric = llmMetric({
      name: 'grade',
      prompt: 'Grade the arithmetic.',
      rubric: [rubric[2], rubric[0], rubric[1]],
    });
    await bindJudgeContext(metric, judge.context)(caseResult());
    const prompt = judge.run.mock.calls[0][0].input;
    expect(prompt).toContain(
      'Grade the arithmetic.\n\nPick the one rubric level that fits the <response> best:\n1: wrong or missing\n3: partly right\n5: fully right'
    );
  });

  it('counts a verdict that is not a level as a judge error', async () => {
    const judge = scriptedJudge([verdict(4)]);
    const score = await bindJudgeContext(
      llmMetric({ name: 'grade', rubric }),
      judge.context
    )(caseResult());
    expect(score.score).toBe(0);
    expect(score.error).toBe('the judge gave 4, which is not a rubric level (1, 3, 5)');
  });

  it('reads a labelled level such as "Score: 3/5" on the rubric scale', async () => {
    const judge = scriptedJudge([{ output: 'Partly right. Score: 3/5' }]);
    const score = await bindJudgeContext(
      llmMetric({ name: 'grade', rubric }),
      judge.context
    )(caseResult());
    expect(score.score).toBe(0.5);
  });

  it('refuses a rubric of fewer than two levels, repeated scores or empty descriptions', () => {
    expect(() => llmMetric({ name: 'g', rubric: [{ score: 1, description: 'x' }] })).toThrow(
      'llmMetric: rubric: a rubric needs at least two levels'
    );
    expect(() =>
      llmMetric({
        name: 'g',
        rubric: [
          { score: 1, description: 'x' },
          { score: 1, description: 'y' },
        ],
      })
    ).toThrow('rubric levels need distinct scores');
    expect(() =>
      llmMetric({
        name: 'g',
        rubric: [
          { score: 0, description: ' ' },
          { score: 1, description: 'y' },
        ],
      })
    ).toThrow('a rubric level needs a description');
    expect(() => llmMetric({ name: '', prompt: 'p' })).toThrow('name must not be empty');
  });

  it('keeps the free prompt form scored from 0 to 1', async () => {
    const judge = scriptedJudge([verdict(0.4)]);
    const score = await bindJudgeContext(
      llmMetric({ name: 'tone', prompt: 'Rate tone.' }),
      judge.context
    )(caseResult());
    expect(score.score).toBe(0.4);
    expect(judge.run.mock.calls[0][0].input).toContain('Rate tone.\n\nScore from 0.0 to 1.0.');
  });
});

describe('gEval', () => {
  it('scores with the steps given, normalized from the scale, without generating steps', async () => {
    const judge = scriptedJudge([verdict(4, 'mostly')]);
    const metric = gEval({
      name: 'correctness',
      criteria: 'The answer is correct.',
      steps: ['Solve the problem', 'Compare the answer'],
    });
    const score = await bindJudgeContext(metric, judge.context)(caseResult());

    expect(score).toEqual({ name: 'correctness', score: 0.75, details: 'mostly' });
    expect(judge.run).toHaveBeenCalledTimes(1);
    const prompt = judge.run.mock.calls[0][0].input;
    expect(prompt).toContain('Evaluation steps:\n1. Solve the problem\n2. Compare the answer');
    expect(prompt).toContain('from 1 (does not meet the criteria at all) to 5 (fully meets them)');
  });

  it('generates the steps once per metric instance from the criteria', async () => {
    const run = vi.fn(async (opts: JudgeRunOptions) =>
      opts.format === 'text'
        ? {
            output: '1. Read the question\n2) Check the arithmetic\n- Ignore style',
            usage: spent(0.5),
          }
        : { output: '{"score": 5, "reasoning": "right"}', usage: spent(0.1) }
    );
    const context: JudgeContext = {
      cogitator: { run },
      judgeConfig: { model: 'j', temperature: 0 },
    };
    const metric = bindJudgeContext(
      gEval({ name: 'correctness', criteria: 'The answer is correct.' }),
      context
    );

    const scores = await Promise.all([metric(caseResult('a')), metric(caseResult('b'))]);
    const later = await metric(caseResult('c'));

    const textCalls = run.mock.calls.filter(([opts]) => opts.format === 'text');
    expect(textCalls).toHaveLength(1);
    expect(textCalls[0][0].input).toContain('The answer is correct.');
    expect([...scores, later].map((score) => score.score)).toEqual([1, 1, 1]);
    const verdictPrompt = run.mock.calls.find(([opts]) => opts.format !== 'text')![0].input;
    expect(verdictPrompt).toContain(
      'Evaluation steps:\n1. Read the question\n2. Check the arithmetic\n3. Ignore style'
    );
    const costs = [...scores, later].map((score) => score.usage?.cost ?? 0);
    expect(costs.reduce((sum, cost) => sum + cost, 0)).toBeCloseTo(0.8);
  });

  it('surfaces a failed generation as a metric error and tries again on the next case', async () => {
    let attempts = 0;
    const run = vi.fn(async (opts: JudgeRunOptions) => {
      if (opts.format === 'text') {
        attempts++;
        return { output: attempts === 1 ? 'I cannot help with that.' : '1. Check it' };
      }
      return { output: '{"score": 3, "reasoning": "ok"}' };
    });
    const context: JudgeContext = {
      cogitator: { run },
      judgeConfig: { model: 'j', temperature: 0 },
    };
    const metric = bindJudgeContext(gEval({ name: 'g', criteria: 'Correct.' }), context);

    const failed = await metric(caseResult());
    const recovered = await metric(caseResult());

    expect(failed.score).toBe(0);
    expect(failed.error).toBe(
      'gEval could not generate its evaluation steps: could not read evaluation steps from the judge, it gave no numbered list'
    );
    expect(recovered).toMatchObject({ score: 0.5 });
    expect(recovered.error).toBeUndefined();
  });

  it('clamps a verdict outside the scale and takes a custom scale', async () => {
    const metric = gEval({ name: 'g', criteria: 'c', steps: ['s'], scale: [0, 10] });
    expect(
      (await bindJudgeContext(metric, scriptedJudge([verdict(7)]).context)(caseResult())).score
    ).toBe(0.7);
    expect(
      (await bindJudgeContext(metric, scriptedJudge([verdict(12)]).context)(caseResult())).score
    ).toBe(1);
    expect(
      (await bindJudgeContext(metric, scriptedJudge([verdict(-3)]).context)(caseResult())).score
    ).toBe(0);
  });

  it('averages judge.samples verdicts in place of token probabilities', async () => {
    const judge = scriptedJudge([verdict(2), verdict(4), verdict(5)], 3);
    const metric = gEval({ name: 'g', criteria: 'c', steps: ['s'] });
    const score = await bindJudgeContext(metric, judge.context)(caseResult());
    expect(score.score).toBeCloseTo((0.25 + 0.75 + 1) / 3);
    expect(score.details).toBe('mean of 3 verdicts, spread 0.25..1');
  });

  it('refuses an empty name or criteria, empty steps and a scale that is not increasing', () => {
    expect(() => gEval({ name: 'g', criteria: ' ' })).toThrow('criteria must not be empty');
    expect(() => gEval({ name: 'g', criteria: 'c', steps: [] })).toThrow('give at least one step');
    expect(() => gEval({ name: 'g', criteria: 'c', scale: [5, 1] })).toThrow(
      'scale must be [min, max] with min below max'
    );
    expect(gEval({ name: 'g', criteria: 'c' }).requiresJudge).toBe(true);
  });
});

describe('gEval steps', () => {
  it('reads numbered, "Step N:" and bold list styles', () => {
    expect(
      stepsOf(
        'Here are the steps:\n1. Read the question\n2) Check the math\nStep 3: Compare the answer\n**4.** Weigh **clarity**\n**Step 5:** Decide\n- Note gaps\n* Score it'
      )
    ).toEqual([
      'Read the question',
      'Check the math',
      'Compare the answer',
      'Weigh **clarity**',
      'Decide',
      'Note gaps',
      'Score it',
    ]);
    expect(stepsOf('No list here.')).toEqual([]);
    expect(stepsOf('---\n*Note: be strict*\n* keep `__init__` as written')).toEqual([
      'keep `__init__` as written',
    ]);
  });

  it('counts what a failed generation cost, once per generation', async () => {
    const run = vi.fn(async (opts: JudgeRunOptions) =>
      opts.format === 'text'
        ? { output: 'Sorry, no list.', usage: spent(0.5) }
        : { output: '{"score": 3}' }
    );
    const context: JudgeContext = {
      cogitator: { run },
      judgeConfig: { model: 'j', temperature: 0 },
    };
    const metric = bindJudgeContext(gEval({ name: 'g', criteria: 'c' }), context);

    const first = await metric(caseResult());
    const second = await metric(caseResult());
    expect([first.usage?.cost, second.usage?.cost]).toEqual([0.5, 0.5]);
    expect(first.error).toContain('gEval could not generate its evaluation steps');

    const together = await Promise.all([metric(caseResult('a')), metric(caseResult('b'))]);
    expect(together.map((score) => score.error !== undefined)).toEqual([true, true]);
    expect(together.reduce((sum, score) => sum + (score.usage?.cost ?? 0), 0)).toBe(0.5);
  });

  describe('with the judge cache', () => {
    beforeAll(async () => {
      await import('@cogitator-ai/core');
    }, 60_000);

    it('never caches a steps answer without steps, and reuses a good one across runs', async () => {
      const store = new Map<string, string>();
      const cache: JudgeCache = {
        get: (key) => store.get(key),
        set: (key, value) => void store.set(key, value),
      };
      let stepCalls = 0;
      const run = vi.fn(async (_agent: unknown, { input }: { input: string }) => {
        if (input.includes('Write the evaluation steps')) {
          stepCalls++;
          return { output: stepCalls === 1 ? 'I would rather not.' : '**Step 1:** Check it' };
        }
        return { output: '{"score": 5, "reasoning": "r"}' };
      });
      const cogitator = { run } as unknown as JudgeCogitator;
      const config = JudgeConfigSchema.parse({ model: 'm', cache });
      const runOnce = () =>
        bindJudgeContext(
          gEval({ name: 'g', criteria: 'Correct.' }),
          judgeContextFor(cogitator, config)
        );

      const metric = runOnce();
      expect((await metric(caseResult())).error).toBeDefined();
      expect((await metric(caseResult())).score).toBe(1);
      expect(await runOnce()(caseResult())).toMatchObject({ score: 1 });

      expect(stepCalls).toBe(2);
      expect([...store.values()]).not.toContain('I would rather not.');
      expect([...store.values()]).toContain('**Step 1:** Check it');
    });
  });
});
