/**
 * Parallel subworkflow execution
 *
 * Features:
 * - Execute multiple subworkflows in parallel
 * - Configurable concurrency
 * - Aggregate results
 * - Partial failure handling
 */

import type {
  Workflow,
  WorkflowState,
  WorkflowResult,
} from '@cogitator/types';
import {
  executeSubworkflow,
  type SubworkflowContext,
  type SubworkflowConfig,
  type SubworkflowResult,
  type SubworkflowErrorStrategy,
} from './subworkflow-node.js';

/**
 * Parallel subworkflow definition
 */
export interface ParallelSubworkflowDef<PS extends WorkflowState, CS extends WorkflowState> {
  id: string;
  config: SubworkflowConfig<PS, CS>;
}

/**
 * Parallel subworkflows configuration
 */
export interface ParallelSubworkflowsConfig<S extends WorkflowState> {
  name: string;

  /**
   * Get subworkflow definitions to execute
   */
  subworkflows:
    | ParallelSubworkflowDef<S, WorkflowState>[]
    | ((state: S) => ParallelSubworkflowDef<S, WorkflowState>[]);

  /**
   * Maximum concurrent subworkflows
   * @default Infinity
   */
  concurrency?: number;

  /**
   * Continue if some subworkflows fail
   * @default false
   */
  continueOnError?: boolean;

  /**
   * Error handling strategy for all subworkflows
   */
  onError?: SubworkflowErrorStrategy;

  /**
   * Aggregate results into parent state
   */
  aggregator: (
    results: Map<string, SubworkflowResult<S, WorkflowState>>,
    parentState: S
  ) => S;

  /**
   * Maximum nesting depth for all subworkflows
   * @default 10
   */
  maxDepth?: number;

  /**
   * Share checkpoint store with parent
   * @default true
   */
  shareCheckpoints?: boolean;

  /**
   * Called when a subworkflow starts
   */
  onSubworkflowStart?: (id: string, config: SubworkflowConfig<S, WorkflowState>) => void;

  /**
   * Called when a subworkflow completes
   */
  onSubworkflowComplete?: (id: string, result: SubworkflowResult<S, WorkflowState>) => void;

  /**
   * Called on progress
   */
  onProgress?: (progress: ParallelProgress) => void;
}

/**
 * Progress event for parallel execution
 */
export interface ParallelProgress {
  total: number;
  completed: number;
  successful: number;
  failed: number;
  pending: number;
  running: number;
}

/**
 * Parallel subworkflows result
 */
export interface ParallelSubworkflowsResult<S extends WorkflowState> {
  success: boolean;
  parentState: S;
  results: Map<string, SubworkflowResult<S, WorkflowState>>;
  errors: Map<string, Error>;
  duration: number;
  stats: {
    total: number;
    successful: number;
    failed: number;
    skipped: number;
  };
}

/**
 * Execute subworkflows with concurrency limit
 */
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
        throw err;
      }

      onComplete?.(item.id, undefined as T, err);
    }

    // Continue with next item
    await executeNext();
  };

  // Start initial batch
  const initialBatch = Math.min(concurrency, items.length);
  for (let i = 0; i < initialBatch; i++) {
    pending.push(executeNext());
  }

  try {
    await Promise.all(pending);
  } catch {
    // Error already handled
  }

  return results;
}

/**
 * Execute multiple subworkflows in parallel
 */
export async function executeParallelSubworkflows<S extends WorkflowState>(
  parentState: S,
  config: ParallelSubworkflowsConfig<S>,
  context: SubworkflowContext
): Promise<ParallelSubworkflowsResult<S>> {
  const startTime = Date.now();

  // Get subworkflow definitions
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

  // Emit initial progress
  emitProgress();

  // Prepare execution items
  const executionItems = definitions.map((def) => ({
    id: def.id,
    execute: async (): Promise<SubworkflowResult<S, WorkflowState>> => {
      const subConfig = {
        ...def.config,
        onError: def.config.onError ?? config.onError,
        maxDepth: def.config.maxDepth ?? maxDepth,
        shareCheckpoints: def.config.shareCheckpoints ?? config.shareCheckpoints,
      };

      config.onSubworkflowStart?.(def.id, subConfig);

      const result = await executeSubworkflow(
        parentState,
        subConfig,
        {
          ...context,
          depth: context.depth + 1,
        }
      );

      return result;
    },
  }));

  // Execute with concurrency
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

  // Process results
  const results = new Map<string, SubworkflowResult<S, WorkflowState>>();
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

  // Check overall success
  const overallSuccess = failed === 0 || continueOnError;

  // Aggregate results into parent state
  const newParentState = overallSuccess
    ? config.aggregator(results, parentState)
    : parentState;

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

/**
 * Create a parallel subworkflows node factory
 */
export function parallelSubworkflows<S extends WorkflowState>(
  name: string,
  config: Omit<ParallelSubworkflowsConfig<S>, 'name'>
): ParallelSubworkflowsConfig<S> {
  return { name, ...config };
}

/**
 * Create a fan-out/fan-in pattern
 * Fans out to multiple identical subworkflows with different inputs
 */
export function fanOutFanIn<S extends WorkflowState, CS extends WorkflowState>(
  name: string,
  config: {
    workflow: Workflow<CS>;
    getInputs: (state: S) => { id: string; input: Partial<CS> }[];
    aggregator: (results: Map<string, WorkflowResult<CS>>, state: S) => S;
    concurrency?: number;
    continueOnError?: boolean;
  }
): ParallelSubworkflowsConfig<S> {
  return {
    name,
    concurrency: config.concurrency,
    continueOnError: config.continueOnError,
    subworkflows: (state) =>
      config.getInputs(state).map(({ id, input }) => ({
        id,
        config: {
          name: `${name}:${id}`,
          workflow: config.workflow as unknown as Workflow<WorkflowState>,
          inputMapper: () => input as Partial<WorkflowState>,
          outputMapper: (_result: WorkflowResult<WorkflowState>, parentState: S) => parentState,
        },
      })),
    aggregator: (results, state) => {
      const workflowResults = new Map<string, WorkflowResult<CS>>();
      for (const [id, result] of results) {
        if (result.childResult) {
          workflowResults.set(id, result.childResult as WorkflowResult<CS>);
        }
      }
      return config.aggregator(workflowResults, state);
    },
  };
}

/**
 * Create a scatter-gather pattern
 * Scatters work across multiple workflows and gathers results
 */
export function scatterGather<S extends WorkflowState, CS extends WorkflowState>(
  name: string,
  config: {
    workflows: Map<string, Workflow<CS>>;
    inputMapper: (state: S, workflowId: string) => Partial<CS>;
    outputMapper: (results: Map<string, WorkflowResult<CS>>, state: S) => S;
    concurrency?: number;
    timeout?: number;
  }
): ParallelSubworkflowsConfig<S> {
  const subworkflows: ParallelSubworkflowDef<S, WorkflowState>[] = [];

  for (const [id, workflow] of config.workflows) {
    subworkflows.push({
      id,
      config: {
        name: `${name}:${id}`,
        workflow: workflow as unknown as Workflow<WorkflowState>,
        inputMapper: (state: S) => config.inputMapper(state, id) as Partial<WorkflowState>,
        outputMapper: (_result: WorkflowResult<WorkflowState>, parentState: S) => parentState,
        timeout: config.timeout,
      },
    });
  }

  return {
    name,
    subworkflows,
    concurrency: config.concurrency,
    continueOnError: true,
    aggregator: (results, state) => {
      const workflowResults = new Map<string, WorkflowResult<CS>>();
      for (const [id, result] of results) {
        if (result.childResult) {
          workflowResults.set(id, result.childResult as WorkflowResult<CS>);
        }
      }
      return config.outputMapper(workflowResults, state);
    },
  };
}

/**
 * Create a race pattern
 * Executes multiple subworkflows and returns the first successful result
 */
export async function raceSubworkflows<
  PS extends WorkflowState,
  CS extends WorkflowState
>(
  parentState: PS,
  subworkflows: SubworkflowConfig<PS, CS>[],
  context: SubworkflowContext
): Promise<SubworkflowResult<PS, CS> | null> {
  const controller = new AbortController();
  const { signal } = controller;

  const promises = subworkflows.map(async (config) => {
    // Check if aborted before starting
    if (signal.aborted) {
      throw new Error('Race cancelled');
    }

    const result = await executeSubworkflow(parentState, config, {
      ...context,
      depth: context.depth + 1,
    });

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
    // All failed
    return null;
  }
}

/**
 * Create a fallback pattern
 * Tries subworkflows in order until one succeeds
 */
export async function fallbackSubworkflows<
  PS extends WorkflowState,
  CS extends WorkflowState
>(
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

  // Return last result or throw last error
  if (lastResult) {
    return lastResult;
  }

  throw lastError ?? new Error('All fallback subworkflows failed');
}
