import { describe, it, expect } from 'vitest';
import { EvalSuite } from '../eval-suite';
import { EvalComparison } from '../eval-comparison';
import { Dataset } from '../datasets';
import { exactMatch, contains, similarity } from '../metrics/deterministic';
import { latency } from '../metrics/statistical';
import { compareRuns } from '../runs';
import type { EvalRun } from '../runs';
import type { EvalCaseInput } from '../schema';
import type { EvalPrompt } from '../metrics/types';

const CASES: EvalCaseInput[] = Array.from({ length: 12 }, (_, i) => ({
  input: `question ${i}`,
  expected: `answer ${i}`,
}));

type Answer = (input: string) => string | Error;

async function runWith(
  answer: Answer,
  options: { cases?: EvalCaseInput[]; metrics?: 'both' | 'exact'; name?: string } = {}
): Promise<EvalRun> {
  const suite = new EvalSuite({
    dataset: Dataset.from(options.cases ?? CASES),
    target: {
      fn: async (input) => {
        const out = answer(input);
        if (out instanceof Error) throw out;
        return out;
      },
    },
    metrics: options.metrics === 'exact' ? [exactMatch()] : [exactMatch(), similarity()],
    ...(options.name !== undefined && { name: options.name }),
  });
  return (await suite.run()).toRun();
}

const index = (input: string) => Number(input.split(' ')[1]);
const right: Answer = (input) => `answer ${index(input)}`;
const rightUpTo =
  (n: number): Answer =>
  (input) =>
    index(input) < n ? `answer ${index(input)}` : 'no idea';

describe('compareRuns', () => {
  it('computes the same statistics as EvalComparison, base as baseline and head as challenger', async () => {
    const baseAnswer = rightUpTo(4);
    const headAnswer = rightUpTo(11);
    const base = await runWith(baseAnswer);
    const head = await runWith(headAnswer);

    const comparison = await new EvalComparison({
      dataset: Dataset.from(CASES),
      targets: {
        baseline: { fn: async (input) => baseAnswer(input) as string },
        challenger: { fn: async (input) => headAnswer(input) as string },
      },
      metrics: [exactMatch(), similarity()],
      seed: 7,
    }).run();
    const runs = compareRuns(base, head, { seed: 7 });

    for (const name of ['exactMatch', 'similarity']) {
      const expected = comparison.summary.metrics[name];
      const { base: b, head: h, winner, improved, regressed, ...stats } = runs.metrics[name];
      expect(b).toBe(expected.baseline);
      expect(h).toBe(expected.challenger);
      expect(stats).toEqual({
        n: expected.n,
        difference: expected.difference,
        ci: expected.ci,
        effectSize: expected.effectSize,
        test: expected.test,
        pValue: expected.pValue,
        adjustedPValue: expected.adjustedPValue,
        significant: expected.significant,
      });
      expect(winner).toBe(expected.winner === 'challenger' ? 'head' : expected.winner);
      expect(regressed).toEqual([]);
      expect(improved).toHaveLength(7);
    }
    expect(runs.metrics.exactMatch).toMatchObject({ test: 'mcnemar-exact', winner: 'head' });
    expect(runs.winner).toBe(comparison.summary.winner === 'challenger' ? 'head' : 'tie');
    expect(runs).toMatchObject({ matched: 12, added: [], removed: [], warnings: [] });
  });

  it('accepts suite results as well as runs, and refs both runs', async () => {
    const suite = (answer: Answer) =>
      new EvalSuite({
        dataset: Dataset.from(CASES.slice(0, 3)),
        target: { fn: async (input) => answer(input) as string },
        metrics: [exactMatch()],
        name: 'qa',
      });
    const base = await suite(right).run();
    const head = await suite(right).run();

    const runs = compareRuns(base, head);

    expect(runs.base).toEqual({ runId: base.runId, name: 'qa', startedAt: base.startedAt });
    expect(runs.head.runId).toBe(head.runId);
    expect(runs.winner).toBe('tie');
    expect(runs.metrics.exactMatch).toMatchObject({ difference: 0, improved: [], regressed: [] });
  });

  it('matches cases by key in any order and lists the ones only one run has', async () => {
    const base = await runWith(right, { cases: CASES.slice(0, 4) });
    const head = await runWith(right, {
      cases: [CASES[3], CASES[1], { input: 'question 99', expected: 'answer 99' }, CASES[0]],
    });

    const runs = compareRuns(base, head);

    expect(runs.matched).toBe(3);
    expect(runs.metrics.exactMatch.n).toBe(3);
    expect(runs.added).toEqual([{ caseKey: head.results[2].caseKey, input: 'question 99' }]);
    expect(runs.removed).toEqual([{ caseKey: base.results[2].caseKey, input: 'question 2' }]);
    expect(runs.warnings).toEqual([
      'The datasets differ (fingerprints differ): 1 cases only in the head run, 1 only in the base run',
    ]);
  });

  it('warns when only the order or the context of the cases changed', async () => {
    const base = await runWith(right, { cases: CASES.slice(0, 2) });
    const head = await runWith(right, { cases: [CASES[1], CASES[0]] });

    expect(compareRuns(base, head).warnings[0]).toMatch(/every case matches by input/);
  });

  it('matches every case when only the context or metadata changed, and says so', async () => {
    const base = await runWith(right, { cases: CASES.slice(0, 3) });
    const head = await runWith(right, {
      cases: CASES.slice(0, 3).map((c) => ({
        ...c,
        context: { tone: 'formal' },
        metadata: { v: 2 },
      })),
    });

    const runs = compareRuns(base, head);

    expect(runs.matched).toBe(3);
    expect(runs.added).toEqual([]);
    expect(runs.removed).toEqual([]);
    expect(runs.warnings).toEqual([
      'The datasets differ (fingerprints differ) while every case matches by input, turns and expected answer: their order, context or metadata changed',
    ]);
  });

  it('pairs repeated cases occurrence by occurrence', async () => {
    const base = await runWith(right, { cases: [CASES[0], CASES[0], CASES[1]] });
    const head = await runWith(right, { cases: [CASES[0], CASES[1]] });

    const runs = compareRuns(base, head);

    expect(runs.matched).toBe(2);
    expect(runs.removed.map((c) => c.input)).toEqual(['question 0']);
  });

  it('lists improved and regressed cases per metric, the largest move first', async () => {
    const base = await runWith((input) => (index(input) === 5 ? 'answer 5' : 'answer'));
    const head = await runWith((input) =>
      index(input) === 5 ? 'wrong' : index(input) === 2 ? 'answer 2' : 'answer'
    );

    const { exactMatch: exact, similarity: similar } = compareRuns(base, head).metrics;

    expect(exact.improved).toEqual([
      { caseKey: base.results[2].caseKey, input: 'question 2', base: 0, head: 1, delta: 1 },
    ]);
    expect(exact.regressed).toEqual([
      { caseKey: base.results[5].caseKey, input: 'question 5', base: 1, head: 0, delta: -1 },
    ]);
    expect(similar.regressed[0].input).toBe('question 5');
    expect(similar.improved[0].delta).toBeGreaterThan(0);
  });

  it('counts an errored side as 0 and drops a case both runs errored on', async () => {
    const base = await runWith((input) => (index(input) === 0 ? new Error('down') : right(input)));
    const head = await runWith((input) => (index(input) <= 1 ? new Error('down') : right(input)));

    const exact = compareRuns(base, head).metrics.exactMatch;

    expect(exact.n).toBe(11);
    expect(exact.regressed).toEqual([
      expect.objectContaining({ input: 'question 1', base: 1, head: 0 }),
    ]);
  });

  it('compares the metrics both runs have, and warns about the others', async () => {
    const base = await runWith(right);
    const head = await runWith(right, { metrics: 'exact' });

    const runs = compareRuns(base, head);

    expect(Object.keys(runs.metrics)).toEqual(['exactMatch']);
    expect(runs.warnings).toEqual(['Metrics differ: only the base run has similarity']);
    expect(() => compareRuns(base, head, { metrics: ['similarity'] })).toThrow(
      /'similarity' not in both runs, the base run has exactMatch, similarity and the head run exactMatch/
    );
    expect(Object.keys(compareRuns(base, base, { metrics: ['similarity'] }).metrics)).toEqual([
      'similarity',
    ]);
  });

  it('adjusts the p-values with Holm across the compared metrics', async () => {
    const base = await runWith(rightUpTo(3));
    const head = await runWith(rightUpTo(10));

    const both = compareRuns(base, head, { seed: 1 });
    const one = compareRuns(base, head, { seed: 1, metrics: ['exactMatch'] });

    expect(one.metrics.exactMatch.adjustedPValue).toBe(one.metrics.exactMatch.pValue);
    expect(both.metrics.exactMatch.adjustedPValue).toBeGreaterThanOrEqual(
      both.metrics.exactMatch.pValue
    );
  });

  it('honors alpha and test', async () => {
    const base = await runWith(rightUpTo(5));
    const head = await runWith(rightUpTo(8));

    const strict = compareRuns(base, head, { alpha: 0.0001, test: 'wilcoxon' });

    expect(strict.metrics.exactMatch.significant).toBe(false);
    expect(strict.metrics.exactMatch.winner).toBe('tie');
    expect(strict.metrics.similarity.test).toBe('wilcoxon');
    expect(() => compareRuns(base, head, { alpha: 2 })).toThrow(/compareRuns: alpha/);
    expect(() => compareRuns(base, head, { metrics: [] })).toThrow(/compareRuns: metrics/);
  });

  it('warns when the prompt versions differ, naming them', async () => {
    const base = await runWith(right);
    const withPrompts = (run: EvalRun, prompts: EvalPrompt[]): EvalRun => ({ ...run, prompts });

    const warnings = compareRuns(
      withPrompts(base, [{ key: 'support', versionId: 'ver_1', version: 1 }, { key: 'router' }]),
      withPrompts(base, [
        { key: 'support', versionId: 'ver_2', version: 2 },
        { key: 'router' },
        { key: 'billing', abTest: { id: 'test_1', variant: 'treatment' } },
      ])
    ).warnings;

    expect(warnings).toEqual([
      "Prompt 'support' differs: the base run used v1 (ver_1), the head run v2 (ver_2)",
      "Prompt 'billing' is used by the head run only (A/B test test_1 (treatment))",
    ]);
  });

  it('warns when the judge or the statistical metrics differ', async () => {
    const base = await runWith(right);
    const judged = (judge: EvalRun['config']['judge'], statisticalMetrics: string[]): EvalRun => ({
      ...base,
      config: { ...base.config, statisticalMetrics, ...(judge && { judge }) },
    });

    const warnings = compareRuns(
      judged(undefined, []),
      judged({ model: 'judge/b', temperature: 0, samples: 3 }, [latency().metricName])
    ).warnings;

    expect(warnings).toEqual([
      'Metrics differ: only the head run has latency',
      'Judge differs: the base run used no judge, the head run judge/b at temperature 0, 3 samples',
    ]);
  });

  it('leaves out a metric no matched case was scored on, so Holm is unaffected', async () => {
    const withoutSimilarity = (run: EvalRun): EvalRun => ({
      ...run,
      results: run.results.map((r) => ({
        ...r,
        scores: r.scores.filter((score) => score.name !== 'similarity'),
      })),
    });
    const base = withoutSimilarity(await runWith(rightUpTo(3)));
    const head = withoutSimilarity(await runWith(rightUpTo(10)));

    const runs = compareRuns(base, head, { seed: 1 });
    const alone = compareRuns(base, head, { seed: 1, metrics: ['exactMatch'] });

    expect(Object.keys(runs.metrics)).toEqual(['exactMatch']);
    expect(runs.metrics.exactMatch).toEqual(alone.metrics.exactMatch);
    expect(runs.metrics.exactMatch.adjustedPValue).toBe(runs.metrics.exactMatch.pValue);
    expect(runs.warnings).toEqual([
      "Metric 'similarity' was scored on no case the runs share (every case errored or went unscored), so it is not compared",
    ]);

    const asked = compareRuns(base, head, { metrics: ['similarity'] }).metrics.similarity;
    expect(asked).toMatchObject({ n: 0, test: 'none', pValue: 1, winner: 'tie' });
    expect(asked.base).toBeNaN();
    expect(asked.head).toBeNaN();
    expect(asked.difference).toBeNaN();
  });

  it('leaves out every metric when every case errored on both runs', async () => {
    const down: Answer = () => new Error('down');
    const runs = compareRuns(await runWith(down), await runWith(down));

    expect(runs.metrics).toEqual({});
    expect(runs.warnings).toHaveLength(2);
  });

  it('compares nothing when the runs share no metric', async () => {
    const base = await runWith(right, { metrics: 'exact' });
    const head: EvalRun = {
      ...base,
      config: { ...base.config, metrics: ['contains'] },
      results: base.results.map((r) => ({
        ...r,
        scores: [{ name: contains().metricName, score: 1 }],
      })),
    };

    const runs = compareRuns(base, head);

    expect(runs.metrics).toEqual({});
    expect(runs.winner).toBe('tie');
  });
});
