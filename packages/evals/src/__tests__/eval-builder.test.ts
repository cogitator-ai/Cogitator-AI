import { describe, it, expect } from 'vitest';
import { EvalBuilder } from '../eval-builder';
import { EvalSuite } from '../eval-suite';
import { Dataset } from '../datasets';
import type { EvalCaseResult, MetricFn, MetricScore, StatisticalMetricFn } from '../metrics/types';
import type { LLMMetricFn } from '../metrics/llm-judge';
import type { AssertionFn } from '../assertions';
import type { EvalProgress } from '../eval-suite';

function makeMetricFn(name: string, score = 0.9): MetricFn {
  const fn = (async (_result: EvalCaseResult): Promise<MetricScore> => {
    return { name, score };
  }) as MetricFn;
  Object.defineProperty(fn, 'metricName', { value: name, writable: false });
  return fn;
}

function makeStatisticalMetricFn(name: string, score = 0.5): StatisticalMetricFn {
  const fn = ((_results: EvalCaseResult[]): MetricScore => {
    return { name, score };
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
  Object.defineProperty(fn, '__judgeSystemPrompt', { value: 'test', writable: false });
  Object.defineProperty(fn, '__judgeName', { value: name, writable: false });
  return fn;
}

function simpleDataset() {
  return Dataset.from([
    { input: 'hello', expected: 'world' },
    { input: 'foo', expected: 'bar' },
  ]);
}

describe('EvalBuilder', () => {
  describe('fluent chain', () => {
    it('builds EvalSuite with all options', () => {
      const dataset = simpleDataset();
      const metric = makeMetricFn('accuracy');
      const statMetric = makeStatisticalMetricFn('latency');
      const assertFn: AssertionFn = () => ({
        name: 'test',
        passed: true,
        message: 'ok',
      });
      const progressFn = (_p: EvalProgress) => {};

      const suite = new EvalBuilder()
        .withDataset(dataset)
        .withTarget({ fn: async (input: string) => input })
        .withMetrics([metric])
        .withStatisticalMetrics([statMetric])
        .withAssertions([assertFn])
        .withConcurrency(2)
        .withTimeout(5000)
        .withRetries(3)
        .onProgress(progressFn)
        .build();

      expect(suite).toBeInstanceOf(EvalSuite);
    });

    it('builds with only required options', () => {
      const suite = new EvalBuilder()
        .withDataset(simpleDataset())
        .withTarget({ fn: async (input: string) => input })
        .build();

      expect(suite).toBeInstanceOf(EvalSuite);
    });
  });

  describe('chaining', () => {
    it('each with* method returns this', () => {
      const builder = new EvalBuilder();

      expect(builder.withDataset(simpleDataset())).toBe(builder);
      expect(builder.withTarget({ fn: async () => '' })).toBe(builder);
      expect(builder.withMetrics([])).toBe(builder);
      expect(builder.withStatisticalMetrics([])).toBe(builder);
      expect(builder.withJudge({ model: 'gpt-4', temperature: 0 })).toBe(builder);
      expect(builder.withAssertions([])).toBe(builder);
      expect(builder.withConcurrency(1)).toBe(builder);
      expect(builder.withTimeout(5000)).toBe(builder);
      expect(builder.withRetries(1)).toBe(builder);
      expect(builder.onProgress(() => {})).toBe(builder);
    });
  });

  describe('validation', () => {
    it('throws when dataset is missing', () => {
      expect(() => {
        new EvalBuilder().withTarget({ fn: async () => '' }).build();
      }).toThrow('Dataset is required. Use .withDataset()');
    });

    it('throws when target is missing', () => {
      expect(() => {
        new EvalBuilder().withDataset(simpleDataset()).build();
      }).toThrow('Target is required. Use .withTarget()');
    });

    it('throws when LLM metrics present without judge', () => {
      expect(() => {
        new EvalBuilder()
          .withDataset(simpleDataset())
          .withTarget({ fn: async () => '' })
          .withMetrics([makeLLMMetricFn('faithfulness')])
          .build();
      }).toThrow('Judge config required for LLM metrics. Use .withJudge()');
    });

    it('does not throw when LLM metrics have judge config', () => {
      const suite = new EvalBuilder()
        .withDataset(simpleDataset())
        .withTarget({ fn: async () => '' })
        .withMetrics([makeLLMMetricFn('faithfulness')])
        .withJudge({ model: 'gpt-4', temperature: 0 })
        .build();

      expect(suite).toBeInstanceOf(EvalSuite);
    });

    it('does not throw when non-LLM metrics have no judge', () => {
      const suite = new EvalBuilder()
        .withDataset(simpleDataset())
        .withTarget({ fn: async () => '' })
        .withMetrics([makeMetricFn('accuracy')])
        .build();

      expect(suite).toBeInstanceOf(EvalSuite);
    });
  });

  describe('defaults', () => {
    it('uses defaults when optional values not set', async () => {
      const suite = new EvalBuilder()
        .withDataset(simpleDataset())
        .withTarget({ fn: async (input: string) => `echo: ${input}` })
        .build();

      const result = await suite.run();

      expect(result.results).toHaveLength(2);
      expect(result.results[0].output).toBe('echo: hello');
    });

    it('builds without metrics or assertions', async () => {
      const suite = new EvalBuilder()
        .withDataset(simpleDataset())
        .withTarget({ fn: async () => 'ok' })
        .build();

      const result = await suite.run();

      for (const r of result.results) {
        expect(r.scores).toHaveLength(0);
      }
      expect(result.assertions).toHaveLength(0);
    });
  });
});
