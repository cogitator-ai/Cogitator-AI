/**
 * Time-Travel Debugging types for Cogitator
 *
 * Enables:
 * - Checkpointing execution state at any step
 * - Replaying execution from checkpoints (deterministic or live)
 * - Forking execution with modified context/tool results
 * - Comparing execution traces step by step
 */

import type { Message, ToolCall } from './message';
import type { RunResult } from './runtime';
import type { ExecutionStep, ExecutionTrace } from './learning';

export type ReplayMode = 'deterministic' | 'live';
export type StepDiffStatus = 'identical' | 'similar' | 'different' | 'only_in_1' | 'only_in_2';

export interface ExecutionCheckpoint {
  id: string;
  traceId: string;
  runId: string;
  agentId: string;
  stepIndex: number;

  messages: Message[];
  toolResults: Record<string, unknown>;
  pendingToolCalls: ToolCall[];

  label?: string;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

export interface CheckpointQuery {
  agentId?: string;
  traceId?: string;
  runId?: string;
  label?: string;
  before?: Date;
  after?: Date;
  limit?: number;
}

export interface TimeTravelCheckpointStore {
  save(checkpoint: ExecutionCheckpoint): Promise<void>;
  load(id: string): Promise<ExecutionCheckpoint | null>;
  list(query: CheckpointQuery): Promise<ExecutionCheckpoint[]>;
  delete(id: string): Promise<boolean>;
  getByTrace(traceId: string): Promise<ExecutionCheckpoint[]>;
  getByAgent(agentId: string, limit?: number): Promise<ExecutionCheckpoint[]>;
  getByLabel(label: string): Promise<ExecutionCheckpoint[]>;
  clear(agentId?: string): Promise<void>;
  createFromRunResult(
    result: RunResult,
    stepIndex: number,
    options?: { label?: string; metadata?: Record<string, unknown> }
  ): ExecutionCheckpoint;
  createAllFromRunResult(
    result: RunResult,
    options?: { labelPrefix?: string }
  ): Promise<ExecutionCheckpoint[]>;
  createFromTrace(
    trace: ExecutionTrace,
    stepIndex: number,
    options?: { label?: string; metadata?: Record<string, unknown> }
  ): ExecutionCheckpoint;
}

export interface ReplayOptions {
  fromCheckpoint: string;
  mode: ReplayMode;

  modifiedMessages?: Message[];
  modifiedToolResults?: Record<string, unknown>;
  skipTools?: string[];

  onStep?: (step: ExecutionStep, index: number) => void;
  pauseAt?: number;
}

export interface ReplayResult extends RunResult {
  replayedFrom: string;
  originalTraceId: string;
  divergedAt?: number;
  stepsReplayed: number;
  stepsExecuted: number;
}

export interface ForkOptions {
  checkpointId: string;
  input?: string;
  additionalContext?: string;
  mockToolResults?: Record<string, unknown>;
  label?: string;
}

export interface ForkResult {
  forkId: string;
  checkpoint: ExecutionCheckpoint;
  result: ReplayResult;
}

export interface StepDiff {
  index: number;
  status: StepDiffStatus;
  step1?: ExecutionStep;
  step2?: ExecutionStep;
  differences?: string[];
}

export interface TraceDiff {
  trace1Id: string;
  trace2Id: string;
  stepDiffs: StepDiff[];
  commonSteps: number;
  divergencePoint?: number;
  trace1OnlySteps: number;
  trace2OnlySteps: number;
  metricsDiff: {
    success: { trace1: boolean; trace2: boolean };
    score: { trace1: number; trace2: number; delta: number };
    tokens: { trace1: number; trace2: number; delta: number };
    duration: { trace1: number; trace2: number; delta: number };
  };
}

export interface TimeTravelConfig {
  autoCheckpoint?: boolean;
  autoCheckpointInterval?: number;
  maxCheckpointsPerTrace?: number;
  checkpointRetention?: number;
}

export const DEFAULT_TIME_TRAVEL_CONFIG: TimeTravelConfig = {
  autoCheckpoint: false,
  autoCheckpointInterval: 1,
  maxCheckpointsPerTrace: 50,
  checkpointRetention: 24 * 60 * 60 * 1000,
};
