export const VERSION = '0.1.0';

export { EvalSuite } from './eval-suite';
export type { EvalTarget, EvalProgress, EvalSuiteOptions, EvalSuiteResult } from './eval-suite';
export { EvalComparison } from './eval-comparison';
export type { EvalComparisonOptions, MetricComparison, ComparisonResult } from './eval-comparison';
export { EvalBuilder } from './eval-builder';

export { Dataset } from './datasets';
export { loadJsonl } from './datasets';
export { loadCsv } from './datasets';

export { exactMatch, contains, regex, jsonSchema } from './metrics/deterministic';
export {
  faithfulness,
  relevance,
  coherence,
  helpfulness,
  llmMetric,
  bindJudgeContext,
} from './metrics/llm-judge';
export type { LLMMetricFn, JudgeContext } from './metrics/llm-judge';
export { latency, cost, tokenUsage } from './metrics/statistical';
export { metric } from './metrics/custom';
export type { MetricFn, MetricScore, EvalCaseResult, StatisticalMetricFn } from './metrics/types';
export type { CustomMetricConfig } from './metrics/custom';

export { threshold } from './assertions';
export { noRegression } from './assertions';
export { assertion } from './assertions';
export type { AssertionFn, AssertionResult, AggregatedMetric } from './assertions';

export { report } from './reporters';
export type { ReporterType, ReporterOptions } from './reporters';

export { pairedTTest } from './stats/t-test';
export type { TTestResult } from './stats/t-test';
export { mcnemarsTest } from './stats/mcnemar';
export type { McNemarResult } from './stats/mcnemar';
export { mean, median, stdDev, percentile, aggregate } from './stats/percentiles';

export type { EvalCase, EvalSuiteConfig, JudgeConfig, EvalComparisonConfig } from './schema';

export { createRunEvalTool, evalTools } from './tools';
export type { EvalTool } from './tools';
