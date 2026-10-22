import { describe, it, expect, vi, beforeAll } from 'vitest';
import { calibrateJudge } from '../calibrate-judge';
import { metric } from '../metrics/custom';
import { bindJudgeContext, llmMetric, relevance } from '../metrics/llm-judge';
import type { JudgeCogitator } from '../schema';

const examples = [
  { input: 'q0', output: '0.1', label: 0 },
  { input: 'q1', output: '0.4', label: 0.3 },
  { input: 'q2', output: '0.7', label: 0.8 },
  { input: 'q3', output: '0.9', label: 1 },
];

/** A metric that scores the number in the output */
const readsOutput = metric({
  name: 'reads',
  evaluate: ({ output }) => ({ score: Number(output) }),
});

describe('calibrateJudge', () => {
  it('compares the scores with the labels', async () => {
    const calibration = await calibrateJudge(readsOutput, examples);

    expect(calibration.n).toBe(4);
    expect(calibration.errors).toBe(0);
    expect(calibration.spearman).toBeCloseTo(1);
    expect(calibration.pearson).toBeGreaterThan(0.95);
    expect(calibration.mae).toBeCloseTo((0.1 + 0.1 + 0.1 + 0.1) / 4);
    expect(calibration.kappa).toBe(1);
    expect(calibration.perCase[1]).toEqual({ index: 1, label: 0.3, score: 0.4 });
  });

  it('measures kappa at the threshold', async () => {
    const calibration = await calibrateJudge(readsOutput, examples, { threshold: 0.35 });
    expect(calibration.kappa).toBeCloseTo(0.5);
  });

  it('gives the metric the expected answer and context of each example', async () => {
    const seen = vi.fn();
    const spy = metric({
      name: 'spy',
      evaluate: (data) => {
        seen(data);
        return { score: 1 };
      },
    });
    await calibrateJudge(spy, [
      { input: 'q', output: 'a', expected: 'b', context: { doc: 'd' }, label: 1 },
    ]);
    expect(seen).toHaveBeenCalledWith(
      expect.objectContaining({ input: 'q', output: 'a', expected: 'b', context: { doc: 'd' } })
    );
  });

  it('reports the examples the metric failed on and leaves them out of the figures', async () => {
    const flaky = metric({
      name: 'flaky',
      evaluate: ({ input, output }) => {
        if (input === 'q1') throw new Error('boom');
        return { score: Number(output) };
      },
    });
    const calibration = await calibrateJudge(flaky, examples);
    expect(calibration.n).toBe(3);
    expect(calibration.errors).toBe(1);
    expect(calibration.perCase[1]).toEqual({ index: 1, label: 0.3, error: 'boom' });
  });

  it('is NaN where a figure is undefined', async () => {
    const constant = metric({ name: 'c', evaluate: () => ({ score: 1 }) });
    const calibration = await calibrateJudge(constant, [
      { input: 'a', output: 'a', label: 1 },
      { input: 'b', output: 'b', label: 1 },
    ]);
    expect(calibration.pearson).toBeNaN();
    expect(calibration.kappa).toBeNaN();
    expect(calibration.mae).toBe(0);
  });

  it('runs a bound judge metric, and an unbound one through options.judge', async () => {
    const run = vi.fn(async ({ input }: { input: string }) => ({
      output: `{"score": ${input.includes('<response>\nright') ? 1 : 0}, "reasoning": "r"}`,
    }));
    const bound = bindJudgeContext(relevance(), {
      cogitator: { run },
      judgeConfig: { model: 'judge', temperature: 0 },
    });
    const labelled = [
      { input: 'q', output: 'right', label: 1 },
      { input: 'q', output: 'wrong', label: 0 },
    ];
    expect((await calibrateJudge(bound, labelled)).kappa).toBe(1);

    await import('@cogitator-ai/core');
    const cogitator = {
      run: async (_agent: unknown, opts: { input: string }) => run(opts),
    } as unknown as JudgeCogitator;
    const viaOptions = await calibrateJudge(
      llmMetric({ name: 'tone', prompt: 'Rate.' }),
      labelled,
      {
        judge: { model: 'judge', cogitator },
      }
    );
    expect(viaOptions.mae).toBe(0);
  }, 60_000);

  describe('refuses', () => {
    beforeAll(async () => {
      await import('@cogitator-ai/core');
    }, 60_000);

    it('an unbound judge metric without a judge to run it', async () => {
      await expect(calibrateJudge(relevance(), examples)).rejects.toThrow(
        'calibrateJudge needs options.judge to run an unbound judge metric'
      );
      await expect(
        calibrateJudge(relevance(), examples, { judge: { model: 'judge' } })
      ).rejects.toThrow('calibrateJudge needs judge.cogitator');
    });

    it('labels outside 0 to 1 and a threshold outside 0 to 1', async () => {
      await expect(
        calibrateJudge(readsOutput, [{ input: 'q', output: '1', label: 5 }])
      ).rejects.toThrow('calibrateJudge examples: 0.label');
      await expect(calibrateJudge(readsOutput, examples, { threshold: 2 })).rejects.toThrow(
        'calibrateJudge: threshold'
      );
    });
  });
});
