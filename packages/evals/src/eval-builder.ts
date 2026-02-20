import { EvalSuite } from './eval-suite';
import type { EvalTarget, EvalSuiteOptions } from './eval-suite';
import { Dataset } from './datasets';
import type { MetricFn, StatisticalMetricFn } from './metrics/types';
import type { JudgeConfig } from './schema';
import type { AssertionFn } from './assertions';
import type { LLMMetricFn } from './metrics/llm-judge';

function isLLMMetric(m: MetricFn): m is LLMMetricFn {
  return 'requiresJudge' in m && (m as LLMMetricFn).requiresJudge === true;
}

export class EvalBuilder {
  private _dataset?: Dataset;
  private _target?: EvalTarget;
  private _metrics: MetricFn[] = [];
  private _statisticalMetrics: StatisticalMetricFn[] = [];
  private _judge?: JudgeConfig;
  private _assertions: AssertionFn[] = [];
  private _concurrency?: number;
  private _timeout?: number;
  private _retries?: number;
  private _onProgress?: EvalSuiteOptions['onProgress'];

  withDataset(dataset: Dataset): this {
    this._dataset = dataset;
    return this;
  }

  withTarget(target: EvalTarget): this {
    this._target = target;
    return this;
  }

  withMetrics(metrics: MetricFn[]): this {
    this._metrics = metrics;
    return this;
  }

  withStatisticalMetrics(metrics: StatisticalMetricFn[]): this {
    this._statisticalMetrics = metrics;
    return this;
  }

  withJudge(config: JudgeConfig): this {
    this._judge = config;
    return this;
  }

  withAssertions(assertions: AssertionFn[]): this {
    this._assertions = assertions;
    return this;
  }

  withConcurrency(n: number): this {
    this._concurrency = n;
    return this;
  }

  withTimeout(ms: number): this {
    this._timeout = ms;
    return this;
  }

  withRetries(n: number): this {
    this._retries = n;
    return this;
  }

  onProgress(fn: EvalSuiteOptions['onProgress']): this {
    this._onProgress = fn;
    return this;
  }

  build(): EvalSuite {
    if (!this._dataset) {
      throw new Error('Dataset is required. Use .withDataset()');
    }

    if (!this._target) {
      throw new Error('Target is required. Use .withTarget()');
    }

    const hasLLMMetrics = this._metrics.some(isLLMMetric);
    if (hasLLMMetrics && !this._judge) {
      throw new Error('Judge config required for LLM metrics. Use .withJudge()');
    }

    const opts: EvalSuiteOptions = {
      dataset: this._dataset,
      target: this._target,
      metrics: this._metrics.length > 0 ? this._metrics : undefined,
      statisticalMetrics:
        this._statisticalMetrics.length > 0 ? this._statisticalMetrics : undefined,
      judge: this._judge,
      assertions: this._assertions.length > 0 ? this._assertions : undefined,
      concurrency: this._concurrency,
      timeout: this._timeout,
      retries: this._retries,
      onProgress: this._onProgress,
    };

    return new EvalSuite(opts);
  }
}
