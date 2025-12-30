/**
 * @cogitator/workflows
 *
 * DAG-based workflow engine for Cogitator agents
 */

// Builder
export { WorkflowBuilder } from './builder.js';

// Executor
export { WorkflowExecutor } from './executor.js';

// Scheduler
export { WorkflowScheduler } from './scheduler.js';

// Checkpoint stores
export {
  InMemoryCheckpointStore,
  FileCheckpointStore,
  createCheckpointId,
} from './checkpoint.js';

// Pre-built nodes
export {
  agentNode,
  toolNode,
  functionNode,
  customNode,
} from './nodes/index.js';

export type {
  AgentNodeOptions,
} from './nodes/agent.js';

export type {
  ToolNodeOptions,
} from './nodes/tool.js';

export type {
  SimpleNodeFn,
  FullNodeFn,
  FunctionNodeOptions,
} from './nodes/function.js';

export type {
  ExtendedNodeContext,
} from './nodes/base.js';

// Observability
export {
  WorkflowTracer,
  createTracer,
  getGlobalTracer,
  setGlobalTracer,
  WorkflowMetricsCollector,
  createMetricsCollector,
  getGlobalMetrics,
  setGlobalMetrics,
  ConsoleSpanExporter,
  OTLPSpanExporter,
  ZipkinSpanExporter,
  CompositeSpanExporter,
  NoopSpanExporter,
  createSpanExporter,
} from './observability/index.js';

export type {
  SpanExporterInstance,
  ExporterConfig,
} from './observability/index.js';

// Saga pattern (retry, circuit breaker, compensation, DLQ)
export {
  // Retry
  executeWithRetry,
  withRetry,
  Retryable,
  estimateRetryDuration,
  // Circuit Breaker
  CircuitBreaker,
  createCircuitBreaker,
  CircuitBreakerOpenError,
  WithCircuitBreaker,
  // Compensation
  CompensationManager,
  createCompensationManager,
  CompensationBuilder,
  compensationBuilder,
  // Dead Letter Queue
  BaseDLQ,
  InMemoryDLQ,
  FileDLQ,
  createInMemoryDLQ,
  createFileDLQ,
  createDLQEntry,
  // Idempotency
  BaseIdempotencyStore,
  InMemoryIdempotencyStore,
  FileIdempotencyStore,
  createInMemoryIdempotencyStore,
  createFileIdempotencyStore,
  generateIdempotencyKey,
  generateCustomKey,
  idempotent,
  Idempotent,
} from './saga/index.js';

export type {
  RetryResult,
  AttemptInfo,
  RetryOptions,
  CircuitBreakerEvent,
  CircuitBreakerEventHandler,
  CircuitBreakerStats,
  CompensationStep,
  CompensationResult,
  CompensationReport,
  CompensationManagerSummary,
  ExtendedDeadLetterEntry,
  DLQFilters,
  IdempotencyCheckResult,
} from './saga/index.js';

// Timer system (delay nodes, cron scheduling)
export {
  // Timer stores
  InMemoryTimerStore,
  FileTimerStore,
  createInMemoryTimerStore,
  createFileTimerStore,
  // Cron parser
  CRON_PRESETS,
  CRON_FIELDS,
  validateCronExpression,
  parseCronExpression,
  getNextCronOccurrence,
  getPreviousCronOccurrence,
  getNextCronOccurrences,
  cronMatchesDate,
  msUntilNextCronOccurrence,
  describeCronExpression,
  createCronIterator,
  isValidCronExpression,
  getSupportedTimezones,
  isValidTimezone,
  // Timer nodes
  delayNode,
  dynamicDelayNode,
  cronWaitNode,
  untilNode,
  calculateTimerDelay,
  executeTimerNode,
  createTimerNodeHelpers,
  AbortError,
  Duration,
  parseDuration,
  formatDuration,
  // Timer manager
  TimerManager,
  createTimerManager,
  RecurringTimerScheduler,
  createRecurringScheduler,
} from './timers/index.js';

export type {
  TimerQueryOptions,
  ParsedCron,
  CronIteratorOptions,
  TimerNodeType,
  TimerNodeConfig,
  FixedDelayConfig,
  DynamicDelayConfig,
  CronWaitConfig,
  UntilDateConfig,
  AnyTimerNodeConfig,
  TimerNodeResult,
  TimerExecutionContext,
  TimerHandler,
  TimerManagerConfig,
  TimerManagerStats,
} from './timers/index.js';

// Map-Reduce pattern
export {
  executeMap,
  executeReduce,
  executeMapReduce,
  mapNode,
  reduceNode,
  mapReduceNode,
  parallelMap,
  sequentialMap,
  batchedMap,
  collect,
  sum,
  count,
  first,
  last,
  groupBy,
  partition,
  flatMap,
  stats,
} from './patterns/index.js';

export type {
  MapItemResult,
  MapProgressEvent,
  MapNodeConfig,
  ReduceNodeConfig,
  MapReduceResult,
  MapReduceNodeConfig,
} from './patterns/index.js';

// Subworkflows
export {
  executeSubworkflow,
  subworkflowNode,
  simpleSubworkflow,
  nestedSubworkflow,
  conditionalSubworkflow,
  MaxDepthExceededError,
  executeParallelSubworkflows,
  parallelSubworkflows,
  fanOutFanIn,
  scatterGather,
  raceSubworkflows,
  fallbackSubworkflows,
} from './subworkflows/index.js';

export type {
  SubworkflowErrorStrategy,
  SubworkflowRetryConfig,
  SubworkflowConfig,
  SubworkflowContext,
  SubworkflowResult,
  ParallelSubworkflowDef,
  ParallelSubworkflowsConfig,
  ParallelProgress,
  ParallelSubworkflowsResult,
} from './subworkflows/index.js';

// Human-in-the-Loop
export {
  InMemoryApprovalStore,
  FileApprovalStore,
  withDelegation,
  ConsoleNotifier,
  WebhookNotifier,
  CompositeNotifier,
  slackNotifier,
  filteredNotifier,
  priorityRouter,
  nullNotifier,
  executeHumanNode,
  humanNode,
  approvalNode,
  choiceNode,
  inputNode,
  ratingNode,
  chainNode,
  managementChain,
} from './human/index.js';

export type {
  HumanNodeContext,
  HumanNodeResult,
} from './human/index.js';

// Workflow Manager
export {
  InMemoryRunStore,
  FileRunStore,
  createInMemoryRunStore,
  createFileRunStore,
  PriorityQueue,
  JobScheduler,
  createJobScheduler,
  DefaultWorkflowManager,
  createWorkflowManager,
} from './manager/index.js';

export type {
  QueueItem,
  SchedulerConfig,
  CronJob,
  WorkflowManagerConfig,
} from './manager/index.js';

// Triggers (cron, webhooks, events)
export {
  // Rate limiter
  TokenBucket,
  RateLimiter,
  SlidingWindowRateLimiter,
  createRateLimiter,
  createSlidingWindowLimiter,
  // Cron trigger
  CronTriggerExecutor,
  createCronTrigger,
  validateCronTriggerConfig,
  // Webhook trigger
  WebhookTriggerExecutor,
  WebhookAuthError,
  WebhookRateLimitError,
  createWebhookTrigger,
  validateWebhookTriggerConfig,
  // Trigger manager
  InMemoryTriggerStore,
  SimpleTriggerEventEmitter,
  DefaultTriggerManager,
  createTriggerManager,
  cronTrigger,
  webhookTrigger,
  eventTrigger,
} from './triggers/index.js';

export type {
  TokenBucketConfig,
  RateLimitResult,
  CronTriggerState,
  CronTriggerResult,
  WebhookRequest,
  WebhookResponse,
  WebhookTriggerState,
  WebhookHandlerResult,
  TriggerStore,
  TriggerEventEmitter,
  TriggerManagerConfig,
} from './triggers/index.js';

// Re-export types from @cogitator/types for convenience
export type {
  // Core workflow types
  Workflow,
  WorkflowState,
  WorkflowNode,
  WorkflowResult,
  WorkflowEvent,
  WorkflowExecuteOptions,
  WorkflowCheckpoint,
  CheckpointStore,
  NodeContext,
  NodeResult,
  NodeConfig,
  NodeFn,
  Edge,
  SequentialEdge,
  ConditionalEdge,
  ParallelEdge,
  LoopEdge,
  AddNodeOptions,
  AddConditionalOptions,
  AddLoopOptions,

  // Observability types
  TracingConfig,
  MetricsConfig,
  SpanExporter,
  SpanKind,
  SpanStatus,
  SpanEvent,
  SpanLink,
  WorkflowSpan,
  NodeMetrics,
  WorkflowMetrics,
  TraceContext,
  Baggage,

  // Saga pattern types
  RetryConfig,
  BackoffStrategy,
  CircuitBreakerConfig,
  CircuitBreakerState,
  CompensationConfig,
  CompensationOrder,
  DeadLetterEntry,
  DeadLetterQueue,
  IdempotencyRecord,
  IdempotencyStore,

  // Timer types
  TimerEntry,
  TimerStore,

  // Human-in-the-Loop types
  ApprovalType,
  ApprovalChoice,
  ApprovalRequest,
  ApprovalResponse,
  ApprovalChainStep,
  HumanNodeConfig,
  ApprovalStore,
  ApprovalNotifier,

  // Manager types
  ScheduleOptions,
  WorkflowRunStatus,
  WorkflowRun,
  WorkflowRunFilters,
  WorkflowRunStats,
  WorkflowManager,
  RunStore,

  // Trigger types
  CronTriggerConfig,
  WebhookAuthConfig,
  WebhookRateLimitConfig,
  WebhookTriggerConfig,
  EventTriggerConfig,
  TriggerContext,
  WorkflowTrigger,
  TriggerManager,
} from '@cogitator/types';
