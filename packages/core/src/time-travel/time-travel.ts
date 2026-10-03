import type {
  ExecutionCheckpoint,
  ReplayOptions,
  ReplayResult,
  ForkOptions,
  ForkResult,
  TraceDiff,
  TraceStore,
  TimeTravelCheckpointStore,
  RunResult,
  TimeTravelConfig,
} from '@cogitator-ai/types';
import { DEFAULT_TIME_TRAVEL_CONFIG } from '@cogitator-ai/types';
import type { Agent } from '../agent';
import type { Cogitator } from '../runtime';
import { InMemoryCheckpointStore } from './checkpoint-store';
import { ExecutionReplayer } from './replayer';
import { ExecutionForker } from './forker';
import { TraceComparator } from './comparator';
import { InMemoryTraceStore } from '../learning/trace-store';
import { buildExecutionTrace, runInput } from '../learning/trace-builder';

export interface TimeTravelOptions {
  checkpointStore?: TimeTravelCheckpointStore;
  traceStore?: TraceStore;
  config?: Partial<TimeTravelConfig>;
}

export class TimeTravel {
  private cogitator: Cogitator;
  private checkpointStore: TimeTravelCheckpointStore;
  private traceStore: TraceStore;
  private replayer: ExecutionReplayer;
  private forker: ExecutionForker;
  private comparator: TraceComparator;
  private config: TimeTravelConfig;

  constructor(cogitator: Cogitator, options?: TimeTravelOptions) {
    this.cogitator = cogitator;
    this.config = { ...DEFAULT_TIME_TRAVEL_CONFIG, ...options?.config };

    this.checkpointStore = options?.checkpointStore ?? new InMemoryCheckpointStore();
    this.traceStore = options?.traceStore ?? new InMemoryTraceStore();

    this.replayer = new ExecutionReplayer({
      checkpointStore: this.checkpointStore,
    });

    this.forker = new ExecutionForker({
      checkpointStore: this.checkpointStore,
      replayer: this.replayer,
    });

    this.comparator = new TraceComparator({
      traceStore: this.traceStore,
    });
  }

  async checkpoint(
    result: RunResult,
    stepIndex: number,
    label?: string
  ): Promise<ExecutionCheckpoint> {
    const checkpoint = this.checkpointStore.createFromRunResult(result, stepIndex, { label });
    await this.checkpointStore.save(checkpoint);
    await this.recordTrace(result);
    await this.pruneCheckpoints(result);
    return checkpoint;
  }

  async checkpointAll(result: RunResult, labelPrefix?: string): Promise<ExecutionCheckpoint[]> {
    await this.recordTrace(result);
    const checkpoints = await this.checkpointStore.createAllFromRunResult(result, { labelPrefix });
    await this.pruneCheckpoints(result);
    return checkpoints;
  }

  async checkpointEvery(
    result: RunResult,
    interval: number,
    labelPrefix?: string
  ): Promise<ExecutionCheckpoint[]> {
    if (!Number.isInteger(interval) || interval <= 0) {
      throw new Error('Checkpoint interval must be a positive integer');
    }

    await this.recordTrace(result);
    const stepCount = this.countSteps(result);
    const checkpoints: ExecutionCheckpoint[] = [];

    for (let i = 0; i < stepCount; i += interval) {
      const checkpoint = this.checkpointStore.createFromRunResult(result, i, {
        label: labelPrefix ? `${labelPrefix}_step_${i}` : undefined,
      });
      await this.checkpointStore.save(checkpoint);
      checkpoints.push(checkpoint);
    }

    await this.pruneCheckpoints(result);
    return checkpoints;
  }

  async getCheckpoints(traceId: string): Promise<ExecutionCheckpoint[]> {
    return this.checkpointStore.getByTrace(traceId);
  }

  async getCheckpoint(checkpointId: string): Promise<ExecutionCheckpoint | null> {
    return this.checkpointStore.load(checkpointId);
  }

  async deleteCheckpoint(checkpointId: string): Promise<boolean> {
    return this.checkpointStore.delete(checkpointId);
  }

  async replay(
    agent: Agent,
    checkpointId: string,
    options?: Partial<ReplayOptions>
  ): Promise<ReplayResult> {
    const result = await this.replayer.replay(this.cogitator, agent, {
      fromCheckpoint: checkpointId,
      mode: options?.mode ?? 'live',
      ...options,
    });
    if (options?.mode === 'deterministic') {
      await this.recordDeterministicTrace(result);
    } else {
      await this.recordTrace(result, true);
    }
    return result;
  }

  async replayDeterministic(agent: Agent, checkpointId: string): Promise<ReplayResult> {
    return this.replay(agent, checkpointId, { mode: 'deterministic' });
  }

  async replayLive(
    agent: Agent,
    checkpointId: string,
    options?: Omit<Partial<ReplayOptions>, 'mode'>
  ): Promise<ReplayResult> {
    return this.replay(agent, checkpointId, { mode: 'live', ...options });
  }

  async fork(
    agent: Agent,
    checkpointId: string,
    options?: Partial<ForkOptions>
  ): Promise<ForkResult> {
    return this.recordFork(
      await this.forker.fork(this.cogitator, agent, {
        checkpointId,
        ...options,
      })
    );
  }

  async forkWithContext(
    agent: Agent,
    checkpointId: string,
    additionalContext: string,
    label?: string
  ): Promise<ForkResult> {
    return this.recordFork(
      await this.forker.forkWithContext(
        this.cogitator,
        agent,
        checkpointId,
        additionalContext,
        label
      )
    );
  }

  async forkWithMockedTool(
    agent: Agent,
    checkpointId: string,
    toolName: string,
    mockResult: unknown,
    label?: string
  ): Promise<ForkResult> {
    return this.recordFork(
      await this.forker.forkWithMockedTools(
        this.cogitator,
        agent,
        checkpointId,
        { [toolName]: mockResult },
        label
      )
    );
  }

  async forkWithMockedTools(
    agent: Agent,
    checkpointId: string,
    mockResults: Record<string, unknown>,
    label?: string
  ): Promise<ForkResult> {
    return this.recordFork(
      await this.forker.forkWithMockedTools(this.cogitator, agent, checkpointId, mockResults, label)
    );
  }

  async forkWithNewInput(
    agent: Agent,
    checkpointId: string,
    newInput: string,
    label?: string
  ): Promise<ForkResult> {
    return this.recordFork(
      await this.forker.forkWithNewInput(this.cogitator, agent, checkpointId, newInput, label)
    );
  }

  async forkMultiple(
    agent: Agent,
    checkpointId: string,
    variants: Array<Partial<ForkOptions>>
  ): Promise<ForkResult[]> {
    const forks = await this.forker.forkMultiple(this.cogitator, agent, checkpointId, variants);
    for (const fork of forks) await this.recordFork(fork);
    return forks;
  }

  async compare(traceId1: string, traceId2: string): Promise<TraceDiff> {
    return this.comparator.compare(traceId1, traceId2);
  }

  async compareWithOriginal(replayResult: ReplayResult): Promise<TraceDiff> {
    return this.comparator.compare(replayResult.originalTraceId, replayResult.trace.traceId);
  }

  formatDiff(diff: TraceDiff): string {
    return this.comparator.formatDiff(diff);
  }

  getCheckpointStore(): TimeTravelCheckpointStore {
    return this.checkpointStore;
  }

  getTraceStore(): TraceStore {
    return this.traceStore;
  }

  getConfig(): TimeTravelConfig {
    return { ...this.config };
  }

  /**
   * Stores a run's trace under its trace id, so `compare()` can read it. The
   * trace of an original run is stored once; a replay's is always new.
   */
  private async recordTrace(result: RunResult, replay = false): Promise<void> {
    const id = result.trace.traceId;
    if (!replay && (await this.traceStore.get(id))) return;
    await this.traceStore.store(buildExecutionTrace(result, runInput(result), { id }));
  }

  /**
   * A deterministic replay runs no model or tool calls, so its trace is the
   * original's up to the replayed step, ending in the replayed output.
   */
  private async recordDeterministicTrace(result: ReplayResult): Promise<void> {
    const original = await this.traceStore.get(result.originalTraceId);
    if (!original) {
      await this.recordTrace(result, true);
      return;
    }
    await this.traceStore.store({
      ...original,
      id: result.trace.traceId,
      runId: result.runId,
      output: result.output,
      steps: original.steps.slice(0, result.stepsReplayed),
      createdAt: new Date(),
      isDemo: false,
    });
  }

  /** Deletes expired checkpoints of the run's agent and the oldest beyond the per-trace cap. */
  private async pruneCheckpoints(result: RunResult): Promise<void> {
    const { maxCheckpointsPerTrace, checkpointRetention } = this.config;

    if (checkpointRetention !== undefined && checkpointRetention > 0) {
      const expiredBefore = Date.now() - checkpointRetention;
      for (const checkpoint of await this.checkpointStore.getByAgent(result.agentId)) {
        if (checkpoint.createdAt.getTime() < expiredBefore) {
          await this.checkpointStore.delete(checkpoint.id);
        }
      }
    }

    if (maxCheckpointsPerTrace !== undefined && maxCheckpointsPerTrace > 0) {
      const forTrace = (await this.checkpointStore.getByTrace(result.trace.traceId)).sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
      );
      for (const checkpoint of forTrace.slice(0, forTrace.length - maxCheckpointsPerTrace)) {
        await this.checkpointStore.delete(checkpoint.id);
      }
    }
  }

  private async recordFork(fork: ForkResult): Promise<ForkResult> {
    await this.recordTrace(fork.result, true);
    return fork;
  }

  private countSteps(result: RunResult): number {
    let count = 0;
    for (const span of result.trace.spans) {
      if (
        span.name.startsWith('tool.') ||
        span.name.includes('llm') ||
        span.name.includes('chat')
      ) {
        count++;
      }
    }
    return count;
  }
}
