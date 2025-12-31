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
import type { Cogitator } from '../cogitator';
import { InMemoryCheckpointStore } from './checkpoint-store';
import { ExecutionReplayer } from './replayer';
import { ExecutionForker } from './forker';
import { TraceComparator } from './comparator';
import { InMemoryTraceStore } from '../learning/trace-store';

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
    const store = this.checkpointStore as InMemoryCheckpointStore;
    const checkpoint = store.createFromRunResult(result, stepIndex, { label });
    await store.save(checkpoint);
    return checkpoint;
  }

  async checkpointAll(result: RunResult, labelPrefix?: string): Promise<ExecutionCheckpoint[]> {
    const store = this.checkpointStore as InMemoryCheckpointStore;
    return store.createAllFromRunResult(result, { labelPrefix });
  }

  async checkpointEvery(
    result: RunResult,
    interval: number,
    labelPrefix?: string
  ): Promise<ExecutionCheckpoint[]> {
    const store = this.checkpointStore as InMemoryCheckpointStore;
    const stepCount = this.countSteps(result);
    const checkpoints: ExecutionCheckpoint[] = [];

    for (let i = 0; i < stepCount; i += interval) {
      const checkpoint = store.createFromRunResult(result, i, {
        label: labelPrefix ? `${labelPrefix}_step_${i}` : undefined,
      });
      await store.save(checkpoint);
      checkpoints.push(checkpoint);
    }

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
    return this.replayer.replay(this.cogitator, agent, {
      fromCheckpoint: checkpointId,
      mode: options?.mode ?? 'live',
      ...options,
    });
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
    return this.forker.fork(this.cogitator, agent, {
      checkpointId,
      ...options,
    });
  }

  async forkWithContext(
    agent: Agent,
    checkpointId: string,
    additionalContext: string,
    label?: string
  ): Promise<ForkResult> {
    return this.forker.forkWithContext(
      this.cogitator,
      agent,
      checkpointId,
      additionalContext,
      label
    );
  }

  async forkWithMockedTool(
    agent: Agent,
    checkpointId: string,
    toolName: string,
    mockResult: unknown,
    label?: string
  ): Promise<ForkResult> {
    return this.forker.forkWithMockedTools(
      this.cogitator,
      agent,
      checkpointId,
      { [toolName]: mockResult },
      label
    );
  }

  async forkWithMockedTools(
    agent: Agent,
    checkpointId: string,
    mockResults: Record<string, unknown>,
    label?: string
  ): Promise<ForkResult> {
    return this.forker.forkWithMockedTools(this.cogitator, agent, checkpointId, mockResults, label);
  }

  async forkWithNewInput(
    agent: Agent,
    checkpointId: string,
    newInput: string,
    label?: string
  ): Promise<ForkResult> {
    return this.forker.forkWithNewInput(this.cogitator, agent, checkpointId, newInput, label);
  }

  async forkMultiple(
    agent: Agent,
    checkpointId: string,
    variants: Array<Partial<ForkOptions>>
  ): Promise<ForkResult[]> {
    return this.forker.forkMultiple(this.cogitator, agent, checkpointId, variants);
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
