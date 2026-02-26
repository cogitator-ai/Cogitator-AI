/**
 * WorkflowExecutor - Main execution engine for workflows
 */

import type {
  Workflow,
  WorkflowState,
  WorkflowResult,
  WorkflowExecuteOptions,
  StreamingWorkflowEvent,
  CheckpointStore,
  NodeContext,
  CheckpointStrategy,
  NodeResult,
} from '@cogitator-ai/types';
import type { Cogitator } from '@cogitator-ai/core';
import { nanoid } from 'nanoid';
import { WorkflowScheduler } from './scheduler';
import { InMemoryCheckpointStore, createCheckpointId } from './checkpoint';

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_ITERATIONS = 100;

export class NodeExecutionError extends Error {
  readonly nodeName: string;

  constructor(nodeName: string, cause: Error) {
    super(`Node '${nodeName}' failed: ${cause.message}`);
    this.name = 'NodeExecutionError';
    this.nodeName = nodeName;
    this.cause = cause;
  }
}

export class WorkflowExecutor {
  private cogitator: Cogitator;
  private checkpointStore: CheckpointStore;
  private scheduler: WorkflowScheduler;

  constructor(cogitator: Cogitator, checkpointStore?: CheckpointStore) {
    this.cogitator = cogitator;
    this.checkpointStore = checkpointStore ?? new InMemoryCheckpointStore();
    this.scheduler = new WorkflowScheduler();
  }

  /**
   * Execute a workflow
   */
  async execute<S extends WorkflowState>(
    workflow: Workflow<S>,
    input?: Partial<S>,
    options?: WorkflowExecuteOptions
  ): Promise<WorkflowResult<S>> {
    const workflowId = options?.workflowId ?? `wf_${nanoid(12)}`;
    const startTime = Date.now();

    const maxConcurrency = options?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    const maxIterations = options?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const shouldCheckpoint = options?.checkpoint ?? false;
    const checkpointStrategy: CheckpointStrategy = options?.checkpointStrategy ?? 'per-iteration';
    const skipNodes = options?.skipNodes;

    let state: S = { ...workflow.initialState, ...input } as S;
    const nodeResults = new Map<string, { output: unknown; duration: number }>();
    const completedNodes = new Set<string>();
    let iterations = 0;
    let checkpointId: string | undefined;
    let error: Error | undefined;

    const graph = this.scheduler.buildDependencyGraph(workflow);

    let currentNodes = [workflow.entryPoint];

    const saveCheckpoint = async () => {
      checkpointId = createCheckpointId();
      await this.checkpointStore.save({
        id: checkpointId,
        workflowId,
        workflowName: workflow.name,
        state,
        completedNodes: Array.from(completedNodes),
        nodeResults: Object.fromEntries(
          Array.from(nodeResults.entries()).map(([k, v]) => [k, v.output])
        ),
        timestamp: Date.now(),
      });
    };

    const createTask = (nodeName: string, currentIteration: number) => async () => {
      const node = workflow.nodes.get(nodeName);
      if (!node) {
        throw new NodeExecutionError(nodeName, new Error(`Node '${nodeName}' not found`));
      }

      options?.onNodeStart?.(nodeName);

      const nodeStart = Date.now();

      const ctx: NodeContext<S> = {
        state: { ...state },
        nodeId: nodeName,
        workflowId,
        step: currentIteration,
        reportProgress: (progress: number) => {
          const clamped = Math.max(0, Math.min(100, progress));
          options?.onNodeProgress?.(nodeName, clamped);
        },
      };

      const deps = graph.dependencies.get(nodeName);
      if (deps && deps.size > 0) {
        const inputs: unknown[] = [];
        for (const dep of deps) {
          const depResult = nodeResults.get(dep);
          if (depResult) {
            inputs.push(depResult.output);
          }
        }
        ctx.input = inputs.length === 1 ? inputs[0] : inputs;
      }

      (ctx as NodeContext<S> & { cogitator: Cogitator }).cogitator = this.cogitator;

      try {
        const result = await node.fn(ctx);
        const duration = Date.now() - nodeStart;

        options?.onNodeComplete?.(nodeName, result.output, duration);

        return { nodeName, result, duration };
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        throw new NodeExecutionError(nodeName, err);
      }
    };

    const processNodeResult = (
      nodeName: string,
      result: NodeResult<S>,
      duration: number,
      nextNodes: string[]
    ) => {
      if (result.state) {
        state = { ...state, ...result.state } as S;
      }

      nodeResults.set(nodeName, {
        output: result.output,
        duration,
      });

      completedNodes.add(nodeName);

      if (result.next) {
        const next = Array.isArray(result.next) ? result.next : [result.next];
        nextNodes.push(...next);
      } else {
        const edgeNext = this.scheduler.getNextNodes(workflow, nodeName, state);
        nextNodes.push(...edgeNext);
      }
    };

    try {
      while (currentNodes.length > 0 && iterations < maxIterations) {
        iterations++;

        const nodesToRun = currentNodes.filter((n) => workflow.nodes.has(n) && !skipNodes?.has(n));

        if (skipNodes) {
          const skipped = currentNodes.filter((n) => skipNodes.has(n));
          for (const nodeName of skipped) {
            completedNodes.add(nodeName);
            const edgeNext = this.scheduler.getNextNodes(workflow, nodeName, state);
            for (const next of edgeNext) {
              if (!currentNodes.includes(next) && !completedNodes.has(next)) {
                nodesToRun.push(next);
              }
            }
          }
        }

        if (nodesToRun.length === 0) break;

        const tasks = nodesToRun.map((nodeName) => createTask(nodeName, iterations));
        const nextNodes: string[] = [];

        if (shouldCheckpoint && checkpointStrategy === 'per-node') {
          await this.scheduler.runParallelWithCallback(
            tasks,
            maxConcurrency,
            async ({ nodeName, result, duration }) => {
              processNodeResult(nodeName, result, duration, nextNodes);
              await saveCheckpoint();
            }
          );
        } else {
          const results = await this.scheduler.runParallel(tasks, maxConcurrency);

          for (const { nodeName, result, duration } of results) {
            processNodeResult(nodeName, result, duration, nextNodes);
          }

          if (shouldCheckpoint) {
            await saveCheckpoint();
          }
        }

        currentNodes = [...new Set(nextNodes)];
      }

      if (iterations >= maxIterations) {
        error = new Error(`Workflow exceeded max iterations (${maxIterations.toString()})`);
      }
    } catch (e) {
      if (e instanceof NodeExecutionError) {
        error = e.cause instanceof Error ? e.cause : e;
        options?.onNodeError?.(e.nodeName, error);
      } else {
        error = e instanceof Error ? e : new Error(String(e));
        options?.onNodeError?.(currentNodes[0] ?? 'unknown', error);
      }
    }

    return {
      workflowId,
      workflowName: workflow.name,
      state,
      nodeResults,
      duration: Date.now() - startTime,
      checkpointId,
      error,
    };
  }

  /**
   * Resume a workflow from a checkpoint
   */
  async resume<S extends WorkflowState>(
    workflow: Workflow<S>,
    checkpointId: string,
    options?: WorkflowExecuteOptions
  ): Promise<WorkflowResult<S>> {
    const checkpoint = await this.checkpointStore.load(checkpointId);

    if (!checkpoint) {
      throw new Error(`Checkpoint '${checkpointId}' not found`);
    }

    if (checkpoint.workflowName !== workflow.name) {
      throw new Error(
        `Checkpoint workflow '${checkpoint.workflowName}' does not match '${workflow.name}'`
      );
    }

    const allNodes = new Set(workflow.nodes.keys());
    const completed = new Set(checkpoint.completedNodes);
    const pending = [...allNodes].filter((n) => !completed.has(n));

    if (pending.length === 0) {
      return {
        workflowId: checkpoint.workflowId,
        workflowName: workflow.name,
        state: checkpoint.state as S,
        nodeResults: new Map(
          Object.entries(checkpoint.nodeResults).map(([k, v]) => [k, { output: v, duration: 0 }])
        ),
        duration: 0,
        checkpointId,
      };
    }

    return this.execute(workflow, checkpoint.state as Partial<S>, {
      ...options,
      workflowId: checkpoint.workflowId,
      skipNodes: completed,
    });
  }

  /**
   * Stream workflow execution events
   */
  async *stream<S extends WorkflowState>(
    workflow: Workflow<S>,
    input?: Partial<S>,
    options?: Omit<
      WorkflowExecuteOptions,
      'onNodeStart' | 'onNodeComplete' | 'onNodeError' | 'onNodeProgress'
    >
  ): AsyncIterable<StreamingWorkflowEvent> {
    const workflowId = `wf_${nanoid(12)}`;
    const startTime = Date.now();

    yield {
      type: 'workflow_started',
      workflowId,
      workflowName: workflow.name,
      timestamp: Date.now(),
    };

    const events: StreamingWorkflowEvent[] = [];
    let resolveNext: (() => void) | null = null;

    const pushEvent = (event: StreamingWorkflowEvent) => {
      events.push(event);
      resolveNext?.();
    };

    const resultPromise = this.execute(workflow, input, {
      ...options,
      workflowId,
      onNodeStart: (node) => {
        pushEvent({ type: 'node_started', nodeName: node, timestamp: Date.now() });
      },
      onNodeProgress: (node, progress) => {
        pushEvent({ type: 'node_progress', nodeName: node, progress, timestamp: Date.now() });
      },
      onNodeComplete: (node, output, duration) => {
        pushEvent({
          type: 'node_completed',
          nodeName: node,
          output,
          duration,
          timestamp: Date.now(),
        });
      },
      onNodeError: (node, error) => {
        pushEvent({ type: 'node_error', nodeName: node, error, timestamp: Date.now() });
      },
    });

    while (true) {
      if (events.length > 0) {
        yield events.shift()!;
      } else {
        const raceResult = await Promise.race([
          resultPromise.then((r) => ({ type: 'done' as const, result: r })),
          new Promise<{ type: 'event' }>((resolve) => {
            resolveNext = () => resolve({ type: 'event' });
          }),
        ]);

        if (raceResult.type === 'done') {
          while (events.length > 0) {
            yield events.shift()!;
          }

          yield {
            type: 'workflow_completed',
            workflowId,
            result: raceResult.result,
            duration: Date.now() - startTime,
          };

          break;
        }
      }
    }
  }
}
