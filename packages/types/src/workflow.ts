/**
 * Workflow types for DAG-based multi-step pipelines
 *
 * Includes:
 * - Core workflow execution types
 * - Human-in-the-loop approval system
 * - Saga pattern (retry, compensation, circuit breaker)
 * - Map-Reduce patterns
 * - Timer and scheduling system
 * - Subworkflow support
 * - Trigger system (cron, webhooks)
 * - OpenTelemetry observability
 * - Workflow management API
 */

export type WorkflowState = Record<string, unknown>;

export interface NodeConfig {
  name?: string;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
}

export interface NodeContext<S = WorkflowState> {
  state: S;
  input?: unknown;
  nodeId: string;
  workflowId: string;
  step: number;
  reportProgress?: (progress: number) => void;
}

export interface NodeResult<S = WorkflowState> {
  state?: Partial<S>;
  output?: unknown;
  next?: string | string[];
}

export type NodeFn<S = WorkflowState> = (ctx: NodeContext<S>) => Promise<NodeResult<S>>;

export interface WorkflowNode<S = WorkflowState> {
  name: string;
  fn: NodeFn<S>;
  config?: NodeConfig;
}

export type Edge = SequentialEdge | ConditionalEdge | ParallelEdge | LoopEdge;

export interface SequentialEdge {
  type: 'sequential';
  from: string;
  to: string;
}

export interface ConditionalEdge {
  type: 'conditional';
  from: string;
  condition: (state: unknown) => string | string[];
  targets: string[];
}

export interface ParallelEdge {
  type: 'parallel';
  from: string;
  to: string[];
}

export interface LoopEdge {
  type: 'loop';
  from: string;
  condition: (state: unknown) => boolean;
  back: string;
  exit: string;
}

export interface Workflow<S = WorkflowState> {
  name: string;
  initialState: S;
  nodes: Map<string, WorkflowNode<S>>;
  edges: Edge[];
  entryPoint: string;
}

export type CheckpointStrategy = 'per-iteration' | 'per-node';

export interface WorkflowExecuteOptions {
  maxConcurrency?: number;
  maxIterations?: number;
  checkpoint?: boolean;
  checkpointStrategy?: CheckpointStrategy;
  onNodeStart?: (node: string) => void;
  onNodeComplete?: (node: string, result: unknown, duration: number) => void;
  onNodeError?: (node: string, error: Error) => void;
  onNodeProgress?: (node: string, progress: number) => void;
}

export interface WorkflowResult<S = WorkflowState> {
  workflowId: string;
  workflowName: string;
  state: S;
  nodeResults: Map<string, { output: unknown; duration: number }>;
  duration: number;
  checkpointId?: string;
  error?: Error;
}

export type WorkflowEvent =
  | { type: 'node:start'; node: string; timestamp: number }
  | { type: 'node:complete'; node: string; output: unknown; duration: number }
  | { type: 'node:error'; node: string; error: Error }
  | { type: 'workflow:complete'; state: unknown; duration: number };

export type StreamingWorkflowEvent =
  | { type: 'workflow_started'; workflowId: string; workflowName: string; timestamp: number }
  | { type: 'node_started'; nodeName: string; timestamp: number }
  | { type: 'node_progress'; nodeName: string; progress: number; timestamp: number }
  | { type: 'node_completed'; nodeName: string; output: unknown; duration: number }
  | { type: 'node_error'; nodeName: string; error: Error; timestamp: number }
  | {
      type: 'workflow_completed';
      workflowId: string;
      result: WorkflowResult<unknown>;
      duration: number;
    };

export interface WorkflowCheckpoint {
  id: string;
  workflowId: string;
  workflowName: string;
  state: WorkflowState;
  completedNodes: string[];
  nodeResults: Record<string, unknown>;
  timestamp: number;
}

export interface CheckpointStore {
  save(checkpoint: WorkflowCheckpoint): Promise<void>;
  load(id: string): Promise<WorkflowCheckpoint | null>;
  list(workflowName: string): Promise<WorkflowCheckpoint[]>;
  delete(id: string): Promise<void>;
}

export interface AddNodeOptions {
  after?: string[];
  config?: NodeConfig;
}

export interface AddConditionalOptions {
  after?: string[];
}

export interface AddLoopOptions {
  condition: (state: unknown) => boolean;
  back: string;
  exit: string;
  after?: string[];
}

export interface AddParallelOptions {
  after?: string[];
}

export type ApprovalType = 'approve-reject' | 'multi-choice' | 'free-form' | 'numeric-rating';

export interface ApprovalChoice {
  id: string;
  label: string;
  value: unknown;
  description?: string;
}

export interface ApprovalRequest {
  id: string;
  workflowId: string;
  runId: string;
  nodeId: string;
  type: ApprovalType;
  title: string;
  description?: string;
  choices?: ApprovalChoice[];
  assignee?: string;
  assigneeGroup?: string[];
  deadline?: number;
  timeout?: number;
  timeoutAction?: 'approve' | 'reject' | 'escalate' | 'fail';
  escalateTo?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export interface ApprovalResponse {
  requestId: string;
  decision: unknown;
  respondedBy: string;
  respondedAt: number;
  comment?: string;
  delegatedTo?: string;
  delegationReason?: string;
}

export interface ApprovalChainStep {
  assignee: string;
  role?: string;
  required: boolean;
  timeout?: number;
  timeoutAction?: 'approve' | 'reject' | 'escalate' | 'skip';
}

export interface HumanNodeConfig<S = WorkflowState> extends NodeConfig {
  approval: {
    type: ApprovalType;
    title: string;
    description?: string | ((state: S) => string);
    choices?: ApprovalChoice[];
    assignee?: string | ((state: S) => string);
    assigneeGroup?: string[] | ((state: S) => string[]);
    chain?: ApprovalChainStep[];
    timeout?: number;
    timeoutAction?: 'approve' | 'reject' | 'escalate' | 'fail';
    escalateTo?: string;
    priority?: 'low' | 'normal' | 'high' | 'urgent';
  };
}

export interface ApprovalStore {
  createRequest(request: ApprovalRequest): Promise<void>;
  getRequest(id: string): Promise<ApprovalRequest | null>;
  getPendingRequests(workflowId?: string): Promise<ApprovalRequest[]>;
  getPendingForAssignee(assignee: string): Promise<ApprovalRequest[]>;
  submitResponse(response: ApprovalResponse): Promise<void>;
  getResponse(requestId: string): Promise<ApprovalResponse | null>;
  deleteRequest(id: string): Promise<void>;
  onResponse(requestId: string, callback: (response: ApprovalResponse) => void): () => void;
}

export interface ApprovalNotifier {
  notify(request: ApprovalRequest): Promise<void>;
  notifyEscalation(request: ApprovalRequest, reason: string): Promise<void>;
  notifyTimeout(request: ApprovalRequest): Promise<void>;
  notifyDelegation(request: ApprovalRequest, from: string, to: string): Promise<void>;
}

export type BackoffStrategy = 'constant' | 'linear' | 'exponential';

export interface RetryConfig {
  maxRetries: number;
  backoff?: BackoffStrategy;
  initialDelay?: number;
  maxDelay?: number;
  multiplier?: number;
  jitter?: number;
  isRetryable?: (error: Error) => boolean;
}

export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  enabled?: boolean;
  threshold: number;
  resetTimeout: number;
  successThreshold?: number;
  halfOpenMax?: number;
  onStateChange?: (from: CircuitBreakerState, to: CircuitBreakerState, nodeId: string) => void;
}

export interface CircuitBreakerStatus {
  state: CircuitBreakerState;
  failures: number;
  successes: number;
  lastFailure?: number;
  lastSuccess?: number;
  nextAttempt?: number;
}

export type CompensationOrder = 'reverse' | 'forward' | 'parallel';

export interface CompensationConfig<S = WorkflowState> {
  compensate?: (state: S, originalResult: unknown) => Promise<void>;
  compensateCondition?: (state: S, error: Error) => boolean;
  compensateOrder?: CompensationOrder;
  compensateTimeout?: number;
}

export interface SagaNodeConfig extends NodeConfig {
  retry?: RetryConfig;
  circuitBreaker?: CircuitBreakerConfig;
  compensation?: CompensationConfig;
  idempotencyKey?: string | ((state: unknown) => string);
}

export interface DeadLetterEntry {
  id: string;
  workflowId: string;
  workflowName: string;
  nodeId: string;
  error: {
    message: string;
    name: string;
    stack?: string;
  };
  state: WorkflowState;
  input?: unknown;
  attempts: number;
  maxAttempts: number;
  lastAttempt: number;
  createdAt: number;
  expiresAt?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface DeadLetterQueue {
  add(entry: DeadLetterEntry): Promise<string>;
  get(id: string): Promise<DeadLetterEntry | null>;
  list(filters?: {
    workflowId?: string;
    nodeId?: string;
    limit?: number;
  }): Promise<DeadLetterEntry[]>;
  retry(id: string): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  count(filters?: { workflowId?: string; nodeId?: string }): Promise<number>;
  clear(): Promise<void>;
}

export interface IdempotencyRecord {
  key: string;
  result?: unknown;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  status: 'completed' | 'failed';
  createdAt: number;
  expiresAt?: number;
}

export interface IdempotencyStore {
  check(key: string): Promise<{ isDuplicate: boolean; record?: IdempotencyRecord }>;
  store(key: string, result: unknown, error?: Error): Promise<void>;
  get(key: string): Promise<IdempotencyRecord | null>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;
}

export interface MapNodeConfig<S = WorkflowState, T = unknown> extends NodeConfig {
  items: (state: S) => T[];
  concurrency?: number;
  continueOnError?: boolean;
  onProgress?: (completed: number, total: number, item: T) => void;
  onItemComplete?: (item: T, result: unknown, index: number) => void;
  onItemError?: (item: T, error: Error, index: number) => void;
}

export interface ReduceNodeConfig<S = WorkflowState, T = unknown, R = unknown> extends NodeConfig {
  initial: R | ((state: S) => R);
  reducer: (accumulator: R, result: T, index: number, state: S) => R;
  streaming?: boolean;
  onReduce?: (accumulator: R, result: T, index: number) => void;
}

export interface MapReduceResult<R = unknown> {
  result: R;
  succeeded: number;
  failed: number;
  total: number;
  errors: { index: number; error: Error; item?: unknown }[];
  duration: number;
}

export type TimerType = 'fixed' | 'dynamic' | 'cron' | 'recurring';

export interface TimerConfig {
  type: TimerType;
  delay?: number;
  delayFn?: (state: unknown) => number;
  cron?: string;
  timezone?: string;
  timerId?: string;
  persist?: boolean;
  cancellable?: boolean;
}

export interface TimerEntry {
  id: string;
  workflowId: string;
  runId: string;
  nodeId: string;
  firesAt: number;
  type: TimerType;
  cron?: string;
  timezone?: string;
  cancelled: boolean;
  fired: boolean;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface TimerStore {
  schedule(entry: Omit<TimerEntry, 'id' | 'cancelled' | 'fired' | 'createdAt'>): Promise<string>;
  cancel(id: string): Promise<void>;
  get(id: string): Promise<TimerEntry | null>;
  getByWorkflow(workflowId: string): Promise<TimerEntry[]>;
  getByRun(runId: string): Promise<TimerEntry[]>;
  getPending(): Promise<TimerEntry[]>;
  getOverdue(): Promise<TimerEntry[]>;
  markFired(id: string): Promise<void>;
  cleanup(olderThan: number): Promise<number>;
  onFire(callback: (entry: TimerEntry) => void): () => void;
}

export interface CronSchedule {
  expression: string;
  timezone?: string;
  next(): Date;
  prev(): Date;
  hasNext(): boolean;
  iterate(count: number): Date[];
}

export type SubworkflowErrorStrategy = 'propagate' | 'catch' | 'retry' | 'ignore';

export interface SubworkflowConfig<S = WorkflowState, CS = WorkflowState> extends NodeConfig {
  workflow: Workflow<CS>;
  inputMapper?: (parentState: S, input?: unknown) => Partial<CS>;
  outputMapper?: (childResult: WorkflowResult<CS>, parentState: S) => Partial<S>;
  onError?: SubworkflowErrorStrategy;
  retryConfig?: RetryConfig;
  shareCheckpoints?: boolean;
  maxDepth?: number;
  inheritTraceContext?: boolean;
}

export interface SubworkflowResult<CS = WorkflowState> {
  success: boolean;
  result?: WorkflowResult<CS>;
  error?: Error;
  depth: number;
}

export interface CronTriggerConfig {
  expression: string;
  timezone?: string;
  enabled: boolean;
  runImmediately?: boolean;
  condition?: (context: TriggerContext) => boolean;
  input?: Record<string, unknown> | ((context: TriggerContext) => Record<string, unknown>);
  maxConcurrent?: number;
  catchUp?: boolean;
}

export interface WebhookAuthConfig {
  type: 'bearer' | 'basic' | 'hmac' | 'api-key' | 'none';
  secret?: string;
  headerName?: string;
  algorithm?: 'sha256' | 'sha512';
}

export interface WebhookRateLimitConfig {
  requests: number;
  window: number;
  burstLimit?: number;
}

export interface WebhookTriggerConfig {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  auth?: WebhookAuthConfig;
  rateLimit?: WebhookRateLimitConfig;
  deduplicationKey?: (payload: unknown) => string;
  deduplicationWindow?: number;
  validatePayload?: (payload: unknown) => boolean;
  transformPayload?: (payload: unknown) => unknown;
  responseTimeout?: number;
}

export interface EventTriggerConfig {
  eventType: string;
  source?: string;
  filter?: (event: unknown) => boolean;
  transform?: (event: unknown) => unknown;
}

export interface TriggerContext {
  triggerId: string;
  triggerType: 'cron' | 'webhook' | 'event' | 'manual';
  timestamp: number;
  payload?: unknown;
  headers?: Record<string, string>;
  metadata?: Record<string, unknown>;
  traceContext?: {
    traceId: string;
    spanId: string;
  };
}

export interface WorkflowTrigger {
  id: string;
  workflowName: string;
  type: 'cron' | 'webhook' | 'event';
  config: CronTriggerConfig | WebhookTriggerConfig | EventTriggerConfig;
  enabled: boolean;
  createdAt: number;
  lastTriggered?: number;
  nextTrigger?: number;
  triggerCount: number;
  errorCount: number;
  lastError?: string;
}

export interface TriggerManager {
  register(
    trigger: Omit<WorkflowTrigger, 'id' | 'createdAt' | 'triggerCount' | 'errorCount'>
  ): Promise<string>;
  unregister(id: string): Promise<void>;
  enable(id: string): Promise<void>;
  disable(id: string): Promise<void>;
  get(id: string): Promise<WorkflowTrigger | null>;
  list(workflowName?: string): Promise<WorkflowTrigger[]>;
  listEnabled(): Promise<WorkflowTrigger[]>;
  fire(id: string, context?: Partial<TriggerContext>): Promise<string>;
  onTrigger(callback: (trigger: WorkflowTrigger, context: TriggerContext) => void): () => void;
}

export type SpanExporter = 'console' | 'otlp' | 'jaeger' | 'zipkin';

export interface TracingConfig {
  enabled: boolean;
  serviceName?: string;
  serviceVersion?: string;
  attributes?: Record<string, unknown>;
  sampleRate?: number;
  propagateContext?: boolean;
  exporter?: SpanExporter;
  exporterEndpoint?: string;
  exporterHeaders?: Record<string, string>;
  batchSize?: number;
  flushInterval?: number;
}

export interface MetricsConfig {
  enabled: boolean;
  prefix?: string;
  labels?: Record<string, string>;
  latencyBuckets?: number[];
  tokenBuckets?: number[];
  costBuckets?: number[];
  pushGateway?: string;
  pushInterval?: number;
}

export type SpanKind = 'internal' | 'client' | 'server' | 'producer' | 'consumer';
export type SpanStatus = 'ok' | 'error' | 'unset';

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes?: Record<string, unknown>;
}

export interface SpanLink {
  traceId: string;
  spanId: string;
  attributes?: Record<string, unknown>;
}

export interface WorkflowSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTime: number;
  endTime?: number;
  attributes: Record<string, unknown>;
  events: SpanEvent[];
  links: SpanLink[];
  status: SpanStatus;
  statusMessage?: string;
}

export interface NodeMetrics {
  executionCount: number;
  successCount: number;
  failureCount: number;
  retryCount: number;
  avgDuration: number;
  p50Duration: number;
  p95Duration: number;
  p99Duration: number;
  minDuration: number;
  maxDuration: number;
}

export interface WorkflowMetrics {
  workflowName: string;
  executionCount: number;
  successCount: number;
  failureCount: number;
  cancelledCount: number;
  latency: {
    avg: number;
    p50: number;
    p90: number;
    p99: number;
    min: number;
    max: number;
  };
  nodeMetrics: Map<string, NodeMetrics>;
  tokenUsage: {
    input: number;
    output: number;
    total: number;
  };
  totalCost: number;
  lastUpdated: number;
}

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceFlags?: number;
  traceState?: string;
}

export type Baggage = Record<string, string>;

export interface ScheduleOptions {
  at?: number;
  cron?: string;
  timezone?: string;
  input?: Partial<WorkflowState>;
  priority?: number;
  tags?: string[];
  triggerId?: string;
  traceContext?: TraceContext;
  baggage?: Baggage;
  timeout?: number;
  maxRetries?: number;
}

export type WorkflowRunStatus =
  | 'pending'
  | 'scheduled'
  | 'running'
  | 'paused'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout';

export interface WorkflowRun {
  id: string;
  workflowName: string;
  status: WorkflowRunStatus;
  state: WorkflowState;
  input?: unknown;
  output?: unknown;
  currentNodes: string[];
  completedNodes: string[];
  failedNodes: string[];
  startedAt?: number;
  completedAt?: number;
  scheduledFor?: number;
  pausedAt?: number;
  priority: number;
  tags: string[];
  error?: {
    message: string;
    name: string;
    stack?: string;
    nodeId?: string;
  };
  checkpointId?: string;
  triggerId?: string;
  parentRunId?: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowRunFilters {
  status?: WorkflowRunStatus | WorkflowRunStatus[];
  workflowName?: string;
  tags?: string[];
  triggerId?: string;
  parentRunId?: string;
  startedAfter?: number;
  startedBefore?: number;
  completedAfter?: number;
  completedBefore?: number;
  hasError?: boolean;
  limit?: number;
  offset?: number;
  orderBy?: 'startedAt' | 'completedAt' | 'priority';
  orderDirection?: 'asc' | 'desc';
}

export interface WorkflowRunStats {
  total: number;
  byStatus: Record<WorkflowRunStatus, number>;
  avgDuration: number;
  successRate: number;
  failureRate: number;
}

export interface WorkflowManager {
  schedule<S extends WorkflowState>(
    workflow: Workflow<S>,
    options?: ScheduleOptions
  ): Promise<string>;

  execute<S extends WorkflowState>(
    workflow: Workflow<S>,
    input?: Partial<S>,
    options?: WorkflowExecuteOptionsV2
  ): Promise<WorkflowResult<S>>;

  cancel(runId: string, reason?: string): Promise<void>;

  getStatus(runId: string): Promise<WorkflowRun | null>;

  listRuns(filters?: WorkflowRunFilters): Promise<WorkflowRun[]>;

  getStats(workflowName?: string): Promise<WorkflowRunStats>;

  pause(runId: string): Promise<void>;

  resume(runId: string): Promise<void>;

  retry(runId: string): Promise<string>;

  replay<S extends WorkflowState>(
    workflow: Workflow<S>,
    runId: string,
    fromNode: string
  ): Promise<WorkflowResult<S>>;

  getActiveCount(): Promise<number>;

  onRunStateChange(callback: (run: WorkflowRun) => void): () => void;

  cleanup(olderThan: number): Promise<number>;
}

export interface RunStore {
  save(run: WorkflowRun): Promise<void>;
  get(id: string): Promise<WorkflowRun | null>;
  list(filters?: WorkflowRunFilters): Promise<WorkflowRun[]>;
  count(filters?: WorkflowRunFilters): Promise<number>;
  update(id: string, updates: Partial<WorkflowRun>): Promise<void>;
  delete(id: string): Promise<void>;
  getStats(workflowName?: string): Promise<WorkflowRunStats>;
  cleanup(olderThan: number): Promise<number>;
}

export interface WorkflowExecuteOptionsV2 extends WorkflowExecuteOptions {
  approvalStore?: ApprovalStore;
  approvalNotifier?: ApprovalNotifier;

  deadLetterQueue?: DeadLetterQueue;
  idempotencyStore?: IdempotencyStore;
  defaultRetry?: RetryConfig;
  defaultCircuitBreaker?: CircuitBreakerConfig;

  timerStore?: TimerStore;

  tracing?: TracingConfig;
  metrics?: MetricsConfig;
  parentTraceContext?: TraceContext;
  baggage?: Baggage;

  priority?: number;
  tags?: string[];
  triggerId?: string;
  parentRunId?: string;

  parentWorkflowId?: string;
  parentNodeId?: string;
  depth?: number;
  metadata?: Record<string, unknown>;

  onApprovalRequired?: (request: ApprovalRequest) => void;
  onCompensationStart?: (nodeId: string) => void;
  onCompensationComplete?: (nodeId: string) => void;
  onTimerScheduled?: (entry: TimerEntry) => void;
  onDeadLetter?: (entry: DeadLetterEntry) => void;
}
