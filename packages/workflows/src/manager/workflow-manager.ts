/**
 * Workflow Manager
 *
 * Features:
 * - Schedule workflows for later execution
 * - Execute workflows immediately
 * - Cancel, pause, resume, retry runs
 * - Replay from specific nodes
 * - Query run status and history
 * - Cleanup old runs
 */

import { nanoid } from 'nanoid';
import type {
  Workflow,
  WorkflowState,
  WorkflowResult,
  WorkflowRun,
  WorkflowRunFilters,
  WorkflowRunStats,
  WorkflowManager as IWorkflowManager,
  ScheduleOptions,
  WorkflowExecuteOptionsV2,
  RunStore,
  CheckpointStore,
  DeadLetterQueue,
  RecoveredRuns,
} from '@cogitator-ai/types';
import type { Cogitator } from '@cogitator-ai/core';
import { WorkflowExecutor } from '../executor';
import { WorkflowScheduler } from '../scheduler';
import { type CronJob, type JobScheduler, createJobScheduler } from './scheduler';
import { InMemoryRunStore } from './run-store';
import { createTracer, type WorkflowTracer } from '../observability/tracer';
import { createMetricsCollector, type WorkflowMetricsCollector } from '../observability/metrics';

/**
 * Workflow manager configuration
 */
export interface WorkflowManagerConfig {
  cogitator: Cogitator;
  runStore?: RunStore;
  /** Checkpoints every run; needed to pause and resume runs */
  checkpointStore?: CheckpointStore;
  maxConcurrency?: number;
  /** Cancel runs that take longer than this many ms (marked failed with a timeout error) */
  defaultTimeout?: number;
  /** Tracer used for every run (overridden per run by `options.tracing`) */
  tracer?: WorkflowTracer;
  /** Metrics collector used for every run (`options.metrics.enabled: false` opts a run out) */
  metrics?: WorkflowMetricsCollector;
  onRunStateChange?: (run: WorkflowRun) => void;
}

/** Why a run was asked to stop before it finished */
type StopReason = 'paused' | 'cancelled';

interface ActiveRun {
  controller: AbortController;
  stopReason?: StopReason;
  /** The store write of the stop, which the run's final write must not overtake */
  stopWrite?: Promise<void>;
}

/** Where a run continues from instead of the workflow's entry point */
interface ResumePoint {
  workflowId: string;
  skipNodes: Set<string>;
  nodeResults: Record<string, unknown>;
}

interface RunLaunch<S extends WorkflowState> {
  runId: string;
  workflow: Workflow<S>;
  input?: Partial<S>;
  options?: WorkflowExecuteOptionsV2;
  timeout?: number;
  resumeFrom?: ResumePoint;
}

type RunUpdate = Partial<WorkflowRun>;

/** A finite number stored under `key` in the run's metadata (scheduling options live there) */
function metadataNumber(run: WorkflowRun, key: string): number | undefined {
  const value = run.metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function errorRecord(error: Error): NonNullable<WorkflowRun['error']> {
  return { name: error.name, message: error.message, stack: error.stack };
}

/**
 * Workflow manager implementation
 */
export class DefaultWorkflowManager implements IWorkflowManager {
  private cogitator: Cogitator;
  private runStore: RunStore;
  private checkpointStore?: CheckpointStore;
  private scheduler: JobScheduler;
  private executor: WorkflowExecutor;
  private workflows = new Map<string, Workflow<WorkflowState>>();
  private activeRuns = new Map<string, ActiveRun>();
  /** Execute options of runs that are active or paused, reused when a paused run resumes */
  private runOptions = new Map<string, WorkflowExecuteOptionsV2>();
  private stateChangeCallbacks = new Set<(run: WorkflowRun) => void>();
  private runLocks = new Map<string, Promise<void>>();
  private defaultTimeout?: number;
  private tracer?: WorkflowTracer;
  private metrics?: WorkflowMetricsCollector;
  private disabledMetrics?: WorkflowMetricsCollector;

  constructor(config: WorkflowManagerConfig) {
    this.cogitator = config.cogitator;
    this.defaultTimeout = config.defaultTimeout;
    this.tracer = config.tracer;
    this.metrics = config.metrics;
    this.runStore = config.runStore ?? new InMemoryRunStore();
    this.checkpointStore = config.checkpointStore;

    this.executor = new WorkflowExecutor(this.cogitator, this.checkpointStore);

    this.scheduler = createJobScheduler({
      runStore: this.runStore,
      maxConcurrency: config.maxConcurrency,
      onRunReady: (runId) => {
        this.handleRunReady(runId).catch((error: unknown) => {
          console.warn(`[WorkflowManager] Scheduled run '${runId}' could not be started:`, error);
        });
      },
    });

    if (config.onRunStateChange) {
      this.stateChangeCallbacks.add(config.onRunStateChange);
    }
  }

  /**
   * Start the manager (begins processing scheduled runs and cron jobs)
   */
  start(): void {
    this.scheduler.start();
  }

  /**
   * Stop the manager
   */
  stop(): void {
    this.scheduler.stop();
  }

  /**
   * Register a workflow for scheduling, retries and resuming
   */
  registerWorkflow<S extends WorkflowState>(workflow: Workflow<S>): void {
    this.workflows.set(workflow.name, workflow as unknown as Workflow<WorkflowState>);
  }

  /**
   * Schedule a workflow for later execution. `cron` queues one run at the next
   * occurrence; use `registerCronJob` for a recurring schedule.
   */
  async schedule<S extends WorkflowState>(
    workflow: Workflow<S>,
    options?: ScheduleOptions
  ): Promise<string> {
    this.registerWorkflow(workflow);
    return this.scheduler.scheduleRun(workflow, options);
  }

  /**
   * Run `workflow` on every occurrence of the cron `expression` while the manager is
   * started. Each occurrence queues a run with `jobOptions` and `triggerId: 'cron:<jobId>'`.
   * Returns the job id.
   */
  registerCronJob<S extends WorkflowState>(
    workflow: Workflow<S>,
    expression: string,
    options?: {
      id?: string;
      timezone?: string;
      jobOptions?: Omit<ScheduleOptions, 'at' | 'cron' | 'timezone'>;
    }
  ): string {
    this.registerWorkflow(workflow);
    return this.scheduler.registerCronJob(workflow, expression, options);
  }

  /**
   * Remove a cron job; runs it already queued are kept
   */
  unregisterCronJob(jobId: string): boolean {
    return this.scheduler.unregisterCronJob(jobId);
  }

  /**
   * Pause or continue a cron job
   */
  setCronJobEnabled(jobId: string, enabled: boolean): boolean {
    return this.scheduler.setCronJobEnabled(jobId, enabled);
  }

  /**
   * List the registered cron jobs
   */
  getCronJobs(): CronJob[] {
    return this.scheduler.getCronJobs();
  }

  /**
   * Execute a workflow immediately
   */
  async execute<S extends WorkflowState>(
    workflow: Workflow<S>,
    input?: Partial<S>,
    options?: WorkflowExecuteOptionsV2
  ): Promise<WorkflowResult<S>> {
    this.registerWorkflow(workflow);

    const runId = nanoid();
    const now = Date.now();

    const run: WorkflowRun = {
      id: runId,
      workflowName: workflow.name,
      status: 'running',
      state: input ?? {},
      input,
      currentNodes: [],
      completedNodes: [],
      failedNodes: [],
      startedAt: now,
      priority: options?.priority ?? 0,
      tags: options?.tags ?? [],
      triggerId: options?.triggerId,
      parentRunId: options?.parentRunId,
      traceId: options?.parentTraceContext?.traceId,
      metadata: options?.metadata,
    };

    await this.runStore.save(run);
    this.notifyStateChange(run);

    this.scheduler.runStarted(runId);
    return this.runWorkflow({ runId, workflow, input, options, timeout: this.defaultTimeout });
  }

  /**
   * Cancel a run. A running run is aborted: the nodes in flight get the abort signal and
   * no further node starts.
   */
  async cancel(runId: string, reason?: string): Promise<void> {
    const run = await this.runStore.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    if (run.status === 'scheduled' || run.status === 'pending') {
      await this.scheduler.cancelRun(runId, reason);
      const updatedRun = await this.runStore.get(runId);
      if (updatedRun) this.notifyStateChange(updatedRun);
      return;
    }

    if (run.status === 'running' || run.status === 'paused') {
      await this.stopRun(runId, 'cancelled', {
        status: 'cancelled',
        completedAt: Date.now(),
        error: reason ? { name: 'CancelError', message: reason } : undefined,
      });
      if (!this.activeRuns.has(runId)) this.runOptions.delete(runId);
    }
  }

  /**
   * Get run status
   */
  async getStatus(runId: string): Promise<WorkflowRun | null> {
    return this.runStore.get(runId);
  }

  /**
   * List runs with filters
   */
  async listRuns(filters?: WorkflowRunFilters): Promise<WorkflowRun[]> {
    return this.runStore.list(filters);
  }

  /**
   * Get run statistics
   */
  async getStats(workflowName?: string): Promise<WorkflowRunStats> {
    return this.runStore.getStats(workflowName);
  }

  /**
   * Pause a running workflow. Execution is aborted (nodes in flight get the abort signal)
   * and `resume()` continues from the run's last checkpoint, so the manager needs a
   * `checkpointStore`.
   */
  async pause(runId: string): Promise<void> {
    const run = await this.runStore.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    if (run.status !== 'running') {
      throw new Error(`Cannot pause run in status: ${run.status}`);
    }

    if (!this.checkpointStore) {
      throw new Error(
        `Cannot pause run '${runId}': the manager has no checkpointStore to resume it from (use cancel() to stop it)`
      );
    }

    await this.stopRun(runId, 'paused', { status: 'paused', pausedAt: Date.now() });
  }

  /**
   * Resume a paused workflow from its last checkpoint (from the start when it was paused
   * before the first checkpoint). Nodes that completed before the checkpoint are not run
   * again. Resolves once the run is running again; follow it with `onRunStateChange` or
   * `getStatus`. `options` default to the ones the run was started with in this process.
   */
  async resume(runId: string, options?: WorkflowExecuteOptionsV2): Promise<void> {
    const run = await this.runStore.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    if (run.status !== 'paused') {
      throw new Error(`Cannot resume run in status: ${run.status}`);
    }

    if (this.activeRuns.has(runId)) {
      throw new Error(
        `Cannot resume run '${runId}' yet: the nodes it was running when paused have not finished`
      );
    }

    const workflow = this.workflows.get(run.workflowName);
    if (!workflow) {
      throw new Error(`Workflow not found: ${run.workflowName}`);
    }

    const checkpoint = run.checkpointId
      ? await this.checkpointStore?.load(run.checkpointId)
      : undefined;
    if (run.checkpointId && !checkpoint) {
      throw new Error(`Checkpoint '${run.checkpointId}' of run '${runId}' not found`);
    }

    await this.runStore.update(runId, {
      status: 'running',
      pausedAt: undefined,
      currentNodes: [],
    });

    const updatedRun = await this.runStore.get(runId);
    if (updatedRun) this.notifyStateChange(updatedRun);

    this.scheduler.runStarted(runId);
    void this.runWorkflow({
      runId,
      workflow,
      options: options ?? this.runOptions.get(runId),
      timeout: this.runTimeout(run),
      ...(checkpoint
        ? {
            input: checkpoint.state,
            resumeFrom: {
              workflowId: checkpoint.workflowId,
              skipNodes: new Set(checkpoint.completedNodes),
              nodeResults: checkpoint.nodeResults,
            },
          }
        : { input: run.input as Partial<WorkflowState> | undefined }),
    }).catch(() => {});
  }

  /**
   * Picks up the runs a stopped process left running or waiting: each run of a workflow
   * registered here is marked paused and resumed from its last checkpoint, so its completed nodes
   * are kept and its human nodes find their open requests again. Pass the options the runs need
   * that only lived in the stopped process, such as `approvalStore`.
   *
   * Call it once at startup, from the one process that runs these workflows: runs another live
   * process is still executing would run twice.
   */
  async recoverRuns(options?: WorkflowExecuteOptionsV2): Promise<RecoveredRuns> {
    const orphans = await this.runStore.list({ status: ['running', 'waiting'] });
    const resumed: string[] = [];
    const skipped: RecoveredRuns['skipped'] = [];

    for (const run of orphans) {
      if (this.activeRuns.has(run.id)) continue;
      if (!this.workflows.has(run.workflowName)) {
        skipped.push({ runId: run.id, reason: `workflow ${run.workflowName} is not registered` });
        continue;
      }
      await this.runStore.update(run.id, { status: 'paused', pausedAt: Date.now() });
      try {
        await this.resume(run.id, options);
        resumed.push(run.id);
      } catch (error) {
        skipped.push({
          runId: run.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { resumed, skipped };
  }

  /**
   * Retry a failed run
   */
  async retry(runId: string): Promise<string> {
    const run = await this.runStore.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    if (run.status !== 'failed' && run.status !== 'cancelled') {
      throw new Error(`Cannot retry run in status: ${run.status}`);
    }

    const workflow = this.workflows.get(run.workflowName);
    if (!workflow) {
      throw new Error(`Workflow not found: ${run.workflowName}`);
    }

    const newRunId = nanoid();
    const now = Date.now();

    const newRun: WorkflowRun = {
      id: newRunId,
      workflowName: run.workflowName,
      status: 'pending',
      state: (run.input ?? {}) as WorkflowState,
      input: run.input,
      currentNodes: [],
      completedNodes: [],
      failedNodes: [],
      priority: run.priority,
      tags: [...run.tags, 'retry'],
      triggerId: run.triggerId,
      parentRunId: runId,
      metadata: {
        ...run.metadata,
        retriedFrom: runId,
        retriedAt: now,
        retryAttempt: (metadataNumber(run, 'retryAttempt') ?? 0) + 1,
      },
    };

    await this.runStore.save(newRun);

    await this.scheduler.scheduleRun(
      workflow,
      {
        priority: run.priority,
        tags: newRun.tags,
      },
      newRunId
    );

    return newRunId;
  }

  private reachability<S extends WorkflowState>(workflow: Workflow<S>): Map<string, Set<string>> {
    return new WorkflowScheduler().buildReachability(workflow);
  }

  /**
   * Replay a workflow from a specific node: that node and every node after it
   * run again; the nodes before it keep their results.
   */
  async replay<S extends WorkflowState>(
    workflow: Workflow<S>,
    runId: string,
    fromNode: string
  ): Promise<WorkflowResult<S>> {
    const run = await this.runStore.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    if (!run.checkpointId) {
      throw new Error('Run has no checkpoint to replay from');
    }

    const newRunId = nanoid();
    const now = Date.now();
    const rerun = new Set([fromNode, ...(this.reachability(workflow).get(fromNode) ?? [])]);
    const checkpoint = await this.checkpointStore?.load(run.checkpointId);
    const done = checkpoint?.completedNodes ?? run.completedNodes;
    const kept = done.filter((n) => workflow.nodes.has(n) && !rerun.has(n));
    const keptResults = Object.fromEntries(
      Object.entries(checkpoint?.nodeResults ?? {}).filter(([node]) => kept.includes(node))
    );

    const newRun: WorkflowRun = {
      id: newRunId,
      workflowName: workflow.name,
      status: 'running',
      state: run.state,
      input: run.input,
      currentNodes: [],
      completedNodes: kept,
      failedNodes: [],
      startedAt: now,
      priority: run.priority,
      tags: [...run.tags, 'replay'],
      parentRunId: runId,
      metadata: {
        ...run.metadata,
        replayedFrom: runId,
        replayFromNode: fromNode,
        replayedAt: now,
      },
    };

    this.registerWorkflow(workflow);
    await this.runStore.save(newRun);
    this.notifyStateChange(newRun);

    this.scheduler.runStarted(newRunId);
    return this.runWorkflow({
      runId: newRunId,
      workflow,
      input: run.state as Partial<S>,
      timeout: this.defaultTimeout,
      resumeFrom: {
        workflowId: newRunId,
        skipNodes: new Set(kept),
        nodeResults: keptResults,
      },
    });
  }

  /**
   * Runs a dead-lettered node again by replaying its run from the failed node, or running the
   * workflow again from its input when the run failed before any checkpoint (nothing had
   * completed, so nothing runs twice). The attempt is recorded on the entry first, and the entry is removed when the replay succeeds, so an entry
   * that fails again stays in the queue with one more attempt.
   *
   * @throws Error when the entry is gone, its workflow is not registered here, the node no longer
   *   exists, its run is unknown, or the manager keeps no checkpoints
   */
  async retryDeadLetter<S extends WorkflowState>(
    queue: DeadLetterQueue,
    entryId: string
  ): Promise<WorkflowResult<S>> {
    const entry = await queue.get(entryId);
    if (!entry) throw new Error(`Dead letter entry not found: ${entryId}`);
    const workflow = this.workflows.get(entry.workflowName) as Workflow<S> | undefined;
    if (!workflow) {
      throw new Error(
        `Workflow not found: ${entry.workflowName}. Register it with registerWorkflow() before retrying its dead letters`
      );
    }
    if (!workflow.nodes.has(entry.nodeId)) {
      throw new Error(`Node ${entry.nodeId} is no longer part of workflow ${entry.workflowName}`);
    }

    if (!this.checkpointStore) {
      throw new Error('Retrying a dead letter needs a manager with a checkpointStore');
    }
    const run = await this.runStore.get(entry.workflowId);
    if (!run) throw new Error(`Run not found: ${entry.workflowId}`);

    await queue.retry(entryId);
    const result = run.checkpointId
      ? await this.replay(workflow, run.id, entry.nodeId)
      : await this.execute(workflow, run.input as Partial<S> | undefined);
    if (!result.error) await queue.remove(entryId);
    return result;
  }

  /**
   * Get count of active runs
   */
  async getActiveCount(): Promise<number> {
    return this.runStore.count({
      status: ['running', 'paused', 'waiting'],
    });
  }

  /**
   * Subscribe to run state changes
   */
  onRunStateChange(callback: (run: WorkflowRun) => void): () => void {
    this.stateChangeCallbacks.add(callback);
    return () => {
      this.stateChangeCallbacks.delete(callback);
    };
  }

  /**
   * Cleanup old runs
   */
  async cleanup(olderThan: number): Promise<number> {
    return this.runStore.cleanup(olderThan);
  }

  /**
   * Dispose the manager
   */
  dispose(): void {
    this.stop();
    this.activeRuns.clear();
    this.runOptions.clear();
    this.runLocks.clear();
    this.workflows.clear();
    this.stateChangeCallbacks.clear();
    this.scheduler.dispose();
  }

  /** Scheduling `timeout` stored on the run, else the manager's `defaultTimeout` */
  private runTimeout(run: WorkflowRun): number | undefined {
    return metadataNumber(run, 'timeout') ?? this.defaultTimeout;
  }

  private async handleRunReady(runId: string): Promise<void> {
    const run = await this.runStore.get(runId);
    if (!run || (run.status !== 'pending' && run.status !== 'scheduled')) {
      this.scheduler.runCompleted(runId);
      return;
    }

    const workflow = this.workflows.get(run.workflowName);
    if (!workflow) {
      await this.runStore.update(runId, {
        status: 'failed',
        completedAt: Date.now(),
        error: {
          name: 'WorkflowNotFoundError',
          message: `Workflow not found: ${run.workflowName}`,
        },
      });
      this.scheduler.runCompleted(runId);
      const failedRun = await this.runStore.get(runId);
      if (failedRun) this.notifyStateChange(failedRun);
      return;
    }

    await this.runStore.update(runId, {
      status: 'running',
      startedAt: Date.now(),
    });

    const startedRun = await this.runStore.get(runId);
    if (startedRun) this.notifyStateChange(startedRun);

    try {
      await this.runWorkflow({
        runId,
        workflow,
        input: run.input as Partial<WorkflowState> | undefined,
        timeout: this.runTimeout(run),
      });
    } catch {}

    const finished = await this.runStore.get(runId);
    const maxRetries = finished ? metadataNumber(finished, 'maxRetries') : undefined;
    if (
      finished?.status === 'failed' &&
      maxRetries !== undefined &&
      (metadataNumber(finished, 'retryAttempt') ?? 0) < maxRetries
    ) {
      await this.retry(runId);
    }
  }

  /**
   * Abort an active run for `reason` and record `update`. The run's own final write waits
   * for this one, so the stop status is never overwritten by a stale 'running' outcome.
   */
  private async stopRun(runId: string, reason: StopReason, update: RunUpdate): Promise<void> {
    const write = this.runStore.update(runId, update);
    const active = this.activeRuns.get(runId);
    if (active) {
      active.stopReason = reason;
      active.stopWrite = write.catch(() => {});
      active.controller.abort();
    }

    await write;
    const updatedRun = await this.runStore.get(runId);
    if (updatedRun) this.notifyStateChange(updatedRun);
  }

  /**
   * Execute a run that is already stored as running and counted by the scheduler, then
   * record how it ended: completed, failed, or paused/cancelled when it was stopped.
   */
  private async runWorkflow<S extends WorkflowState>(
    launch: RunLaunch<S>
  ): Promise<WorkflowResult<S>> {
    const { runId, workflow, input, options, timeout, resumeFrom } = launch;
    const active: ActiveRun = { controller: new AbortController() };
    this.activeRuns.set(runId, active);
    if (options) this.runOptions.set(runId, options);

    let timedOut = false;
    const timeoutHandle =
      timeout !== undefined && timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            active.controller.abort();
          }, timeout)
        : undefined;

    const runTracer = options?.tracing ? createTracer(options.tracing) : this.tracer;
    const runMetrics =
      options?.metrics?.enabled === false
        ? (this.disabledMetrics ??= createMetricsCollector({ enabled: false }))
        : this.metrics;

    try {
      const executed = await this.executor.execute(workflow, input, {
        checkpoint: !!this.checkpointStore,
        workflowId: runId,
        ...options,
        ...resumeFrom,
        signal: active.controller.signal,
        tracer: runTracer,
        metricsCollector: runMetrics,
        ...this.trackNodes(runId, options),
      });
      await this.settleNodeUpdates(runId);
      await active.stopWrite;

      const stopped = executed.error ? active.stopReason : undefined;
      const error = stopped
        ? new Error(`Workflow run '${runId}' was ${stopped}`)
        : timedOut
          ? new Error(`Workflow run '${runId}' timed out after ${String(timeout)}ms`)
          : executed.error;
      const result: WorkflowResult<S> =
        error === executed.error ? executed : { ...executed, error };

      const checkpoint = result.checkpointId ? { checkpointId: result.checkpointId } : {};
      if (stopped) {
        await this.finishRun(runId, { status: stopped, state: result.state, ...checkpoint });
      } else if (result.error) {
        await this.finishRun(runId, {
          status: 'failed',
          state: result.state,
          completedAt: Date.now(),
          ...checkpoint,
          error: errorRecord(result.error),
        });
      } else {
        await this.finishRun(runId, {
          status: 'completed',
          state: result.state,
          output: result.state,
          completedAt: Date.now(),
          pausedAt: undefined,
          error: undefined,
          ...checkpoint,
        });
      }

      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.settleNodeUpdates(runId);
      await active.stopWrite;

      await this.finishRun(
        runId,
        active.stopReason
          ? { status: active.stopReason }
          : { status: 'failed', completedAt: Date.now(), error: errorRecord(err) }
      );

      throw error;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (runTracer && runTracer !== this.tracer) {
        await runTracer.flush().catch((error: unknown) => {
          console.warn('[WorkflowManager] Failed to flush run traces:', error);
        });
      }
      this.activeRuns.delete(runId);
      this.runLocks.delete(runId);
      if (active.stopReason !== 'paused') this.runOptions.delete(runId);
      this.scheduler.runCompleted(runId);
    }
  }

  private async finishRun(runId: string, update: RunUpdate): Promise<void> {
    await this.runStore.update(runId, update);
    const updatedRun = await this.runStore.get(runId);
    if (updatedRun) this.notifyStateChange(updatedRun);
  }

  /** Node callbacks that record the run's current, completed and failed nodes, then call `options`' own. */
  private trackNodes(
    runId: string,
    options?: Pick<WorkflowExecuteOptionsV2, 'onNodeStart' | 'onNodeComplete' | 'onNodeError'>
  ): Pick<WorkflowExecuteOptionsV2, 'onNodeStart' | 'onNodeComplete' | 'onNodeError'> {
    return {
      onNodeStart: (node) => {
        void this.updateRunNodes(runId, node, 'start');
        options?.onNodeStart?.(node);
      },
      onNodeComplete: (node, result, duration) => {
        void this.updateRunNodes(runId, node, 'complete');
        options?.onNodeComplete?.(node, result, duration);
      },
      onNodeError: (node, error) => {
        void this.updateRunNodes(runId, node, 'error');
        options?.onNodeError?.(node, error);
      },
    };
  }

  /** Waits for the node updates still being written, so the final run record has them all. */
  private async settleNodeUpdates(runId: string): Promise<void> {
    await this.runLocks.get(runId);
  }

  private async updateRunNodes(
    runId: string,
    nodeId: string,
    action: 'start' | 'complete' | 'error'
  ): Promise<void> {
    const prev = this.runLocks.get(runId) ?? Promise.resolve();

    const next = prev.then(async () => {
      const run = await this.runStore.get(runId);
      if (!run) return;

      const updates: Partial<WorkflowRun> = {};
      const others = run.currentNodes.filter((n) => n !== nodeId);

      switch (action) {
        case 'start':
          updates.currentNodes = [...others, nodeId];
          break;
        case 'complete':
          updates.currentNodes = others;
          updates.completedNodes = run.completedNodes.includes(nodeId)
            ? run.completedNodes
            : [...run.completedNodes, nodeId];
          break;
        case 'error':
          updates.currentNodes = others;
          updates.failedNodes = run.failedNodes.includes(nodeId)
            ? run.failedNodes
            : [...run.failedNodes, nodeId];
          break;
      }

      await this.runStore.update(runId, updates);
    });

    this.runLocks.set(
      runId,
      next.catch(() => {})
    );
    await next;
  }

  private notifyStateChange(run: WorkflowRun): void {
    for (const callback of this.stateChangeCallbacks) {
      try {
        callback(run);
      } catch {}
    }
  }
}

/**
 * Create a workflow manager
 */
export function createWorkflowManager(config: WorkflowManagerConfig): DefaultWorkflowManager {
  return new DefaultWorkflowManager(config);
}
