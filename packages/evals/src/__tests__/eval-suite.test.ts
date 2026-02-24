import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalSuite } from '../eval-suite';
import { Dataset } from '../datasets';
import type { EvalCaseResult, MetricFn, MetricScore, StatisticalMetricFn } from '../metrics/types';
import type { LLMMetricFn } from '../metrics/llm-judge';
import type { AssertionFn, AggregatedMetric } from '../assertions';
import type { EvalProgress, EvalTarget } from '../eval-suite';

function makeMetricFn(name: string, scoreFn: (r: EvalCaseResult) => number = () => 0.9): MetricFn {
  const fn = (async (result: EvalCaseResult): Promise<MetricScore> => {
    return { name, score: scoreFn(result) };
  }) as MetricFn;
  Object.defineProperty(fn, 'metricName', { value: name, writable: false });
  return fn;
}

function makeStatisticalMetricFn(
  name: string,
  scoreFn: (results: EvalCaseResult[]) => number = () => 0.5
): StatisticalMetricFn {
  const fn = ((results: EvalCaseResult[]): MetricScore => {
    return { name, score: scoreFn(results) };
  }) as StatisticalMetricFn;
  Object.defineProperty(fn, 'metricName', { value: name, writable: false });
  return fn;
}

function makeLLMMetricFn(name: string): LLMMetricFn {
  const fn = (async (_result: EvalCaseResult): Promise<MetricScore> => {
    return { name, score: 0, details: 'unbound' };
  }) as LLMMetricFn;
  Object.defineProperty(fn, 'metricName', { value: name, writable: false });
  Object.defineProperty(fn, 'requiresJudge', { value: true, writable: false });
  Object.defineProperty(fn, '__judgeSystemPrompt', { value: 'test prompt', writable: false });
  Object.defineProperty(fn, '__judgeName', { value: name, writable: false });
  return fn;
}

function simpleDataset() {
  return Dataset.from([
    { input: 'hello', expected: 'world' },
    { input: 'foo', expected: 'bar' },
    { input: 'ping', expected: 'pong' },
  ]);
}

function simpleFnTarget(fn?: (input: string) => Promise<string>): EvalTarget {
  return { fn: fn ?? (async (input: string) => `echo: ${input}`) };
}

describe('EvalSuite', () => {
  describe('basic flow with fn target', () => {
    it('runs fn target against dataset and collects outputs', async () => {
      const suite = new EvalSuite({
        dataset: simpleDataset(),
        target: simpleFnTarget(),
      });

      const result = await suite.run();

      expect(result.results).toHaveLength(3);
      expect(result.results[0].output).toBe('echo: hello');
      expect(result.results[1].output).toBe('echo: foo');
      expect(result.results[2].output).toBe('echo: ping');
    });

    it('applies deterministic metrics to each case', async () => {
      const metric = makeMetricFn('quality', (r) => (r.output === 'echo: hello' ? 1 : 0.5));

      const suite = new EvalSuite({
        dataset: simpleDataset(),
        target: simpleFnTarget(),
        metrics: [metric],
      });

      const result = await suite.run();

      expect(result.results[0].scores).toEqual([{ name: 'quality', score: 1 }]);
      expect(result.results[1].scores).toEqual([{ name: 'quality', score: 0.5 }]);
    });

    it('returns aggregated results', async () => {
      const metric = makeMetricFn('accuracy', () => 0.8);

      const suite = new EvalSuite({
        dataset: simpleDataset(),
        target: simpleFnTarget(),
        metrics: [metric],
      });

      const result = await suite.run();

      expect(result.aggregated.accuracy).toBeDefined();
      expect(result.aggregated.accuracy.mean).toBeCloseTo(0.8, 10);
      expect(result.aggregated.accuracy.name).toBe('accuracy');
    });

    it('tracks duration in stats', async () => {
      const suite = new EvalSuite({
        dataset: simpleDataset(),
        target: simpleFnTarget(),
      });

      const result = await suite.run();

      expect(result.stats.total).toBe(3);
      expect(result.stats.duration).toBeGreaterThanOrEqual(0);
      expect(result.stats.cost).toBe(0);
    });

    it('records per-case duration', async () => {
      const suite = new EvalSuite({
        dataset: simpleDataset(),
        target: simpleFnTarget(async (input) => {
          await new Promise((r) => setTimeout(r, 10));
          return input;
        }),
      });

      const result = await suite.run();

      for (const r of result.results) {
        expect(r.duration).toBeGreaterThanOrEqual(5);
      }
    });
  });

  describe('agent target', () => {
    it('runs agent target via cogitator.run and extracts usage/toolCalls', async () => {
      const mockCogitator = {
        run: vi.fn().mockResolvedValue({
          output: 'agent response',
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, cost: 0.001, duration: 100 },
          toolCalls: [{ id: 'tc1', name: 'search', arguments: { q: 'test' } }],
        }),
      };
      const mockAgent = { name: 'test-agent' };

      const suite = new EvalSuite({
        dataset: Dataset.from([{ input: 'query' }]),
        target: { agent: mockAgent, cogitator: mockCogitator },
      });

      const result = await suite.run();

      expect(result.results[0].output).toBe('agent response');
      expect(result.results[0].usage).toEqual({
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        cost: 0.001,
        duration: 100,
      });
      expect(result.results[0].toolCalls).toEqual([
        { id: 'tc1', name: 'search', arguments: { q: 'test' } },
      ]);
      expect(mockCogitator.run).toHaveBeenCalledWith(mockAgent, {
        input: 'query',
        context: undefined,
      });
    });

    it('accumulates cost from usage in stats', async () => {
      const mockCogitator = {
        run: vi.fn().mockResolvedValue({
          output: 'ok',
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, cost: 0.005, duration: 50 },
        }),
      };

      const suite = new EvalSuite({
        dataset: Dataset.from([{ input: 'a' }, { input: 'b' }]),
        target: { agent: {}, cogitator: mockCogitator },
      });

      const result = await suite.run();

      expect(result.stats.cost).toBeCloseTo(0.01, 5);
    });

    it('passes context from eval case to cogitator.run', async () => {
      const mockCogitator = {
        run: vi.fn().mockResolvedValue({ output: 'ok' }),
      };

      const suite = new EvalSuite({
        dataset: Dataset.from([{ input: 'test', context: { key: 'value' } }]),
        target: { agent: {}, cogitator: mockCogitator },
      });

      await suite.run();

      expect(mockCogitator.run).toHaveBeenCalledWith(
        {},
        { input: 'test', context: { key: 'value' } }
      );
    });
  });

  describe('target validation', () => {
    it('throws if neither agent+cogitator nor fn provided', () => {
      expect(() => {
        new EvalSuite({
          dataset: simpleDataset(),
          target: {},
        });
      }).toThrow();
    });

    it('throws if both fn and agent+cogitator provided', () => {
      expect(() => {
        new EvalSuite({
          dataset: simpleDataset(),
          target: {
            fn: async () => 'test',
            agent: {},
            cogitator: {},
          },
        });
      }).toThrow();
    });

    it('throws if agent provided without cogitator', () => {
      expect(() => {
        new EvalSuite({
          dataset: simpleDataset(),
          target: { agent: {} },
        });
      }).toThrow();
    });

    it('throws if cogitator provided without agent', () => {
      expect(() => {
        new EvalSuite({
          dataset: simpleDataset(),
          target: { cogitator: {} },
        });
      }).toThrow();
    });
  });

  describe('concurrency', () => {
    it('with concurrency=1, cases run sequentially', async () => {
      const order: number[] = [];
      let running = 0;
      let maxConcurrent = 0;

      const fn = async (input: string) => {
        const idx = parseInt(input);
        running++;
        maxConcurrent = Math.max(maxConcurrent, running);
        order.push(idx);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        return `done-${idx}`;
      };

      const suite = new EvalSuite({
        dataset: Dataset.from([{ input: '1' }, { input: '2' }, { input: '3' }]),
        target: { fn },
        concurrency: 1,
      });

      await suite.run();

      expect(maxConcurrent).toBe(1);
      expect(order).toEqual([1, 2, 3]);
    });

    it('with concurrency=2, cases can overlap', async () => {
      let running = 0;
      let maxConcurrent = 0;

      const fn = async (input: string) => {
        running++;
        maxConcurrent = Math.max(maxConcurrent, running);
        await new Promise((r) => setTimeout(r, 30));
        running--;
        return input;
      };

      const suite = new EvalSuite({
        dataset: Dataset.from([{ input: '1' }, { input: '2' }, { input: '3' }, { input: '4' }]),
        target: { fn },
        concurrency: 2,
      });

      await suite.run();

      expect(maxConcurrent).toBe(2);
    });
  });

  describe('timeout', () => {
    it('marks case as timeout when exceeding timeout', async () => {
      const fn = async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return 'late';
      };

      const suite = new EvalSuite({
        dataset: Dataset.from([{ input: 'slow' }]),
        target: { fn },
        timeout: 1000,
      });

      const result = await suite.run();

      expect(result.results[0].output).toBe('');
      expect(result.results[0].duration).toBeGreaterThanOrEqual(900);
    });
  });

  describe('retries', () => {
    it('retries on failure and succeeds', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts === 1) throw new Error('transient');
        return 'success';
      };

      const suite = new EvalSuite({
        dataset: Dataset.from([{ input: 'retry-me' }]),
        target: { fn },
        retries: 2,
      });

      const result = await suite.run();

      expect(result.results[0].output).toBe('success');
      expect(attempts).toBe(2);
    });

    it('marks as error after exhausting all retries', async () => {
      const fn = async () => {
        throw new Error('persistent failure');
      };

      const suite = new EvalSuite({
        dataset: Dataset.from([{ input: 'fail' }]),
        target: { fn },
        retries: 2,
      });

      const result = await suite.run();

      expect(result.results[0].output).toBe('');
    });

    it('returns non-zero duration when all retries fail', async () => {
      const fn = async () => {
        await new Promise((r) => setTimeout(r, 20));
        throw new Error('always fails');
      };

      const suite = new EvalSuite({
        dataset: Dataset.from([{ input: 'fail' }]),
        target: { fn },
        retries: 1,
      });

      const result = await suite.run();

      expect(result.results[0].output).toBe('');
      expect(result.results[0].duration).toBeGreaterThan(0);
    });
  });

  describe('progress', () => {
    it('calls onProgress after each case with correct completed/total', async () => {
      const progress: EvalProgress[] = [];

      const suite = new EvalSuite({
        dataset: simpleDataset(),
        target: simpleFnTarget(),
        concurrency: 1,
        onProgress: (p) => progress.push({ ...p }),
      });

      await suite.run();

      expect(progress).toHaveLength(3);
      expect(progress[0]).toEqual(expect.objectContaining({ completed: 1, total: 3 }));
      expect(progress[1]).toEqual(expect.objectContaining({ completed: 2, total: 3 }));
      expect(progress[2]).toEqual(expect.objectContaining({ completed: 3, total: 3 }));
    });

    it('includes currentCase in progress', async () => {
      const progress: EvalProgress[] = [];

      const suite = new EvalSuite({
        dataset: Dataset.from([{ input: 'test-input', expected: 'test-expected' }]),
        target: simpleFnTarget(),
        onProgress: (p) => progress.push({ ...p }),
      });

      await suite.run();

      expect(progress[0].currentCase).toEqual({ input: 'test-input', expected: 'test-expected' });
    });
  });

  describe('LLM metrics', () => {
    it('detects requiresJudge and binds with judge context', async () => {
      const llmMetric = makeLLMMetricFn('faithfulness');

      const suite = new EvalSuite({
        dataset: Dataset.from([{ input: 'test', expected: 'expected' }]),
        target: simpleFnTarget(),
        metrics: [llmMetric],
        judge: { model: 'gpt-4', temperature: 0 },
      });

      const result = await suite.run();

      expect(result.results[0].scores).toHaveLength(1);
      expect(result.results[0].scores[0].name).toBe('faithfulness');
    });

    it('throws if LLM metrics present but no judge config', () => {
      const llmMetric = makeLLMMetricFn('faithfulness');

      expect(() => {
        new EvalSuite({
          dataset: simpleDataset(),
          target: simpleFnTarget(),
          metrics: [llmMetric],
        });
      }).toThrow();
    });
  });

  describe('statistical metrics', () => {
    it('runs statistical metrics on full results array', async () => {
      const statMetric = makeStatisticalMetricFn('avgLatency', (results) => {
        const total = results.reduce((sum, r) => sum + r.duration, 0);
        return total / results.length;
      });

      const suite = new EvalSuite({
        dataset: simpleDataset(),
        target: simpleFnTarget(),
        statisticalMetrics: [statMetric],
      });

      const result = await suite.run();

      expect(result.aggregated.avgLatency).toBeDefined();
      expect(result.aggregated.avgLatency.mean).toBeGreaterThanOrEqual(0);
    });

    it('only statistical metrics produce no per-case scores', async () => {
      const statMetric = makeStatisticalMetricFn('totalCost', () => 42);

      const suite = new EvalSuite({
        dataset: simpleDataset(),
        target: simpleFnTarget(),
        statisticalMetrics: [statMetric],
      });

      const result = await suite.run();

      for (const r of result.results) {
        expect(r.scores).toHaveLength(0);
      }

      expect(result.aggregated.totalCost).toBeDefined();
    });
  });

  describe('assertions', () => {
    it('runs assertions after metrics and includes in result', async () => {
      const metric = makeMetricFn('accuracy', () => 0.7);
      const assertFn: AssertionFn = (aggregated, _stats) => ({
        name: 'accuracy >= 0.8',
        passed: (aggregated.accuracy?.mean ?? 0) >= 0.8,
        message: `accuracy mean ${aggregated.accuracy?.mean ?? 0}`,
        actual: aggregated.accuracy?.mean,
        expected: 0.8,
      });

      const suite = new EvalSuite({
        dataset: simpleDataset(),
        target: simpleFnTarget(),
        metrics: [metric],
        assertions: [assertFn],
      });

      const result = await suite.run();

      expect(result.assertions).toHaveLength(1);
      expect(result.assertions[0].passed).toBe(false);
      expect(result.assertions[0].name).toBe('accuracy >= 0.8');
    });

    it('passes correct aggregated and stats to assertion', async () => {
      let _capturedAgg: Record<string, AggregatedMetric> = {};
      let capturedStats = { total: 0, duration: 0, cost: 0 };

      const assertFn: AssertionFn = (agg, stats) => {
        _capturedAgg = agg;
        capturedStats = stats;
        return { name: 'capture', passed: true, message: 'ok' };
      };

      const suite = new EvalSuite({
        dataset: simpleDataset(),
        target: simpleFnTarget(),
        assertions: [assertFn],
      });

      await suite.run();

      expect(capturedStats.total).toBe(3);
      expect(capturedStats.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('result methods', () => {
    it('result.report() delegates to reporter', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const suite = new EvalSuite({
        dataset: simpleDataset(),
        target: simpleFnTarget(),
        metrics: [makeMetricFn('test', () => 0.9)],
      });

      const result = await suite.run();
      result.report('console');

      const output = (logSpy.mock.calls as unknown[][])
        .map((c) => c.map(String).join(' '))
        .join('\n');
      expect(output).toContain('test');

      logSpy.mockRestore();
    });

    it('result.report() accepts array of reporters', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const suite = new EvalSuite({
        dataset: simpleDataset(),
        target: simpleFnTarget(),
        metrics: [makeMetricFn('test', () => 0.9)],
      });

      const result = await suite.run();
      result.report(['console', 'ci']);

      logSpy.mockRestore();
      exitSpy.mockRestore();
    });

    it('result.saveBaseline() writes metric means as JSON', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'evals-baseline-'));
      const baselinePath = join(tmpDir, 'baseline.json');

      const suite = new EvalSuite({
        dataset: simpleDataset(),
        target: simpleFnTarget(),
        metrics: [makeMetricFn('accuracy', () => 0.85), makeMetricFn('relevance', () => 0.7)],
      });

      const result = await suite.run();
      result.saveBaseline(baselinePath);

      const content = JSON.parse(readFileSync(baselinePath, 'utf-8'));
      expect(content.accuracy).toBeCloseTo(0.85, 10);
      expect(content.relevance).toBeCloseTo(0.7, 10);

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('edge cases', () => {
    it('empty dataset returns empty results and aggregated', async () => {
      const suite = new EvalSuite({
        dataset: Dataset.from([]),
        target: simpleFnTarget(),
        metrics: [makeMetricFn('test')],
      });

      const result = await suite.run();

      expect(result.results).toHaveLength(0);
      expect(Object.keys(result.aggregated)).toHaveLength(0);
      expect(result.assertions).toHaveLength(0);
      expect(result.stats.total).toBe(0);
    });

    it('no metrics returns results without scores', async () => {
      const suite = new EvalSuite({
        dataset: simpleDataset(),
        target: simpleFnTarget(),
      });

      const result = await suite.run();

      expect(result.results).toHaveLength(3);
      for (const r of result.results) {
        expect(r.scores).toHaveLength(0);
      }
      expect(Object.keys(result.aggregated)).toHaveLength(0);
    });

    it('handles fn target that returns empty string', async () => {
      const suite = new EvalSuite({
        dataset: Dataset.from([{ input: 'test' }]),
        target: { fn: async () => '' },
      });

      const result = await suite.run();

      expect(result.results[0].output).toBe('');
    });

    it('multiple metrics per case', async () => {
      const m1 = makeMetricFn('a', () => 0.9);
      const m2 = makeMetricFn('b', () => 0.3);

      const suite = new EvalSuite({
        dataset: Dataset.from([{ input: 'test' }]),
        target: simpleFnTarget(),
        metrics: [m1, m2],
      });

      const result = await suite.run();

      expect(result.results[0].scores).toHaveLength(2);
      expect(result.aggregated.a).toBeDefined();
      expect(result.aggregated.b).toBeDefined();
    });

    it('agent target with no usage data', async () => {
      const mockCogitator = {
        run: vi.fn().mockResolvedValue({ output: 'response' }),
      };

      const suite = new EvalSuite({
        dataset: Dataset.from([{ input: 'test' }]),
        target: { agent: {}, cogitator: mockCogitator },
      });

      const result = await suite.run();

      expect(result.results[0].output).toBe('response');
      expect(result.results[0].usage).toBeUndefined();
      expect(result.results[0].toolCalls).toBeUndefined();
    });
  });
});
