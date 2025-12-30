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

    // Initialize state
    let state: S = { ...workflow.initialState, ...input } as S;
    const nodeResults = new Map<string, { output: unknown; duration: number }>();
    const completedNodes = new Set<string>();
    let iterations = 0;
    let checkpointId: string | undefined;
    let error: Error | undefined;

    // Build dependency graph
    const graph = this.scheduler.buildDependencyGraph(workflow);

    // Start with entry point
    let currentNodes = [workflow.entryPoint];

    try {
      while (currentNodes.length > 0 && iterations < maxIterations) {
        iterations++;

        // Filter out already completed nodes (for loops)
        const nodesToRun = currentNodes.filter((n) => {
          // For loops, we may need to re-run completed nodes
          // Only skip if not in a loop context
          return workflow.nodes.has(n);
        });

        if (nodesToRun.length === 0) break;

        // Execute current batch in parallel
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

          // Add output from previous nodes as input
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

          // Inject cogitator into context for agent nodes
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

        // Process results
        const nextNodes: string[] = [];

        for (const { nodeName, result, duration } of results) {
          // Update state with node's state changes
          if (result.state) {
            state = { ...state, ...result.state } as S;
          }

          // Store node result
          nodeResults.set(nodeName, {
            output: result.output,
            duration,
          });

          completedNodes.add(nodeName);

          // Determine next nodes
          if (result.next) {
            // Node explicitly specified next nodes
            const next = Array.isArray(result.next)
              ? result.next
              : [result.next];
            nextNodes.push(...next);
          } else {
            // Use edge-based routing
            const edgeNext = this.scheduler.getNextNodes(
              workflow,
              nodeName,
              state
            );
            nextNodes.push(...edgeNext);
          }
        }

        // Checkpoint if enabled
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

        // Deduplicate and set next batch
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

    // Find nodes that haven't been completed yet
    const allNodes = new Set(workflow.nodes.keys());
    const completed = new Set(checkpoint.completedNodes);
    const pending = [...allNodes].filter((n) => !completed.has(n));

    if (pending.length === 0) {
      // Workflow was already complete
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

    // Execute remaining nodes starting from checkpoint state
    return this.execute(workflow, checkpoint.state as Partial<S>, {
      ...options,
      // Could enhance to skip completed nodes, but for now just re-execute
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

    // Start execution in background
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

    // Yield events as they come
    while (true) {
      if (events.length > 0) {
        yield events.shift()!;
      } else {
        // Check if execution is complete
        const raceResult = await Promise.race([
          resultPromise.then((r) => ({ type: 'done' as const, result: r })),
          new Promise<{ type: 'event' }>((resolve) => {
            resolveNext = () => resolve({ type: 'event' });
          }),
        ]);

        if (raceResult.type === 'done') {
          // Yield remaining events
          while (events.length > 0) {
            yield events.shift()!;
          }

          // Yield completion event
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
