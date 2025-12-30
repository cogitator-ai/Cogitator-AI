/**
 * @cogitator/workflows
 *
 * DAG-based workflow engine for Cogitator agents
 */

export { WorkflowBuilder } from './builder.js';

export { WorkflowExecutor } from './executor.js';

export { WorkflowScheduler } from './scheduler.js';

export {
  InMemoryCheckpointStore,
  FileCheckpointStore,
  createCheckpointId,
} from './checkpoint.js';

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

export {
  executeWithRetry,
  withRetry,
  Retryable,
  estimateRetryDuration,
  CircuitBreaker,
  createCircuitBreaker,
  CircuitBreakerOpenError,
  WithCircuitBreaker,
  CompensationManager,
  createCompensationManager,
  CompensationBuilder,
  compensationBuilder,
  BaseDLQ,
  InMemoryDLQ,
  FileDLQ,
  createInMemoryDLQ,
  createFileDLQ,
  createDLQEntry,
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

export {
  InMemoryTimerStore,
  FileTimerStore,
  createInMemoryTimerStore,
  createFileTimerStore,
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

export {
  TokenBucket,
  RateLimiter,
  SlidingWindowRateLimiter,
  createRateLimiter,
  createSlidingWindowLimiter,
  CronTriggerExecutor,
  createCronTrigger,
  validateCronTriggerConfig,
  WebhookTriggerExecutor,
  WebhookAuthError,
  WebhookRateLimitError,
  createWebhookTrigger,
  validateWebhookTriggerConfig,
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

export type {
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

  TimerEntry,
  TimerStore,

  ApprovalType,
  ApprovalChoice,
  ApprovalRequest,
  ApprovalResponse,
  ApprovalChainStep,
  HumanNodeConfig,
  ApprovalStore,
  ApprovalNotifier,

  ScheduleOptions,
  WorkflowRunStatus,
  WorkflowRun,
  WorkflowRunFilters,
  WorkflowRunStats,
  WorkflowManager,
  RunStore,

  CronTriggerConfig,
  WebhookAuthConfig,
  WebhookRateLimitConfig,
  WebhookTriggerConfig,
  EventTriggerConfig,
  TriggerContext,
  WorkflowTrigger,
  TriggerManager,
} from '@cogitator/types';
