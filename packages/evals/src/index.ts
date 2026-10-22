import { createRequire } from 'node:module';

const packageJson = createRequire(import.meta.url)('../package.json') as { version: string };

export const VERSION: string = packageJson.version;

export { EvalSuite, isLLMMetric } from './eval-suite';
export type {
  EvalTarget,
  EvalTargetContext,
  EvalTurn,
  RetrievalToolResult,
  EvalProgress,
  EvalRunOptions,
  EvalSuiteOptions,
  EvalSuiteResult,
  EvalSuiteStats,
} from './eval-suite';
export { EvalComparison } from './eval-comparison';
export type {
  EvalComparisonOptions,
  EvalComparisonRunOptions,
  MetricComparison,
  ComparisonResult,
} from './eval-comparison';
export { EvalBuilder } from './eval-builder';

export { Dataset } from './datasets';
export { loadJsonl } from './datasets';
export { loadCsv } from './datasets';

export {
  exactMatch,
  contains,
  containsAll,
  containsAny,
  similarity,
  regex,
  jsonSchema,
} from './metrics/deterministic';
export {
  faithfulness,
  relevance,
  coherence,
  helpfulness,
  llmMetric,
  contextRelevance,
  bindJudgeContext,
} from './metrics/llm-judge';
export type { LLMMetricFn, JudgeContext, JudgeMessage } from './metrics/llm-judge';
export {
  latency,
  cost,
  tokenUsage,
  passAtK,
  passAtKEstimate,
  isPassAtKMetric,
} from './metrics/statistical';
export type { PassAtKOptions, PassAtKMetricFn } from './metrics/statistical';
export { toolCalls, trajectory, toolCallMatches, trajectoryScore } from './metrics/tool-calls';
export type {
  ToolCallsOptions,
  TrajectoryOptions,
  ToolArgumentsMatch,
  ToolCallsScore,
  TrajectoryOrder,
} from './metrics/tool-calls';
export {
  retrievalRecall,
  retrievalPrecision,
  retrievalMRR,
  ragSearchPassages,
} from './metrics/retrieval';
export { passageMatches } from './metrics/matching';
export { metric } from './metrics/custom';
export type {
  MetricFn,
  MetricScore,
  MetricUsage,
  MetricOptions,
  EvalCaseResult,
  ScoredCaseResult,
  EvalToolCall,
  EvalToolResult,
  EvalTurnResult,
  Passage,
  StatisticalMetricFn,
  StatisticalScore,
} from './metrics/types';
export type { CustomMetricConfig, CustomMetricData } from './metrics/custom';

export { threshold } from './assertions';
export { noRegression } from './assertions';
export { assertion } from './assertions';
export { maxErrorRate } from './assertions';
export type { AssertionFn, AssertionResult, AggregatedMetric, EvalStats } from './assertions';

export { report } from './reporters';
export type { ReporterType, ReporterOptions, ReportedCase } from './reporters';

export { pairedTTest } from './stats/t-test';
export type { TTestResult } from './stats/t-test';
export { mcnemarsTest } from './stats/mcnemar';
export type { McNemarResult } from './stats/mcnemar';
export { mean, median, stdDev, percentile, aggregate } from './stats/percentiles';

export type {
  EvalCase,
  ExpectedToolCall,
  EvalSuiteConfig,
  JudgeConfig,
  JudgeConfigInput,
  JudgeCache,
  JudgeCogitator,
  EvalComparisonConfig,
} from './schema';

export { createRunEvalTool, evalTools } from './tools';
export type { EvalTool } from './tools';
