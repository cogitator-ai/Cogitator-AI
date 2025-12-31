/**
 * @cogitator-ai/core
 *
 * Core runtime for Cogitator AI agents
 */

export { Cogitator } from './cogitator';
export { Agent } from './agent';
export { tool, toolToSchema } from './tool';
export { ToolRegistry } from './registry';

export { calculator, datetime, builtinTools } from './tools/index';

export { Logger, getLogger, setLogger, createLogger } from './logger';
export type { LogLevel, LogContext, LogEntry, LoggerOptions } from './logger';

export { ReflectionEngine, InMemoryInsightStore } from './reflection/index';
export type { ReflectionEngineOptions } from './reflection/index';

export {
  ThoughtTreeExecutor,
  BranchGenerator,
  BranchEvaluator,
} from './reasoning/index';
export type { BranchEvaluatorOptions } from './reasoning/index';

export {
  AgentOptimizer,
  InMemoryTraceStore,
  MetricEvaluator,
  DemoSelector,
  InstructionOptimizer,
  createSuccessMetric,
  createExactMatchMetric,
  createContainsMetric,
} from './learning/index';
export type {
  AgentOptimizerOptions,
  MetricEvaluatorOptions,
  DemoSelectorOptions,
  InstructionOptimizerOptions,
} from './learning/index';

export {
  TimeTravel,
  InMemoryCheckpointStore,
  ExecutionReplayer,
  ExecutionForker,
  TraceComparator,
} from './time-travel/index';
export type {
  TimeTravelOptions,
  ExecutionReplayerOptions,
  ExecutionForkerOptions,
  TraceComparatorOptions,
} from './time-travel/index';

export {
  ConstitutionalAI,
  InputFilter,
  OutputFilter,
  ToolGuard,
  CritiqueReviser,
  DEFAULT_CONSTITUTION,
  DEFAULT_PRINCIPLES,
  createConstitution,
  extendConstitution,
  filterPrinciplesByLayer,
  getPrinciplesByCategory,
  getPrinciplesBySeverity,
  buildInputEvaluationPrompt,
  buildOutputEvaluationPrompt,
  buildCritiquePrompt,
  buildRevisionPrompt,
  parseEvaluationResponse,
  parseCritiqueResponse,
} from './constitutional/index';
export type {
  ConstitutionalAIOptions,
  InputFilterOptions,
  OutputFilterOptions,
  ToolGuardOptions,
  CritiqueReviserOptions,
} from './constitutional/index';

export {
  CostAwareRouter,
  TaskAnalyzer,
  ModelSelector,
  CostTracker,
  BudgetEnforcer,
} from './cost-routing/index';
export type {
  CostAwareRouterOptions,
  CostFilter,
  BudgetCheckResult,
} from './cost-routing/index';

export {
  BaseLLMBackend,
  OllamaBackend,
  OpenAIBackend,
  AnthropicBackend,
  createLLMBackend,
  parseModel,
} from './llm/index';

export {
  withRetry,
  retryable,
  CircuitBreaker,
  CircuitBreakerRegistry,
  withFallback,
  withGracefulDegradation,
  createLLMFallbackExecutor,
} from './utils/index';
export type {
  RetryOptions,
  CircuitBreakerOptions,
  CircuitBreakerStats,
  CircuitState,
  FallbackConfig,
  LLMFallbackConfig,
} from './utils/index';

export {
  CogitatorError,
  ErrorCode,
  ERROR_STATUS_CODES,
  isRetryableError,
  getRetryDelay,
} from '@cogitator-ai/types';
export type { ErrorDetails, CogitatorErrorOptions } from '@cogitator-ai/types';

export type {
  AgentConfig,
  ResponseFormat,
  Tool,
  ToolConfig,
  ToolContext,
  ToolSchema,
  Message,
  MessageRole,
  ToolCall,
  ToolResult,
  LLMBackend,
  LLMProvider,
  LLMConfig,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  CogitatorConfig,
  RunOptions,
  RunResult,
  Span,
  ToTConfig,
  ToTResult,
  ToTStats,
  ToTRunOptions,
  ThoughtTree,
  ThoughtNode,
  ThoughtBranch,
  BranchScore,
  ProposedAction,
  ExplorationStrategy,
  ExecutionTrace,
  ExecutionStep,
  TraceStore,
  TraceMetrics,
  TraceQuery,
  TraceStoreStats,
  Demo,
  DemoStep,
  DemoStats,
  MetricResult,
  MetricFn,
  MetricDefinition,
  MetricEvaluatorConfig,
  BuiltinMetric,
  InstructionGap,
  InstructionOptimizationResult,
  OptimizerConfig,
  OptimizationResult,
  LearningConfig,
  LearningRunOptions,
  LearningRunResult,
  CompileOptions,
  LearningStats,
} from '@cogitator-ai/types';
export {
  DEFAULT_TOT_CONFIG,
  DEFAULT_LEARNING_CONFIG,
  DEFAULT_OPTIMIZER_CONFIG,
  DEFAULT_TIME_TRAVEL_CONFIG,
} from '@cogitator-ai/types';

export type {
  ExecutionCheckpoint,
  TimeTravelCheckpointStore,
  CheckpointQuery,
  ReplayOptions,
  ReplayResult,
  ReplayMode,
  ForkOptions,
  ForkResult,
  TraceDiff,
  StepDiff,
  StepDiffStatus,
  TimeTravelConfig,
} from '@cogitator-ai/types';

export type {
  HarmCategory,
  Severity,
  FilterLayer,
  PrincipleCategory,
  ConstitutionalPrinciple,
  Constitution,
  HarmScore,
  FilterResult,
  CritiqueResult,
  RevisionResult,
  GuardrailConfig,
  ToolGuardResult,
} from '@cogitator-ai/types';
export { DEFAULT_GUARDRAIL_CONFIG } from '@cogitator-ai/types';

export type {
  CostRoutingConfig,
  BudgetConfig,
  CostRecord,
  CostSummary,
  ModelRecommendation,
  TaskRequirements,
  TaskComplexity,
  ReasoningLevel,
  SpeedPreference,
  CostSensitivity,
} from '@cogitator-ai/types';
export { DEFAULT_COST_ROUTING_CONFIG } from '@cogitator-ai/types';
