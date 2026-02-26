import type { Message, ToolCall } from './message';
import type { ExecutionTrace, TraceQuery, TraceStoreStats } from './learning';
import type { ToolSchema } from './tool';

export type ABTestVariant = 'control' | 'treatment';
export type ABTestStatus = 'draft' | 'running' | 'paused' | 'completed' | 'cancelled';
export type InstructionSource = 'manual' | 'optimization' | 'ab_test' | 'rollback';
export type AlertType = 'score_drop' | 'latency_spike' | 'error_rate_increase' | 'cost_spike';
export type AlertSeverity = 'warning' | 'critical';
export type AlertAction = 'rollback' | 'pause_optimization' | 'alert_only';

export interface CapturedPrompt {
  id: string;
  runId: string;
  agentId: string;
  threadId: string;
  model: string;
  provider: string;
  timestamp: Date;

  systemPrompt: string;
  messages: Message[];
  tools?: ToolSchema[];
  injectedDemos?: string;
  injectedInsights?: string;

  temperature?: number;
  topP?: number;
  maxTokens?: number;

  promptTokens: number;

  response?: {
    content: string;
    toolCalls?: ToolCall[];
    completionTokens: number;
    finishReason: string;
    latencyMs: number;
  };

  metadata?: Record<string, unknown>;
}

export interface PromptQuery {
  agentId?: string;
  model?: string;
  fromDate?: Date;
  toDate?: Date;
  hasError?: boolean;
  minLatency?: number;
  maxLatency?: number;
  limit?: number;
  offset?: number;
}

export interface ABTestResults {
  sampleSize: number;
  successRate: number;
  avgScore: number;
  avgLatency: number;
  totalCost: number;
  scores: number[];
}

export interface ABTest {
  id: string;
  agentId: string;
  name: string;
  description?: string;
  status: ABTestStatus;

  controlInstructions: string;
  treatmentInstructions: string;
  treatmentAllocation: number;

  minSampleSize: number;
  maxDuration: number;
  confidenceLevel: number;
  metricToOptimize: string;

  controlResults: ABTestResults;
  treatmentResults: ABTestResults;

  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export interface ABTestOutcome {
  winner: ABTestVariant | null;
  pValue: number;
  confidenceInterval: [number, number];
  effectSize: number;
  isSignificant: boolean;
  recommendation: string;
}

export interface InstructionVersionMetrics {
  runCount: number;
  avgScore: number;
  successRate: number;
  avgLatency: number;
  totalCost: number;
}

export interface InstructionVersion {
  id: string;
  agentId: string;
  version: number;
  instructions: string;

  source: InstructionSource;
  sourceId?: string;

  deployedAt: Date;
  retiredAt?: Date;

  metrics: InstructionVersionMetrics;

  parentVersionId?: string;
}

export interface PromptPerformanceMetrics {
  agentId: string;
  windowStart: Date;
  windowEnd: Date;

  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;

  avgScore: number;
  minScore: number;
  maxScore: number;
  scoreP50: number;
  scoreP95: number;

  avgLatency: number;
  p50Latency: number;
  p95Latency: number;
  p99Latency: number;

  totalCost: number;
  avgCostPerRun: number;

  avgInputTokens: number;
  avgOutputTokens: number;
}

export interface DegradationAlert {
  id: string;
  agentId: string;
  type: AlertType;
  severity: AlertSeverity;

  currentValue: number;
  baselineValue: number;
  threshold: number;
  percentChange: number;

  detectedAt: Date;
  resolvedAt?: Date;

  autoAction?: AlertAction;
  actionTaken?: boolean;
}

export interface PromptStore {
  capture(prompt: CapturedPrompt): Promise<void>;
  get(id: string): Promise<CapturedPrompt | null>;
  getByRun(runId: string): Promise<CapturedPrompt[]>;
  query(query: PromptQuery): Promise<CapturedPrompt[]>;
  delete(id: string): Promise<boolean>;
  prune(beforeDate: Date): Promise<number>;
}

export interface ABTestStore {
  create(test: Omit<ABTest, 'id' | 'createdAt'>): Promise<ABTest>;
  get(id: string): Promise<ABTest | null>;
  getActive(agentId: string): Promise<ABTest | null>;
  update(id: string, updates: Partial<ABTest>): Promise<ABTest>;
  recordResult(
    testId: string,
    variant: ABTestVariant,
    score: number,
    latency: number,
    cost: number
  ): Promise<void>;
  list(agentId?: string, status?: ABTestStatus): Promise<ABTest[]>;
  delete(id: string): Promise<boolean>;
}

export interface InstructionVersionStore {
  save(version: Omit<InstructionVersion, 'id'>): Promise<InstructionVersion>;
  get(id: string): Promise<InstructionVersion | null>;
  getCurrent(agentId: string): Promise<InstructionVersion | null>;
  getHistory(agentId: string, limit?: number): Promise<InstructionVersion[]>;
  retire(id: string): Promise<void>;
  updateMetrics(id: string, metrics: Partial<InstructionVersionMetrics>): Promise<void>;
}

export type OptimizationRunStatus =
  | 'pending'
  | 'optimizing'
  | 'testing'
  | 'deploying'
  | 'completed'
  | 'failed'
  | 'rolled_back';

export interface OptimizationRun {
  id: string;
  agentId: string;
  status: OptimizationRunStatus;

  optimizationResultId?: string;

  abTestId?: string;
  abTestOutcome?: ABTestOutcome;

  deployedVersionId?: string;

  startedAt: Date;
  completedAt?: Date;

  error?: string;
}

export interface ABTestingConfig {
  defaultConfidenceLevel?: number;
  defaultMinSampleSize?: number;
  defaultMaxDuration?: number;
  autoDeployWinner?: boolean;
}

export interface MonitoringConfig {
  windowSize?: number;
  scoreDropThreshold?: number;
  latencySpikeThreshold?: number;
  errorRateThreshold?: number;
  enableAutoRollback?: boolean;
  rollbackCooldown?: number;
}

export interface AutoOptimizationConfig {
  enabled?: boolean;
  triggerAfterRuns?: number;
  minRunsForOptimization?: number;
  requireABTest?: boolean;
  maxOptimizationsPerDay?: number;
}

export interface PromptOptimizationConfig {
  enabled: boolean;

  capturePrompts?: boolean;
  promptRetentionDays?: number;

  abTesting?: ABTestingConfig;

  monitoring?: MonitoringConfig;

  autoOptimization?: AutoOptimizationConfig;
}

export const DEFAULT_PROMPT_OPTIMIZATION_CONFIG: PromptOptimizationConfig = {
  enabled: false,
  capturePrompts: true,
  promptRetentionDays: 30,
  abTesting: {
    defaultConfidenceLevel: 0.95,
    defaultMinSampleSize: 50,
    defaultMaxDuration: 7 * 24 * 60 * 60 * 1000,
    autoDeployWinner: false,
  },
  monitoring: {
    windowSize: 60 * 60 * 1000,
    scoreDropThreshold: 0.15,
    latencySpikeThreshold: 2.0,
    errorRateThreshold: 0.1,
    enableAutoRollback: false,
    rollbackCooldown: 24 * 60 * 60 * 1000,
  },
  autoOptimization: {
    enabled: false,
    triggerAfterRuns: 100,
    minRunsForOptimization: 20,
    requireABTest: true,
    maxOptimizationsPerDay: 3,
  },
};

export interface PersistentTraceStore {
  storeTrace(trace: ExecutionTrace): Promise<void>;
  storeTraceMany(traces: ExecutionTrace[]): Promise<void>;
  getTrace(id: string): Promise<ExecutionTrace | null>;
  getTraceByRunId(runId: string): Promise<ExecutionTrace | null>;
  queryTraces(query: TraceQuery): Promise<ExecutionTrace[]>;
  getAllTraces(agentId: string): Promise<ExecutionTrace[]>;
  getDemos(agentId: string, limit?: number): Promise<ExecutionTrace[]>;
  markAsDemo(id: string): Promise<void>;
  unmarkAsDemo(id: string): Promise<void>;
  deleteTrace(id: string): Promise<boolean>;
  pruneTraces(agentId: string, maxTraces: number): Promise<number>;
  clearTraces(agentId: string): Promise<void>;
  getTraceStats(agentId: string): Promise<TraceStoreStats>;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface CombinedPersistentStore
  extends
    PersistentTraceStore,
    Omit<PromptStore, 'get' | 'delete'>,
    Omit<ABTestStore, 'get' | 'delete'>,
    Omit<InstructionVersionStore, 'get'> {
  getPrompt(id: string): Promise<CapturedPrompt | null>;
  deletePrompt(id: string): Promise<boolean>;
  getABTest(id: string): Promise<ABTest | null>;
  deleteABTest(id: string): Promise<boolean>;
  getVersion(id: string): Promise<InstructionVersion | null>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}
