import { describe, it, expect } from 'vitest';
import { EvalComparison } from '../eval-comparison';
import { Dataset } from '../datasets';
import { metric } from '../metrics/custom';
import { cohensD } from '../stats/effect-size';
import { wilcoxonSignedRank } from '../stats/wilcoxon';
import { pairedTTest } from '../stats/t-test';

const cases = (n: number) =>
  Dataset.from(Array.from({ length: n }, (_, i) => ({ input: `q${i}`, expected: `q${i}` })));

const exact = (name: string) =>
  metric({ name, evaluate: ({ output, expected }) => ({ score: output === expected ? 1 : 0 }) });

/** A target that answers the first `right` cases correctly and the rest wrong */
const answersRight = (right: number) => ({
  fn: async (input: string) => (Number(input.slice(1)) < right ? input : 'wrong'),
});

describe('EvalComparison statistics', () => {
  it('corrects significance with Holm across the metrics, keeping the raw p-value', async () => {
    const run = (metrics: ReturnType<typeof exact>[], alpha?: number) =>
      new EvalComparison({
        dataset: cases(10),
        targets: { baseline: answersRight(4), challenger: answersRight(10) },
        metrics,
        ...(alpha !== undefined && { alpha }),
      }).run();

    const alone = await run([exact('a')]);
    expect(alone.summary.metrics.a).toMatchObject({
      test: 'mcnemar-exact',
      significant: true,
      winner: 'challenger',
    });
    expect(alone.summary.metrics.a.pValue).toBeCloseTo(0.03125, 10);
    expect(alone.summary.metrics.a.adjustedPValue).toBeCloseTo(0.03125, 10);

    const two = await run([exact('a'), exact('b')]);
    for (const name of ['a', 'b']) {
      expect(two.summary.metrics[name].pValue).toBeCloseTo(0.03125, 10);
      expect(two.summary.metrics[name].adjustedPValue).toBeCloseTo(0.0625, 10);
      expect(two.summary.metrics[name]).toMatchObject({ significant: false, winner: 'tie' });
    }
    expect(two.summary.winner).toBe('tie');

    const lenient = await run([exact('a'), exact('b')], 0.1);
    expect(lenient.summary.metrics.a.winner).toBe('challenger');
    expect(lenient.summary.winner).toBe('challenger');
  });

  it("uses McNemar's chi-square from 25 discordant pairs", async () => {
    const result = await new EvalComparison({
      dataset: cases(30),
      targets: { baseline: answersRight(0), challenger: answersRight(30) },
      metrics: [exact('a')],
    }).run();
    expect(result.summary.metrics.a.test).toBe('mcnemar');
    expect(result.summary.metrics.a.winner).toBe('challenger');
  });

  const graded = metric({
    name: 'graded',
    evaluate: ({ input, output }) => {
      const i = Number(input.slice(1));
      return { score: output === 'better' ? 0.5 + ((i * 7) % 5) / 10 : 0.3 + ((i * 3) % 4) / 10 };
    },
  });
  const gradedTargets = {
    baseline: { fn: async () => 'worse' },
    challenger: { fn: async () => 'better' },
  };
  const gradedScores = (side: 'baseline' | 'challenger') =>
    Array.from({ length: 12 }, (_, i) =>
      side === 'challenger' ? 0.5 + ((i * 7) % 5) / 10 : 0.3 + ((i * 3) % 4) / 10
    );

  it('reports the mean difference, a seeded bootstrap interval and the effect size', async () => {
    const run = () =>
      new EvalComparison({
        dataset: cases(12),
        targets: gradedTargets,
        metrics: [graded],
        seed: 11,
      }).run();
    const [first, again] = await Promise.all([run(), run()]);
    const graded1 = first.summary.metrics.graded;

    const baseline = gradedScores('baseline');
    const challenger = gradedScores('challenger');
    const differences = challenger.map((c, i) => c - baseline[i]);
    const meanDifference = differences.reduce((s, d) => s + d, 0) / differences.length;

    expect(graded1.difference).toBeCloseTo(meanDifference, 10);
    expect(graded1.difference).toBeCloseTo(graded1.challenger - graded1.baseline, 10);
    expect(graded1.effectSize).toBeCloseTo(cohensD(differences), 10);
    expect(graded1.test).toBe('t');
    expect(graded1.pValue).toBeCloseTo(pairedTTest(baseline, challenger).pValue, 10);
    expect(graded1.ci.low).toBeLessThan(graded1.difference);
    expect(graded1.ci.high).toBeGreaterThan(graded1.difference);
    expect(again.summary.metrics.graded.ci).toEqual(graded1.ci);
  });

  it("runs Wilcoxon's signed-rank test with test: 'wilcoxon'", async () => {
    const result = await new EvalComparison({
      dataset: cases(12),
      targets: gradedTargets,
      metrics: [graded],
      test: 'wilcoxon',
    }).run();
    const graded1 = result.summary.metrics.graded;
    expect(graded1.test).toBe('wilcoxon');
    expect(graded1.pValue).toBeCloseTo(
      wilcoxonSignedRank(gradedScores('baseline'), gradedScores('challenger')).pValue,
      12
    );
    expect(graded1.winner).toBe('challenger');
  });

  it('refuses an alpha outside (0, 1) and an unknown test', () => {
    const base = {
      dataset: cases(2),
      targets: { baseline: answersRight(1), challenger: answersRight(1) },
    };
    expect(() => new EvalComparison({ ...base, alpha: 0 })).toThrow('EvalComparison: alpha');
    expect(() => new EvalComparison({ ...base, alpha: 1 })).toThrow();
    expect(() => new EvalComparison({ ...base, test: 'z' as unknown as 't' })).toThrow(
      'EvalComparison: test'
    );
  });

  it('compares latency per case, lower being better, outside the vote on the winner', async () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const result = await new EvalComparison({
      dataset: cases(8),
      targets: {
        baseline: {
          fn: async (input) => {
            await sleep(60);
            return input;
          },
        },
        challenger: { fn: async (input) => input },
      },
      concurrency: 8,
    }).run();

    const { latency } = result.summary;
    expect(latency.n).toBe(8);
    expect(latency.baseline).toBeGreaterThanOrEqual(55);
    expect(latency.challenger).toBeLessThan(latency.baseline);
    expect(latency.difference).toBeCloseTo(latency.challenger - latency.baseline, 10);
    expect(latency.winner).toBe('challenger');
    expect(result.summary.cost).toBeUndefined();
    expect(result.summary.winner).toBe('tie');
  });

  it('compares cost over the cases both sides answered and reported usage on', async () => {
    const agentTarget = (cost: number, failsOn?: string) => ({
      agent: {},
      cogitator: {
        run: async (_agent: unknown, { input }: { input: string }) => {
          if (input === failsOn) throw new Error('down');
          return {
            output: input,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cost, duration: 1 },
          };
        },
      },
    });
    const result = await new EvalComparison({
      dataset: cases(6),
      targets: { baseline: agentTarget(0.02, 'q0'), challenger: agentTarget(0.01) },
    }).run();

    expect(result.summary.cost).toMatchObject({
      n: 5,
      baseline: 0.02,
      challenger: 0.01,
      winner: 'challenger',
      significant: true,
    });
    expect(result.summary.cost!.difference).toBeCloseTo(-0.01, 10);
    expect(result.summary.latency.n).toBe(5);
  });

  describe("winner by the direction of Wilcoxon's test", () => {
    it('crowns the side most cases favor, not the one a single outlier favors', async () => {
      const outlier = metric({
        name: 'quality',
        evaluate: ({ input, output }) => ({
          score: input === 'q0' ? (output === 'base' ? 1 : 0) : output === 'base' ? 0.5 : 0.51,
        }),
      });
      const result = await new EvalComparison({
        dataset: cases(20),
        targets: { baseline: { fn: async () => 'base' }, challenger: { fn: async () => 'chal' } },
        metrics: [outlier],
        test: 'wilcoxon',
      }).run();

      const quality = result.summary.metrics.quality;
      expect(quality.difference).toBeLessThan(0);
      expect(quality.significant).toBe(true);
      expect(quality.winner).toBe('challenger');
    });

    it('does the same for cost, where lower is better', async () => {
      const agentTarget = (costOf: (input: string) => number) => ({
        agent: {},
        cogitator: {
          run: async (_agent: unknown, { input }: { input: string }) => ({
            output: input,
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
              cost: costOf(input),
              duration: 1,
            },
          }),
        },
      });
      const result = await new EvalComparison({
        dataset: cases(20),
        targets: {
          baseline: agentTarget(() => 0.1),
          challenger: agentTarget((input) => (input === 'q0' ? 1.1 : 0.09)),
        },
        test: 'wilcoxon',
      }).run();

      const cost = result.summary.cost!;
      expect(cost.test).toBe('wilcoxon');
      expect(cost.difference).toBeGreaterThan(0);
      expect(cost.significant).toBe(true);
      expect(cost.winner).toBe('challenger');
    });
  });
});
