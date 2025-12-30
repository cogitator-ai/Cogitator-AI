/**
 * WorkflowExecutor - Main execution engine for workflows
 */

import type {
  Workflow,
  WorkflowState,
  WorkflowResult,
  WorkflowExecuteOptions,
  WorkflowEvent,
  CheckpointStore,
  NodeContext,
} from '@cogitator/types';
import type { Cogitator } from '@cogitator/core';
import { nanoid } from 'nanoid';
import { WorkflowScheduler } from './scheduler.js';
import { InMemoryCheckpointStore, createCheckpointId } from './checkpoint.js';

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_ITERATIONS = 100;

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
    const workflowId = `wf_${nanoid(12)}`;
    const startTime = Date.now();

    const maxConcurrency = options?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    const maxIterations = options?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const shouldCheckpoint = options?.checkpoint ?? false;

    let state: S = { ...workflow.initialState, ...input } as S;
    const nodeResults = new Map<string, { output: unknown; duration: number }>();
    const completedNodes = new Set<string>();
    let iterations = 0;
    let checkpointId: string | undefined;
    let error: Error | undefined;

    const graph = this.scheduler.buildDependencyGraph(workflow);

    let currentNodes = [workflow.entryPoint];

    try {
      while (currentNodes.length > 0 && iterations < maxIterations) {
        iterations++;

        const nodesToRun = currentNodes.filter((n) => {
          return workflow.nodes.has(n);
        });

        if (nodesToRun.length === 0) break;

        const tasks = nodesToRun.map((nodeName) => async () => {
          const node = workflow.nodes.get(nodeName);
          if (!node) {
            throw new Error(`Node '${nodeName}' not found`);
          }

          options?.onNodeStart?.(nodeName);

          const nodeStart = Date.now();

          const ctx: NodeContext<S> = {
            state: { ...state },
            nodeId: nodeName,
            workflowId,
            step: iterations,
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

          (ctx as NodeContext<S> & { cogitator: Cogitator }).cogitator =
            this.cogitator;

          const result = await node.fn(ctx);
          const duration = Date.now() - nodeStart;

          options?.onNodeComplete?.(nodeName, result.output, duration);

          return { nodeName, result, duration };
        });

        const results = await this.scheduler.runParallel(
          tasks,
          maxConcurrency
        );

        const nextNodes: string[] = [];

        for (const { nodeName, result, duration } of results) {
          if (result.state) {
            state = { ...state, ...result.state } as S;
          }

          nodeResults.set(nodeName, {
            output: result.output,
            duration,
          });

          completedNodes.add(nodeName);

          if (result.next) {
            const next = Array.isArray(result.next)
              ? result.next
              : [result.next];
            nextNodes.push(...next);
          } else {
            const edgeNext = this.scheduler.getNextNodes(
              workflow,
              nodeName,
              state
            );
            nextNodes.push(...edgeNext);
          }
        }

        if (shouldCheckpoint) {
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
        }

        currentNodes = [...new Set(nextNodes)];
      }

      if (iterations >= maxIterations) {
        error = new Error(
          `Workflow exceeded max iterations (${maxIterations.toString()})`
        );
      }
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
      options?.onNodeError?.(currentNodes[0] ?? 'unknown', error);
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
          Object.entries(checkpoint.nodeResults).map(([k, v]) => [
            k,
            { output: v, duration: 0 },
          ])
        ),
        duration: 0,
        checkpointId,
      };
    }

    return this.execute(workflow, checkpoint.state as Partial<S>, {
      ...options,
    });
  }

  /**
   * Stream workflow execution events
   */
  async *stream<S extends WorkflowState>(
    workflow: Workflow<S>,
    input?: Partial<S>,
    options?: Omit<WorkflowExecuteOptions, 'onNodeStart' | 'onNodeComplete' | 'onNodeError'>
  ): AsyncIterable<WorkflowEvent> {
    const events: WorkflowEvent[] = [];
    let resolveNext: (() => void) | null = null;

    const pushEvent = (event: WorkflowEvent) => {
      events.push(event);
      resolveNext?.();
    };

    const resultPromise = this.execute(workflow, input, {
      ...options,
      onNodeStart: (node) => {
        pushEvent({ type: 'node:start', node, timestamp: Date.now() });
      },
      onNodeComplete: (node, output, duration) => {
        pushEvent({ type: 'node:complete', node, output, duration });
      },
      onNodeError: (node, error) => {
        pushEvent({ type: 'node:error', node, error });
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
            type: 'workflow:complete',
            state: raceResult.result.state,
            duration: raceResult.result.duration,
          };

          break;
        }
      }
    }
  }
}
