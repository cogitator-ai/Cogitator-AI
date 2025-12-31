/**
 * @cogitator-ai/workflows
 *
 * DAG-based workflow engine for Cogitator agents
 */

export { WorkflowBuilder } from './builder';

export { WorkflowExecutor } from './executor';

export { WorkflowScheduler } from './scheduler';

export {
  InMemoryCheckpointStore,
  FileCheckpointStore,
  createCheckpointId,
} from './checkpoint';

export {
  agentNode,
  toolNode,
  functionNode,
  customNode,
} from './nodes/index';

export type {
  AgentNodeOptions,
} from './nodes/agent';

export type {
  ToolNodeOptions,
} from './nodes/tool';

export type {
  SimpleNodeFn,
  FullNodeFn,
  FunctionNodeOptions,
} from './nodes/function';

export type {
  ExtendedNodeContext,
} from './nodes/base';

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
} from './observability/index';

export type {
  SpanExporterInstance,
  ExporterConfig,
} from './observability/index';

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
} from './saga/index';

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
} from './saga/index';

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
} from './timers/index';

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
} from './timers/index';

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
} from './patterns/index';

export type {
  MapItemResult,
  MapProgressEvent,
  MapNodeConfig,
  ReduceNodeConfig,
  MapReduceResult,
  MapReduceNodeConfig,
} from './patterns/index';

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
} from './subworkflows/index';

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
} from './subworkflows/index';

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
} from './human/index';

export type {
  HumanNodeContext,
  HumanNodeResult,
} from './human/index';

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
} from './manager/index';

export type {
  QueueItem,
  SchedulerConfig,
  CronJob,
  WorkflowManagerConfig,
} from './manager/index';

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
} from './triggers/index';

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
} from './triggers/index';

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
} from '@cogitator-ai/types';
