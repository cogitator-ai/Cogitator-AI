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
  ExecutionStep,
  ExecutionTrace,
} from '@cogitator-ai/types';
import { DEFAULT_TIME_TRAVEL_CONFIG } from '@cogitator-ai/types';
import type { Agent } from '../agent';
import type { Cogitator } from '../runtime';
import { InMemoryCheckpointStore, countToolCallSteps } from './checkpoint-store';
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
    const stepCount = countToolCallSteps(result);
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

  /**
   * The checkpoints of a run, by its run id. A trace id works too: it gives the checkpoints of
   * every run of that trace.
   */
  async getCheckpoints(id: string): Promise<ExecutionCheckpoint[]> {
    const ofRun = await this.checkpointStore.list({ runId: id });
    return ofRun.length > 0 ? ofRun : this.checkpointStore.getByTrace(id);
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

  /**
   * Compares two recorded runs, each named by its run id, or by its trace id when that trace
   * holds one recorded run.
   */
  async compare(id1: string, id2: string): Promise<TraceDiff> {
    return this.comparator.compare(await this.resolveRun(id1), await this.resolveRun(id2));
  }

  async compareWithOriginal(replayResult: ReplayResult): Promise<TraceDiff> {
    const original = await this.originalTrace(replayResult);
    return this.comparator.compare(
      original?.id ?? replayResult.originalRunId,
      await this.resolveRun(replayResult.runId)
    );
  }

  /**
   * The recorded trace of the run a replay started from: stored under its run id, or under its
   * trace id by versions that keyed traces that way.
   */
  private async originalTrace(replay: ReplayResult): Promise<ExecutionTrace | null> {
    return (
      (await this.traceStore.getByRunId(replay.originalRunId)) ??
      (await this.traceStore.get(replay.originalTraceId))
    );
  }

  /**
   * The store id of the run `id` names: a run id as it is, a trace id when exactly one recorded
   * run belongs to it. Runs started inside other runs share their trace, so a trace id can be
   * ambiguous: then the run id is needed.
   */
  private async resolveRun(id: string): Promise<string> {
    if (await this.traceStore.get(id)) return id;
    const byRun = await this.traceStore.getByRunId(id);
    if (byRun) return byRun.id;
    const runs = (await this.traceStore.query({ traceId: id })).filter((run) => run.traceId === id);
    if (runs.length > 1) {
      throw new Error(
        `Trace ${id} holds ${runs.length} recorded runs (${runs.map((run) => run.runId).join(', ')}): pass a run id`
      );
    }
    return runs[0]?.id ?? id;
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
   * Stores a run's trace under its run id, so `compare()` can read it. The trace of an original
   * run is stored once, a replay's is always new.
   */
  private async recordTrace(result: RunResult, replay = false): Promise<void> {
    const id = result.runId;
    if (!replay && (await this.traceStore.get(id))) return;
    await this.traceStore.store(buildExecutionTrace(result, runInput(result), { id }));
  }

  /**
   * A deterministic replay runs no model or tool calls, so its trace is the
   * original's up to the replayed step, ending in the replayed output.
   */
  private async recordDeterministicTrace(result: ReplayResult): Promise<void> {
    const original = await this.originalTrace(result);
    if (!original) {
      await this.recordTrace(result, true);
      return;
    }
    await this.traceStore.store({
      ...original,
      id: result.runId,
      runId: result.runId,
      traceId: result.trace.traceId,
      output: result.output,
      steps: stepsBeforeToolCall(original.steps, result.stepsReplayed),
      createdAt: new Date(),
      isDemo: false,
    });
  }

  /** Deletes expired checkpoints of the run's agent and the oldest of the run beyond the cap. */
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
      const forTrace = (await this.checkpointStore.list({ runId: result.runId })).sort(
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
}

/** The trace steps before its `toolCallIndex`-th tool call: all of them when it has fewer. */
function stepsBeforeToolCall(steps: ExecutionStep[], toolCallIndex: number): ExecutionStep[] {
  let toolCalls = 0;
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].type !== 'tool_call') continue;
    if (toolCalls === toolCallIndex) return steps.slice(0, i);
    toolCalls++;
  }
  return [...steps];
}
