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
} from '@cogitator/types';
import type { Cogitator } from '@cogitator/core';
import { WorkflowExecutor } from '../executor.js';
import { type JobScheduler, createJobScheduler } from './scheduler';
import { InMemoryRunStore } from './run-store';

/**
 * Workflow manager configuration
 */
export interface WorkflowManagerConfig {
  cogitator: Cogitator;
  runStore?: RunStore;
  checkpointStore?: CheckpointStore;
  maxConcurrency?: number;
  defaultTimeout?: number;
  onRunStateChange?: (run: WorkflowRun) => void;
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
  private activeRuns = new Map<string, { abort: () => void }>();
  private stateChangeCallbacks = new Set<(run: WorkflowRun) => void>();

  constructor(config: WorkflowManagerConfig) {
    this.cogitator = config.cogitator;
    this.runStore = config.runStore ?? new InMemoryRunStore();
    this.checkpointStore = config.checkpointStore;

    this.executor = new WorkflowExecutor(this.cogitator, this.checkpointStore);

    this.scheduler = createJobScheduler({
      runStore: this.runStore,
      maxConcurrency: config.maxConcurrency,
      onRunReady: (runId) => this.handleRunReady(runId),
    });

    if (config.onRunStateChange) {
      this.stateChangeCallbacks.add(config.onRunStateChange);
    }
  }

  /**
   * Start the manager (begins processing scheduled runs)
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
   * Register a workflow for scheduling
   */
  registerWorkflow<S extends WorkflowState>(workflow: Workflow<S>): void {
    this.workflows.set(workflow.name, workflow as unknown as Workflow<WorkflowState>);
  }

  /**
   * Schedule a workflow for later execution
   */
  async schedule<S extends WorkflowState>(
    workflow: Workflow<S>,
    options?: ScheduleOptions
  ): Promise<string> {
    this.registerWorkflow(workflow);
    return this.scheduler.scheduleRun(workflow, options);
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

    const abortController = new AbortController();
    this.activeRuns.set(runId, { abort: () => abortController.abort() });
    this.scheduler.runStarted(runId);

    try {
      const result = await this.executor.execute(workflow, input, {
        ...options,
        onNodeStart: (node) => {
          this.updateRunNodes(runId, node, 'start');
          options?.onNodeStart?.(node);
        },
        onNodeComplete: (node, result, duration) => {
          this.updateRunNodes(runId, node, 'complete');
          options?.onNodeComplete?.(node, result, duration);
        },
        onNodeError: (node, error) => {
          this.updateRunNodes(runId, node, 'error');
          options?.onNodeError?.(node, error);
        },
      });

      if (result.error) {
        await this.runStore.update(runId, {
          status: 'failed',
          state: result.state,
          completedAt: Date.now(),
          checkpointId: result.checkpointId,
          error: {
            name: result.error.name,
            message: result.error.message,
            stack: result.error.stack,
          },
        });

        const updatedRun = await this.runStore.get(runId);
        if (updatedRun) this.notifyStateChange(updatedRun);

        return result;
      }

      await this.runStore.update(runId, {
        status: 'completed',
        state: result.state,
        output: result.state,
        completedAt: Date.now(),
        checkpointId: result.checkpointId,
      });

      const updatedRun = await this.runStore.get(runId);
      if (updatedRun) this.notifyStateChange(updatedRun);

      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      await this.runStore.update(runId, {
        status: 'failed',
        completedAt: Date.now(),
        error: {
          name: err.name,
          message: err.message,
          stack: err.stack,
        },
      });

      const updatedRun = await this.runStore.get(runId);
      if (updatedRun) this.notifyStateChange(updatedRun);

      throw error;
    } finally {
      this.activeRuns.delete(runId);
      this.scheduler.runCompleted(runId);
    }
  }

  /**
   * Cancel a run
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
      const active = this.activeRuns.get(runId);
      if (active) {
        active.abort();
      }

      await this.runStore.update(runId, {
        status: 'cancelled',
        completedAt: Date.now(),
        error: reason ? { name: 'CancelError', message: reason } : undefined,
      });

      const updatedRun = await this.runStore.get(runId);
      if (updatedRun) this.notifyStateChange(updatedRun);
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
   * Pause a running workflow
   */
  async pause(runId: string): Promise<void> {
    const run = await this.runStore.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    if (run.status !== 'running') {
      throw new Error(`Cannot pause run in status: ${run.status}`);
    }

    await this.runStore.update(runId, {
      status: 'paused',
      pausedAt: Date.now(),
    });

    const updatedRun = await this.runStore.get(runId);
    if (updatedRun) this.notifyStateChange(updatedRun);
  }

  /**
   * Resume a paused workflow
   */
  async resume(runId: string): Promise<void> {
    const run = await this.runStore.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    if (run.status !== 'paused') {
      throw new Error(`Cannot resume run in status: ${run.status}`);
    }

    await this.runStore.update(runId, {
      status: 'running',
      pausedAt: undefined,
    });

    const updatedRun = await this.runStore.get(runId);
    if (updatedRun) this.notifyStateChange(updatedRun);
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
      },
    };

    await this.runStore.save(newRun);

    await this.scheduler.scheduleRun(workflow, {
      priority: run.priority,
      tags: newRun.tags,
    });

    return newRunId;
  }

  /**
   * Replay a workflow from a specific node
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

    const newRun: WorkflowRun = {
      id: newRunId,
      workflowName: workflow.name,
      status: 'running',
      state: run.state,
      input: run.input,
      currentNodes: [],
      completedNodes: run.completedNodes.filter((n) => {
        return workflow.nodes.has(n) && n !== fromNode;
      }),
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

    await this.runStore.save(newRun);
    this.notifyStateChange(newRun);

    const result = await this.executor.execute(workflow, run.state as Partial<S>, {
      checkpoint: !!this.checkpointStore,
    });

    await this.runStore.update(newRunId, {
      status: 'completed',
      state: result.state,
      output: result.state,
      completedAt: Date.now(),
      checkpointId: result.checkpointId,
    });

    const updatedRun = await this.runStore.get(newRunId);
    if (updatedRun) this.notifyStateChange(updatedRun);

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
    this.workflows.clear();
    this.stateChangeCallbacks.clear();
    this.scheduler.dispose();
  }

  private async handleRunReady(runId: string): Promise<void> {
    const run = await this.runStore.get(runId);
    if (!run) return;

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
      return;
    }

    await this.runStore.update(runId, {
      status: 'running',
      startedAt: Date.now(),
    });

    this.scheduler.runStarted(runId);
    const active = { abort: () => {} };
    this.activeRuns.set(runId, active);

    try {
      const result = await this.executor.execute(
        workflow,
        run.input as Partial<WorkflowState>
      );

      await this.runStore.update(runId, {
        status: 'completed',
        state: result.state,
        output: result.state,
        completedAt: Date.now(),
        checkpointId: result.checkpointId,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      await this.runStore.update(runId, {
        status: 'failed',
        completedAt: Date.now(),
        error: {
          name: err.name,
          message: err.message,
          stack: err.stack,
        },
      });
    } finally {
      this.activeRuns.delete(runId);
      this.scheduler.runCompleted(runId);

      const updatedRun = await this.runStore.get(runId);
      if (updatedRun) this.notifyStateChange(updatedRun);
    }
  }

  private async updateRunNodes(
    runId: string,
    nodeId: string,
    action: 'start' | 'complete' | 'error'
  ): Promise<void> {
    const run = await this.runStore.get(runId);
    if (!run) return;

    const updates: Partial<WorkflowRun> = {};

    switch (action) {
      case 'start':
        updates.currentNodes = [...run.currentNodes, nodeId];
        break;
      case 'complete':
        updates.currentNodes = run.currentNodes.filter((n) => n !== nodeId);
        updates.completedNodes = [...run.completedNodes, nodeId];
        break;
      case 'error':
        updates.currentNodes = run.currentNodes.filter((n) => n !== nodeId);
        updates.failedNodes = [...run.failedNodes, nodeId];
        break;
    }

    await this.runStore.update(runId, updates);
  }

  private notifyStateChange(run: WorkflowRun): void {
    for (const callback of this.stateChangeCallbacks) {
      try {
        callback(run);
      } catch {
      }
    }
  }
}

/**
 * Create a workflow manager
 */
export function createWorkflowManager(
  config: WorkflowManagerConfig
): DefaultWorkflowManager {
  return new DefaultWorkflowManager(config);
}
