import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalSuite } from '../eval-suite';
import type { EvalTargetContext } from '../eval-suite';
import { EvalComparison } from '../eval-comparison';
import { Dataset } from '../datasets';
import { metric } from '../metrics/custom';
import { exactMatch, regex } from '../metrics/deterministic';
import { faithfulness } from '../metrics/llm-judge';
import { latency } from '../metrics/statistical';
import type { EvalCaseResult, MetricFn, MetricScore } from '../metrics/types';
import type { AssertionFn } from '../assertions';

function rawMetric(name: string, score: (r: EvalCaseResult) => number): MetricFn {
  const fn = (async (r: EvalCaseResult): Promise<MetricScore> => ({
    name,
    score: score(r),
  })) as MetricFn;
  fn.metricName = name;
  return fn;
}

function threeCases() {
  return Dataset.from([{ input: 'a' }, { input: 'b' }, { input: 'c' }]);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      },
      { once: true }
    );
  });
}

describe('EvalSuite robustness', () => {
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  describe('a metric that throws', () => {
    it('keeps the case, scores the metric 0 with an error and rejects nothing', async () => {
      const flaky = rawMetric('flaky', (r) => {
        if (r.case.input === 'b') throw new Error('metric blew up');
        return 1;
      });

      const suite = new EvalSuite({
        dataset: threeCases(),
        target: { fn: async (input) => input },
        metrics: [flaky],
      });

      const result = await suite.run();
      await new Promise((r) => setTimeout(r, 20));

      expect(result.results).toHaveLength(3);
      expect(result.stats.total).toBe(3);
      expect(result.stats.metricErrors).toBe(1);
      const failed = result.results[1].scores[0];
      expect(failed).toMatchObject({ name: 'flaky', score: 0, error: 'metric blew up' });
      expect(result.aggregated.flaky.mean).toBeCloseTo(2 / 3, 5);
      expect(unhandled).toEqual([]);
    });

    it('keeps the other metrics of the case', async () => {
      const boom = rawMetric('boom', () => {
        throw new Error('nope');
      });

      const suite = new EvalSuite({
        dataset: Dataset.from([{ input: 'x', expected: 'x' }]),
        target: { fn: async (input) => input },
        metrics: [exactMatch(), boom],
      });

      const result = await suite.run();

      expect(result.results[0].scores.map((s) => [s.name, s.score])).toEqual([
        ['exactMatch', 1],
        ['boom', 0],
      ]);
    });

    it('keeps comparison arrays the same length, so the t-test runs', async () => {
      const flaky = rawMetric('quality', (r) => {
        if (r.output === 'challenger:b') throw new Error('flaky');
        return r.output.startsWith('challenger') ? 0.9 : 0.4 + r.case.input.charCodeAt(0) / 1000;
      });

      const comparison = new EvalComparison({
        dataset: threeCases(),
        targets: {
          baseline: { fn: async (input) => `baseline:${input}` },
          challenger: { fn: async (input) => `challenger:${input}` },
        },
        metrics: [flaky],
      });

      const result = await comparison.run();

      expect(result.challenger.results).toHaveLength(3);
      expect(result.summary.metrics.quality).toBeDefined();
    });
  });

  describe('an onProgress callback that throws', () => {
    it('loses no case and rejects nothing', async () => {
      const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
      const suite = new EvalSuite({
        dataset: threeCases(),
        target: { fn: async (input) => input },
        onProgress: () => {
          throw new Error('progress bar crashed');
        },
      });

      const result = await suite.run();
      await new Promise((r) => setTimeout(r, 20));

      expect(result.results.map((r) => r.output)).toEqual(['a', 'b', 'c']);
      expect(unhandled).toEqual([]);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('a score that is not a finite number', () => {
    it('counts as a metric error instead of a NaN score', async () => {
      const ratio = rawMetric('ratio', () => 0 / 0);

      const suite = new EvalSuite({
        dataset: threeCases(),
        target: { fn: async (input) => input },
        metrics: [ratio],
      });

      const result = await suite.run();

      expect(result.results[0].scores[0].score).toBe(0);
      expect(result.results[0].scores[0].error).toMatch(/not a finite number/);
      expect(result.aggregated.ratio.mean).toBe(0);
      expect(result.stats.metricErrors).toBe(3);
    });
  });

  describe('cases whose target fails', () => {
    it('are counted in stats.errors', async () => {
      const suite = new EvalSuite({
        dataset: threeCases(),
        target: {
          fn: async (input) => {
            if (input === 'c') throw new Error('down');
            return input;
          },
        },
      });

      const result = await suite.run();

      expect(result.stats.errors).toBe(1);
      expect(result.results[2].error).toBe('down');
    });
  });

  describe('timeouts', () => {
    it('abort the signal the fn target receives', async () => {
      let seen: AbortSignal | undefined;
      const suite = new EvalSuite({
        dataset: Dataset.from([{ input: 'slow' }]),
        target: {
          fn: async (_input, { signal }) => {
            seen = signal;
            await sleep(5000, signal);
            return 'late';
          },
        },
        timeout: 1000,
      });

      const result = await suite.run();

      expect(result.results[0].error).toBe('Timed out after 1000ms');
      expect(seen?.aborted).toBe(true);
    });

    it('pass the case and the attempt to a fn target', async () => {
      const contexts: Array<Pick<EvalTargetContext, 'attempt'> & { input: string }> = [];
      const suite = new EvalSuite({
        dataset: Dataset.from([{ input: 'q', expected: 'a' }]),
        target: {
          fn: async (_input, ctx) => {
            contexts.push({ input: ctx.case.input, attempt: ctx.attempt });
            if (ctx.attempt === 0) throw new Error('first fails');
            return 'a';
          },
        },
        retries: 1,
      });

      await suite.run();

      expect(contexts).toEqual([
        { input: 'q', attempt: 0 },
        { input: 'q', attempt: 1 },
      ]);
    });

    it('abort the agent run through the signal passed to cogitator.run', async () => {
      const signals: AbortSignal[] = [];
      const cogitator = {
        run: vi.fn(async (_agent: unknown, opts: { signal?: AbortSignal }) => {
          if (opts.signal) signals.push(opts.signal);
          await sleep(5000, opts.signal);
          return { output: 'late' };
        }),
      };

      const suite = new EvalSuite({
        dataset: Dataset.from([{ input: 'slow' }]),
        target: { agent: {}, cogitator },
        timeout: 1000,
      });

      const result = await suite.run();

      expect(result.results[0].error).toBe('Timed out after 1000ms');
      expect(signals).toHaveLength(1);
      expect(signals[0].aborted).toBe(true);
    });

    it('never run more attempts at once than the concurrency limit', async () => {
      let live = 0;
      let peak = 0;
      const suite = new EvalSuite({
        dataset: Dataset.from([{ input: 'slow' }]),
        target: {
          fn: async (_input, { signal }) => {
            live++;
            peak = Math.max(peak, live);
            try {
              await sleep(1500, signal);
              return 'done';
            } finally {
              live--;
            }
          },
        },
        timeout: 1000,
        retries: 2,
        concurrency: 1,
      });

      await suite.run();

      expect(peak).toBe(1);
    }, 10_000);

    it('wait for a target that ignores the signal before retrying', async () => {
      let live = 0;
      let peak = 0;
      const suite = new EvalSuite({
        dataset: Dataset.from([{ input: 'slow' }]),
        target: {
          fn: async () => {
            live++;
            peak = Math.max(peak, live);
            await sleep(1500);
            live--;
            return 'done';
          },
        },
        timeout: 1000,
        retries: 1,
        concurrency: 1,
      });

      await suite.run();

      expect(peak).toBe(1);
    }, 10_000);
  });

  describe('run({ signal })', () => {
    it('aborts the attempts in flight and rejects with the reason', async () => {
      const controller = new AbortController();
      const seen: AbortSignal[] = [];
      const suite = new EvalSuite({
        dataset: threeCases(),
        target: {
          fn: async (_input, { signal }) => {
            seen.push(signal);
            await sleep(5000, signal);
            return 'late';
          },
        },
        concurrency: 1,
      });

      setTimeout(() => controller.abort(new Error('stop the suite')), 50);

      await expect(suite.run({ signal: controller.signal })).rejects.toThrow('stop the suite');
      expect(seen).toHaveLength(1);
      expect(seen[0].aborted).toBe(true);
    });

    it('rejects at once when the signal is already aborted', async () => {
      const fn = vi.fn(async (input: string) => input);
      const suite = new EvalSuite({ dataset: threeCases(), target: { fn } });

      await expect(
        suite.run({ signal: AbortSignal.abort(new Error('never mind')) })
      ).rejects.toThrow('never mind');
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('cost', () => {
    const usage = (cost: number) => ({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cost,
      duration: 10,
    });

    it('includes the judge, with a target and judge breakdown', async () => {
      const run = vi.fn(async (agent: { name?: string }) =>
        agent.name === 'eval-judge'
          ? { output: '{"score": 1, "reasoning": "ok"}', usage: usage(0.002) }
          : { output: 'answer', usage: usage(0.01) }
      );

      const suite = new EvalSuite({
        dataset: Dataset.from([{ input: 'a' }, { input: 'b' }]),
        target: { agent: { name: 'target' }, cogitator: { run } },
        metrics: [faithfulness()],
        judge: { model: 'openai/gpt-6-luna' },
      });

      const result = await suite.run();

      expect(result.stats.targetCost).toBeCloseTo(0.02, 10);
      expect(result.stats.judgeCost).toBeCloseTo(0.004, 10);
      expect(result.stats.cost).toBeCloseTo(0.024, 10);
      expect(result.results[0].scores[0].usage?.cost).toBeCloseTo(0.002, 10);
    }, 60_000);

    it('lets a budget assertion see the judge cost', async () => {
      const run = vi.fn(async (agent: { name?: string }) =>
        agent.name === 'eval-judge'
          ? { output: '{"score": 1, "reasoning": "ok"}', usage: usage(0.5) }
          : { output: 'answer', usage: usage(0.01) }
      );
      const budget: AssertionFn = (_agg, stats) => ({
        name: 'budget',
        passed: stats.cost <= 0.1,
        message: `cost ${stats.cost}`,
      });

      const suite = new EvalSuite({
        dataset: Dataset.from([{ input: 'a' }]),
        target: { agent: { name: 'target' }, cogitator: { run } },
        metrics: [faithfulness()],
        judge: { model: 'openai/gpt-6-luna' },
        assertions: [budget],
      });

      const result = await suite.run();

      expect(result.assertions[0].passed).toBe(false);
    }, 60_000);

    it('counts an attempt that finished after it timed out', async () => {
      let attempt = 0;
      const cogitator = {
        run: vi.fn(async () => {
          attempt++;
          if (attempt === 1) {
            await sleep(1300);
            return { output: 'too late', usage: usage(0.03) };
          }
          return { output: 'in time', usage: usage(0.01) };
        }),
      };

      const suite = new EvalSuite({
        dataset: Dataset.from([{ input: 'a' }]),
        target: { agent: {}, cogitator },
        timeout: 1000,
        retries: 1,
      });

      const result = await suite.run();

      expect(result.results[0].output).toBe('in time');
      expect(result.results[0].attempts).toBe(2);
      expect(result.stats.targetCost).toBeCloseTo(0.04, 10);
      expect(result.results[0].usage?.cost).toBeCloseTo(0.04, 10);
    }, 10_000);
  });

  describe('metric names', () => {
    it('refuses two metrics with the same name', () => {
      expect(
        () =>
          new EvalSuite({
            dataset: threeCases(),
            target: { fn: async (input) => input },
            metrics: [regex(/\d{4}-\d{2}-\d{2}/), regex(/\[\d+\]/)],
          })
      ).toThrow(/regex/);
    });

    it('refuses a metric and a statistical metric with the same name', () => {
      expect(
        () =>
          new EvalSuite({
            dataset: threeCases(),
            target: { fn: async (input) => input },
            metrics: [metric({ name: 'latency', evaluate: () => ({ score: 1 }) })],
            statisticalMetrics: [latency()],
          })
      ).toThrow(/latency/);
    });

    it('keeps renamed metrics of one kind apart', async () => {
      const suite = new EvalSuite({
        dataset: Dataset.from([{ input: '2026-10-06' }, { input: '2026-10-07' }]),
        target: { fn: async (input) => input },
        metrics: [
          regex(/\d{4}-\d{2}-\d{2}/, { name: 'hasDate' }),
          regex(/\[\d+\]/, { name: 'hasCitation' }),
        ],
      });

      const result = await suite.run();

      expect(result.aggregated.hasDate.mean).toBe(1);
      expect(result.aggregated.hasCitation.mean).toBe(0);
    });
  });

  describe('saveBaseline', () => {
    it('refuses to write a value that is not a finite number', async () => {
      const suite = new EvalSuite({
        dataset: threeCases(),
        target: { fn: async (input) => input },
        statisticalMetrics: [
          Object.assign(() => ({ name: 'weird', score: Number.NaN }), { metricName: 'weird' }),
        ],
      });

      const result = await suite.run();

      const dir = mkdtempSync(join(tmpdir(), 'evals-baseline-'));
      const path = join(dir, 'baseline.json');
      try {
        expect(() => result.saveBaseline(path)).toThrow(/weird/);
        expect(existsSync(path)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
