import type { Workflow, WorkflowState, WorkflowResult } from '@cogitator-ai/types';
import {
  executeSubworkflow,
  type SubworkflowContext,
  type SubworkflowConfig,
  type SubworkflowResult,
  type SubworkflowErrorStrategy,
} from './subworkflow-node';

export interface ParallelSubworkflowDef<PS extends WorkflowState, CS extends WorkflowState> {
  id: string;
  config: SubworkflowConfig<PS, CS>;
}

/**
 * Child workflows run side by side. `CS` is the state of the children when
 * they share one, so mappers and results stay typed.
 */
export interface ParallelSubworkflowsConfig<
  S extends WorkflowState,
  CS extends WorkflowState = WorkflowState,
> {
  name: string;
  subworkflows: ParallelSubworkflowDef<S, CS>[] | ((state: S) => ParallelSubworkflowDef<S, CS>[]);
  concurrency?: number;
  continueOnError?: boolean;
  onError?: SubworkflowErrorStrategy;
  aggregator: (results: Map<string, SubworkflowResult<S, CS>>, parentState: S) => S;
  maxDepth?: number;
  shareCheckpoints?: boolean;
  onSubworkflowStart?: (id: string, config: SubworkflowConfig<S, CS>) => void;
  onSubworkflowComplete?: (id: string, result: SubworkflowResult<S, CS>) => void;
  onProgress?: (progress: ParallelProgress) => void;
}

export interface ParallelProgress {
  total: number;
  completed: number;
  successful: number;
  failed: number;
  pending: number;
  running: number;
}

export interface ParallelSubworkflowsResult<
  S extends WorkflowState,
  CS extends WorkflowState = WorkflowState,
> {
  success: boolean;
  parentState: S;
  results: Map<string, SubworkflowResult<S, CS>>;
  errors: Map<string, Error>;
  duration: number;
  stats: {
    total: number;
    successful: number;
    failed: number;
    skipped: number;
  };
}

async function executeWithConcurrency<T>(
  items: { id: string; execute: () => Promise<T> }[],
  concurrency: number,
  continueOnError: boolean,
  onComplete?: (id: string, result: T, error?: Error) => void
): Promise<Map<string, { result?: T; error?: Error }>> {
  const results = new Map<string, { result?: T; error?: Error }>();
  const pending: Promise<void>[] = [];
  let nextIndex = 0;
  let stopExecution = false;
  let firstError: Error | undefined;

  const executeNext = async (): Promise<void> => {
    if (stopExecution) return;

    const index = nextIndex++;
    if (index >= items.length) return;

    const item = items[index];

    try {
      const result = await item.execute();
      results.set(item.id, { result });
      onComplete?.(item.id, result);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      results.set(item.id, { error: err });

      if (!continueOnError) {
        stopExecution = true;
        if (!firstError) {
          firstError = err;
        }
        onComplete?.(item.id, undefined as T, err);
        return;
      }

      onComplete?.(item.id, undefined as T, err);
    }

    await executeNext();
  };

  const initialBatch = Math.min(concurrency, items.length);
  for (let i = 0; i < initialBatch; i++) {
    pending.push(executeNext());
  }

  await Promise.all(pending);

  if (firstError) {
    throw firstError;
  }

  return results;
}

export async function executeParallelSubworkflows<
  S extends WorkflowState,
  CS extends WorkflowState = WorkflowState,
>(
  parentState: S,
  config: ParallelSubworkflowsConfig<S, CS>,
  context: SubworkflowContext
): Promise<ParallelSubworkflowsResult<S, CS>> {
  const startTime = Date.now();

  const definitions =
    typeof config.subworkflows === 'function'
      ? config.subworkflows(parentState)
      : config.subworkflows;

  const concurrency = config.concurrency ?? Infinity;
  const continueOnError = config.continueOnError ?? false;
  const maxDepth = config.maxDepth ?? 10;

  let completed = 0;
  let successful = 0;
  let failed = 0;

  const emitProgress = () => {
    if (config.onProgress) {
      config.onProgress({
        total: definitions.length,
        completed,
        successful,
        failed,
        pending: definitions.length - completed,
        running: Math.min(concurrency, definitions.length - completed),
      });
    }
  };

  emitProgress();

  const executionItems = definitions.map((def) => ({
    id: def.id,
    execute: async (): Promise<SubworkflowResult<S, CS>> => {
      const subConfig = {
        ...def.config,
        onError: def.config.onError ?? config.onError,
        maxDepth: def.config.maxDepth ?? maxDepth,
        shareCheckpoints: def.config.shareCheckpoints ?? config.shareCheckpoints,
      };

      config.onSubworkflowStart?.(def.id, subConfig);

      const result = await executeSubworkflow(parentState, subConfig, {
        ...context,
        depth: context.depth + 1,
      });

      return result;
    },
  }));

  const rawResults = await executeWithConcurrency(
    executionItems,
    concurrency,
    continueOnError,
    (id, result, error) => {
      completed++;
      if (error) {
        failed++;
      } else if (result) {
        if (result.success) {
          successful++;
        } else {
          failed++;
        }
        config.onSubworkflowComplete?.(id, result);
      }
      emitProgress();
    }
  );

  const results = new Map<string, SubworkflowResult<S, CS>>();
  const errors = new Map<string, Error>();
  let skipped = 0;

  for (const [id, { result, error }] of rawResults) {
    if (error) {
      errors.set(id, error);
    } else if (result) {
      results.set(id, result);
      if (result.skipped) {
        skipped++;
      }
    }
  }

  const overallSuccess = failed === 0 || (continueOnError && successful > 0);

  const newParentState = overallSuccess ? config.aggregator(results, parentState) : parentState;

  return {
    success: overallSuccess,
    parentState: newParentState,
    results,
    errors,
    duration: Date.now() - startTime,
    stats: {
      total: definitions.length,
      successful,
      failed,
      skipped,
    },
  };
}

export function parallelSubworkflows<
  S extends WorkflowState,
  CS extends WorkflowState = WorkflowState,
>(
  name: string,
  config: Omit<ParallelSubworkflowsConfig<S, CS>, 'name'>
): ParallelSubworkflowsConfig<S, CS> {
  return { name, ...config };
}

export function fanOutFanIn<S extends WorkflowState, CS extends WorkflowState>(
  name: string,
  config: {
    workflow: Workflow<CS>;
    getInputs: (state: S) => { id: string; input: Partial<CS> }[];
    aggregator: (results: Map<string, WorkflowResult<CS>>, state: S) => S;
    concurrency?: number;
    continueOnError?: boolean;
  }
): ParallelSubworkflowsConfig<S, CS> {
  return {
    name,
    concurrency: config.concurrency,
    continueOnError: config.continueOnError,
    subworkflows: (state) =>
      config.getInputs(state).map(({ id, input }) => ({
        id,
        config: {
          name: `${name}:${id}`,
          workflow: config.workflow,
          inputMapper: () => input,
          outputMapper: (_result: WorkflowResult<CS>, parentState: S) => parentState,
        },
      })),
    aggregator: (results, state) => config.aggregator(childResults(results), state),
  };
}

export function scatterGather<S extends WorkflowState, CS extends WorkflowState>(
  name: string,
  config: {
    workflows: Map<string, Workflow<CS>>;
    inputMapper: (state: S, workflowId: string) => Partial<CS>;
    outputMapper: (results: Map<string, WorkflowResult<CS>>, state: S) => S;
    concurrency?: number;
    timeout?: number;
    continueOnError?: boolean;
  }
): ParallelSubworkflowsConfig<S, CS> {
  const subworkflows = [...config.workflows].map(
    ([id, workflow]): ParallelSubworkflowDef<S, CS> => ({
      id,
      config: {
        name: `${name}:${id}`,
        workflow,
        inputMapper: (state: S) => config.inputMapper(state, id),
        outputMapper: (_result: WorkflowResult<CS>, parentState: S) => parentState,
        timeout: config.timeout,
      },
    })
  );

  return {
    name,
    subworkflows,
    concurrency: config.concurrency,
    continueOnError: config.continueOnError ?? true,
    aggregator: (results, state) => config.outputMapper(childResults(results), state),
  };
}

/** The child workflow results of the subworkflows that ran. */
function childResults<S extends WorkflowState, CS extends WorkflowState>(
  results: Map<string, SubworkflowResult<S, CS>>
): Map<string, WorkflowResult<CS>> {
  const children = new Map<string, WorkflowResult<CS>>();
  for (const [id, result] of results) {
    if (result.childResult) children.set(id, result.childResult);
  }
  return children;
}

export async function raceSubworkflows<PS extends WorkflowState, CS extends WorkflowState>(
  parentState: PS,
  subworkflows: SubworkflowConfig<PS, CS>[],
  context: SubworkflowContext
): Promise<SubworkflowResult<PS, CS> | null> {
  const controller = new AbortController();
  const { signal } = controller;

  const promises = subworkflows.map(async (config) => {
    if (signal.aborted) {
      throw new Error('Race cancelled');
    }

    const result = await executeSubworkflow(parentState, config, {
      ...context,
      depth: context.depth + 1,
      signal,
    });

    if (signal.aborted) {
      throw new Error('Race cancelled');
    }

    if (result.success && !result.skipped) {
      controller.abort();
      return result;
    }

    throw new Error('Subworkflow did not succeed');
  });

  try {
    const result = await Promise.any(promises);
    return result;
  } catch {
    return null;
  }
}

export async function fallbackSubworkflows<PS extends WorkflowState, CS extends WorkflowState>(
  parentState: PS,
  subworkflows: SubworkflowConfig<PS, CS>[],
  context: SubworkflowContext
): Promise<SubworkflowResult<PS, CS>> {
  let lastResult: SubworkflowResult<PS, CS> | undefined;
  let lastError: Error | undefined;

  for (const config of subworkflows) {
    try {
      const result = await executeSubworkflow(parentState, config, {
        ...context,
        depth: context.depth + 1,
      });

      if (result.success && !result.skipped) {
        return result;
      }

      lastResult = result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (lastResult) {
    return lastResult;
  }

  throw lastError ?? new Error('All fallback subworkflows failed');
}
