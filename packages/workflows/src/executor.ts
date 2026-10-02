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
  NodeConfig,
  CheckpointStrategy,
  NodeResult,
  WorkflowNode,
  RetryConfig,
  CircuitBreakerConfig,
  DeadLetterQueue,
  IdempotencyStore,
  ApprovalStore,
  ApprovalNotifier,
  TimerStore,
} from '@cogitator-ai/types';
import type { Cogitator } from '@cogitator-ai/core';
import { nanoid } from 'nanoid';
import { WorkflowScheduler } from './scheduler';
import { InMemoryCheckpointStore, createCheckpointId } from './checkpoint';
import type { ExtendedNodeContext } from './nodes/base';
import type { WorkflowTracer, SpanScope } from './observability/tracer';
import type { WorkflowMetricsCollector } from './observability/metrics';
import { computeRetryDelay } from './saga/retry';
import { CircuitBreaker } from './saga/circuit-breaker';
import { createDLQEntry } from './saga/dead-letter';

export interface ExecutorExecuteOptions extends WorkflowExecuteOptions {
  /** Abort the run; checked between steps and passed to nodes (`ctx.signal`) */
  signal?: AbortSignal;
  /** Emit a workflow span and one span per node execution */
  tracer?: WorkflowTracer;
  /** Record workflow and node executions */
  metricsCollector?: WorkflowMetricsCollector;
  /** Subworkflow nesting depth, exposed to nodes as `ctx.depth` */
  depth?: number;
  /** Retry policy for nodes without their own `config.retries` */
  defaultRetry?: RetryConfig;
  /** Circuit breaker per node name, shared across runs of this executor */
  defaultCircuitBreaker?: CircuitBreakerConfig;
  /** Receives an entry for every node that finally failed */
  deadLetterQueue?: DeadLetterQueue;
  /** Reuse results of nodes that already completed for the same workflow id and step */
  idempotencyStore?: IdempotencyStore;
  /** Defaults for human-in-the-loop nodes (`humanWorkflowNode`) */
  approvalStore?: ApprovalStore;
  approvalNotifier?: ApprovalNotifier;
  /** Default store for persisted timers (`timerWorkflowNode`) */
  timerStore?: TimerStore;
}

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

export class NodeTimeoutError extends Error {
  readonly nodeName: string;
  readonly timeoutMs: number;

  constructor(nodeName: string, timeoutMs: number) {
    super(`Node '${nodeName}' timed out after ${timeoutMs}ms`);
    this.name = 'NodeTimeoutError';
    this.nodeName = nodeName;
    this.timeoutMs = timeoutMs;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Run a node function once, enforcing `config.timeout` when set. A timed-out attempt
 * aborts `ctx.signal` so in-flight work (LLM requests, tool calls) is cancelled
 * instead of running on in the background.
 */
async function runNodeAttempt<S extends WorkflowState>(
  node: WorkflowNode<S>,
  ctx: ExtendedNodeContext<S>,
  timeout: number | undefined
): Promise<NodeResult<S>> {
  if (timeout === undefined || timeout <= 0) {
    return node.fn(ctx);
  }

  const runSignal = ctx.signal;
  const attempt = new AbortController();
  const forwardRunAbort = () => attempt.abort(runSignal?.reason);
  if (runSignal?.aborted) {
    forwardRunAbort();
  } else {
    runSignal?.addEventListener('abort', forwardRunAbort, { once: true });
  }

  const attemptCtx: ExtendedNodeContext<S> = { ...ctx, signal: attempt.signal };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      node.fn(attemptCtx),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new NodeTimeoutError(node.name, timeout);
          attempt.abort(error);
          reject(error);
        }, timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    runSignal?.removeEventListener('abort', forwardRunAbort);
  }
}

interface NodeRunPolicy {
  config: NodeConfig | undefined;
  defaultRetry: RetryConfig | undefined;
  breaker: CircuitBreaker | undefined;
  signal: AbortSignal | undefined;
}

function retryDelay(policy: NodeRunPolicy, attempt: number): number {
  if (policy.config?.retries !== undefined) {
    return policy.config.retryDelay ?? 0;
  }
  return policy.defaultRetry ? computeRetryDelay(attempt, policy.defaultRetry) : 0;
}

/**
 * Run a node honouring its `NodeConfig` (timeout per attempt, `retries` extra attempts
 * separated by `retryDelay` ms), falling back to the run's default retry policy and
 * circuit breaker. Returns the result and the number of retries used.
 */
async function runNodeWithPolicy<S extends WorkflowState>(
  node: WorkflowNode<S>,
  nodeName: string,
  makeContext: () => ExtendedNodeContext<S>,
  policy: NodeRunPolicy
): Promise<{ result: NodeResult<S>; retries: number }> {
  const maxRetries = Math.max(0, policy.config?.retries ?? policy.defaultRetry?.maxRetries ?? 0);
  const isRetryable =
    policy.config?.retries === undefined ? policy.defaultRetry?.isRetryable : undefined;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(retryDelay(policy, attempt), policy.signal);
    }
    if (policy.signal?.aborted) break;

    try {
      const runAttempt = () => runNodeAttempt(node, makeContext(), policy.config?.timeout);
      const result = policy.breaker
        ? await policy.breaker.execute(nodeName, runAttempt)
        : await runAttempt();
      return { result, retries: attempt };
    } catch (error) {
      lastError = error;
      const err = error instanceof Error ? error : new Error(String(error));
      if (err.name === 'CircuitBreakerOpenError') break;
      if (isRetryable && !isRetryable(err)) break;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(lastError === undefined ? 'Workflow execution aborted' : String(lastError));
}

export class WorkflowExecutor {
  private cogitator: Cogitator;
  private checkpointStore: CheckpointStore;
  private scheduler: WorkflowScheduler;
  private breakers = new WeakMap<CircuitBreakerConfig, CircuitBreaker>();

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
    options?: ExecutorExecuteOptions
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
    const reachability = this.scheduler.buildReachability(workflow);
    const tracer = options?.tracer;
    const metrics = options?.metricsCollector;
    const breaker = options?.defaultCircuitBreaker
      ? this.getBreaker(options.defaultCircuitBreaker)
      : undefined;
    const workflowSpan: SpanScope | undefined = tracer?.startWorkflowSpan(
      workflow.name,
      workflowId,
      workflowId
    );
    metrics?.recordWorkflowStart(workflow.name);

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

      const runNode = async () => {
        options?.onNodeStart?.(nodeName);
        const nodeSpan = tracer?.startNodeSpan(nodeName, 'node', { 'node.step': currentIteration });
        const nodeStart = Date.now();

        const deps = graph.dependencies.get(nodeName);
        let input: unknown;
        if (deps && deps.size > 0) {
          const inputs: unknown[] = [];
          for (const dep of deps) {
            const depResult = nodeResults.get(dep);
            if (depResult) {
              inputs.push(depResult.output);
            }
          }
          input = inputs.length === 1 ? inputs[0] : inputs;
        }

        const makeContext = (): ExtendedNodeContext<S> => {
          const ctx: ExtendedNodeContext<S> = {
            state: { ...state },
            nodeId: nodeName,
            workflowId,
            step: currentIteration,
            cogitator: this.cogitator,
            signal: options?.signal,
            depth: options?.depth ?? 0,
            approvalStore: options?.approvalStore,
            approvalNotifier: options?.approvalNotifier,
            timerStore: options?.timerStore,
            reportProgress: (progress: number) => {
              const clamped = Math.max(0, Math.min(100, progress));
              options?.onNodeProgress?.(nodeName, clamped);
            },
          };
          if (input !== undefined) ctx.input = input;
          return ctx;
        };

        const idempotencyKey = `workflow:${workflowId}:node:${nodeName}:step:${currentIteration}`;
        const idempotencyStore = options?.idempotencyStore;

        try {
          const cached = idempotencyStore
            ? await idempotencyStore.check(idempotencyKey)
            : undefined;
          const { result, retries } =
            cached?.isDuplicate && cached.record?.status === 'completed'
              ? { result: cached.record.result as NodeResult<S>, retries: 0 }
              : await runNodeWithPolicy(node, nodeName, makeContext, {
                  config: node.config,
                  defaultRetry: options?.defaultRetry,
                  breaker,
                  signal: options?.signal,
                });
          if (idempotencyStore && !cached?.isDuplicate) {
            await idempotencyStore.store(idempotencyKey, result);
          }
          const duration = Date.now() - nodeStart;

          nodeSpan?.setAttribute('node.retries', retries);
          nodeSpan?.end('ok');
          metrics?.recordNodeExecution(workflow.name, nodeName, 'node', duration, true, retries);
          options?.onNodeComplete?.(nodeName, result.output, duration);

          return { nodeName, result, duration };
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          nodeSpan?.recordException(err);
          nodeSpan?.end('error', err.message);
          metrics?.recordNodeExecution(
            workflow.name,
            nodeName,
            'node',
            Date.now() - nodeStart,
            false,
            node.config?.retries ?? options?.defaultRetry?.maxRetries ?? 0
          );
          if (options?.deadLetterQueue) {
            await options.deadLetterQueue
              .add(
                createDLQEntry(nodeName, workflowId, workflow.name, state, err, {
                  input,
                  attempts: 1 + (node.config?.retries ?? options.defaultRetry?.maxRetries ?? 0),
                })
              )
              .catch((dlqError: unknown) => {
                console.warn('[WorkflowExecutor] Failed to write dead letter entry:', dlqError);
              });
          }
          throw new NodeExecutionError(nodeName, err);
        }
      };

      return tracer ? tracer.runInContext(runNode) : runNode();
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
        if (options?.signal?.aborted) {
          error = new Error('Workflow execution aborted');
          break;
        }

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

        const { runnable, deferred } = this.scheduler.splitFrontier(
          [...new Set(nodesToRun)],
          reachability
        );

        const tasks = runnable.map((nodeName) => createTask(nodeName, iterations));
        const nextNodes: string[] = [...deferred];

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

      if (!error && iterations >= maxIterations && currentNodes.length > 0) {
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

    const duration = Date.now() - startTime;
    const aborted = options?.signal?.aborted === true;

    if (workflowSpan) {
      if (error) {
        workflowSpan.recordException(error);
        workflowSpan.end('error', error.message);
      } else {
        workflowSpan.end('ok');
      }
    }
    metrics?.recordWorkflowComplete(
      workflow.name,
      duration,
      error ? (aborted ? 'cancelled' : 'failure') : 'success'
    );

    return {
      workflowId,
      workflowName: workflow.name,
      state,
      nodeResults,
      duration,
      checkpointId,
      error,
    };
  }

  private getBreaker(config: CircuitBreakerConfig): CircuitBreaker {
    let breaker = this.breakers.get(config);
    if (!breaker) {
      breaker = new CircuitBreaker(config);
      this.breakers.set(config, breaker);
    }
    return breaker;
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
    const workflowId = options?.workflowId ?? `wf_${nanoid(12)}`;
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
