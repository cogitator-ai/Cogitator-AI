/**
 * Agent Learning types for DSPy-inspired optimization
 *
 * Enables agents to:
 * - Capture execution traces as training data
 * - Score traces with configurable metrics
 * - Bootstrap few-shot demos from successful runs
 * - Optimize instructions based on failure patterns
 */

import type { ToolCall, ToolResult } from './message';
import type { Reflection, InsightStore } from './reflection';

export type ExecutionStepType = 'llm_call' | 'tool_call' | 'reflection';
export type BuiltinMetric =
  | 'success'
  | 'tool_accuracy'
  | 'efficiency'
  | 'completeness'
  | 'coherence';

export interface ExecutionStep {
  index: number;
  type: ExecutionStepType;
  timestamp: number;
  duration: number;
  messages?: Array<{ role: string; content: string }>;
  response?: string;
  tokensUsed?: { input: number; output: number };
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  reflection?: Reflection;
}

export interface TraceMetrics {
  success: boolean;
  toolAccuracy: number;
  efficiency: number;
  completeness: number;
  coherence: number;
  custom?: Record<string, number>;
}

export interface ExecutionTrace {
  id: string;
  runId: string;
  agentId: string;
  threadId: string;
  input: string;
  output: string;
  context?: Record<string, unknown>;
  steps: ExecutionStep[];
  toolCalls: ToolCall[];
  reflections: Reflection[];
  metrics: TraceMetrics;
  score: number;
  model: string;
  createdAt: Date;
  duration: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cost: number;
  };
  labels?: string[];
  isDemo: boolean;
  expected?: unknown;
}

export interface TraceQuery {
  agentId?: string;
  minScore?: number;
  isDemo?: boolean;
  labels?: string[];
  limit?: number;
  fromDate?: Date;
  toDate?: Date;
}

export interface TraceStoreStats {
  totalTraces: number;
  demoCount: number;
  averageScore: number;
  scoreDistribution: Array<{ bucket: string; count: number }>;
  topPerformers: string[];
}

export interface TraceStore {
  store(trace: ExecutionTrace): Promise<void>;
  storeMany(traces: ExecutionTrace[]): Promise<void>;
  get(id: string): Promise<ExecutionTrace | null>;
  getByRunId(runId: string): Promise<ExecutionTrace | null>;
  query(query: TraceQuery): Promise<ExecutionTrace[]>;
  getAll(agentId: string): Promise<ExecutionTrace[]>;
  getDemos(agentId: string, limit?: number): Promise<ExecutionTrace[]>;
  markAsDemo(id: string): Promise<void>;
  unmarkAsDemo(id: string): Promise<void>;
  delete(id: string): Promise<boolean>;
  prune(agentId: string, maxTraces: number): Promise<number>;
  clear(agentId: string): Promise<void>;
  getStats(agentId: string): Promise<TraceStoreStats>;
}

export interface MetricResult {
  name: string;
  value: number;
  passed: boolean;
  reasoning?: string;
}

export type MetricFn = (
  trace: ExecutionTrace,
  expected?: unknown
) => MetricResult | Promise<MetricResult>;

export interface MetricDefinition {
  name: string;
  type: 'boolean' | 'numeric' | 'composite';
  description: string;
  weight?: number;
  threshold?: number;
}

export interface MetricEvaluatorConfig {
  metrics: MetricDefinition[];
  aggregation: 'weighted-average' | 'min' | 'product';
  passThreshold: number;
}

export interface DemoStep {
  description: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  reasoning?: string;
}

export interface Demo {
  id: string;
  agentId: string;
  traceId: string;
  input: string;
  output: string;
  reasoning?: string;
  keySteps: DemoStep[];
  score: number;
  metrics: TraceMetrics;
  usageCount: number;
  lastUsedAt: Date;
  createdAt: Date;
  labels?: string[];
  context?: string;
}

export interface DemoStats {
  totalDemos: number;
  averageScore: number;
  usageDistribution: Array<{ demoId: string; count: number }>;
  coverageGaps: string[];
}

export interface InstructionGap {
  description: string;
  frequency: number;
  exampleTraces: string[];
  suggestedFix: string;
}

export interface InstructionOptimizationResult {
  originalInstructions: string;
  optimizedInstructions: string;
  improvement: number;
  gapsAddressed: InstructionGap[];
  candidatesEvaluated: number;
  reasoning: string;
}

export interface OptimizerConfig {
  type: 'bootstrap-few-shot' | 'instruction' | 'full';
  maxBootstrappedDemos?: number;
  maxLabeledDemos?: number;
  maxRounds?: number;
  instructionCandidates?: number;
  instructionRefinementRounds?: number;
  metric?: MetricFn | BuiltinMetric;
  metricThreshold?: number;
  maxErrors?: number;
  teacherModel?: string;
}

export interface OptimizationResult {
  success: boolean;
  instructionsBefore?: string;
  instructionsAfter?: string;
  instructionDiff?: string;
  demosAdded: Demo[];
  demosRemoved: Demo[];
  scoreBefore: number;
  scoreAfter: number;
  improvement: number;
  tracesEvaluated: number;
  bootstrapRounds: number;
  duration: number;
  tokensUsed: number;
  errors: string[];
}

export interface LearningConfig {
  enabled: boolean;
  captureTraces?: boolean;
  traceRetention?: number;
  autoOptimize?: boolean;
  optimizeAfterRuns?: number;
  maxDemosPerAgent?: number;
  minScoreForDemo?: number;
  defaultMetrics?: BuiltinMetric[];
  customMetrics?: MetricDefinition[];
  traceStore?: 'memory' | 'file';
}

export interface LearningRunOptions {
  expected?: unknown;
  labels?: string[];
  skipCapture?: boolean;
  injectDemos?: boolean;
  demoCount?: number;
}

export interface LearningRunResult {
  trace?: ExecutionTrace;
  metrics?: MetricResult[];
  demosUsed?: Demo[];
}

export interface AgentOptimizerOptions {
  traceStore: TraceStore;
  insightStore?: InsightStore;
  config: OptimizerConfig;
}

export interface CompileOptions {
  maxBootstrappedDemos?: number;
  maxRounds?: number;
  optimizeInstructions?: boolean;
  teacherModel?: string;
  verbose?: boolean;
}

export interface LearningStats {
  traces: TraceStoreStats;
  demos: DemoStats;
  optimization: {
    lastRun?: Date;
    runsOptimized: number;
    averageImprovement: number;
  };
}

export const DEFAULT_LEARNING_CONFIG: LearningConfig = {
  enabled: false,
  captureTraces: true,
  autoOptimize: false,
  maxDemosPerAgent: 5,
  minScoreForDemo: 0.8,
  defaultMetrics: ['success', 'tool_accuracy', 'efficiency'],
};

export const DEFAULT_OPTIMIZER_CONFIG: OptimizerConfig = {
  type: 'full',
  maxBootstrappedDemos: 5,
  maxRounds: 3,
  instructionCandidates: 3,
  instructionRefinementRounds: 2,
  metricThreshold: 0.7,
  maxErrors: 5,
};
