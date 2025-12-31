/**
 * Subworkflow node implementation
 *
 * Features:
 * - State mapping parent ↔ child
 * - Error propagation strategies
 * - Recursive workflows with depth limits
 * - Shared checkpoints
 * - Timeout support
 */

import type {
  Workflow,
  WorkflowState,
  WorkflowExecuteOptionsV2,
  WorkflowResult,
  CheckpointStore,
} from '@cogitator-ai/types';
import type { Cogitator } from '@cogitator-ai/core';
import { WorkflowExecutor } from '../executor';

/**
 * Error handling strategy for subworkflows
 */
export type SubworkflowErrorStrategy =
  | 'propagate'
  | 'catch'
  | 'retry'
  | 'ignore';

/**
 * Subworkflow retry configuration
 */
export interface SubworkflowRetryConfig {
  maxAttempts: number;
  delay?: number;
  backoff?: 'linear' | 'exponential';
}

/**
 * Subworkflow configuration
 */
export interface SubworkflowConfig<PS extends WorkflowState, CS extends WorkflowState> {
  name: string;

  /**
   * The child workflow to execute
   */
  workflow: Workflow<CS>;

  /**
   * Map parent state to child initial state
   */
  inputMapper: (parentState: PS, context: SubworkflowContext) => Partial<CS>;

  /**
   * Map child result back to parent state
   */
  outputMapper: (childResult: WorkflowResult<CS>, parentState: PS, context: SubworkflowContext) => PS;

  /**
   * Error handling strategy
   * @default 'propagate'
   */
  onError?: SubworkflowErrorStrategy;

  /**
   * Retry config when onError is 'retry'
   */
  retryConfig?: SubworkflowRetryConfig;

  /**
   * Maximum nesting depth
   * @default 10
   */
  maxDepth?: number;

  /**
   * Timeout for subworkflow execution (ms)
   */
  timeout?: number;

  /**
   * Share checkpoint store with parent
   * @default true
   */
  shareCheckpoints?: boolean;

  /**
   * Called before subworkflow starts
   */
  onStart?: (childState: Partial<CS>, context: SubworkflowContext) => void;

  /**
   * Called after subworkflow completes
   */
  onComplete?: (result: WorkflowResult<CS>, context: SubworkflowContext) => void;

  /**
   * Called on subworkflow error
   */
  onChildError?: (error: Error, context: SubworkflowContext) => void;

  /**
   * Condition to run subworkflow
   */
  condition?: (parentState: PS, context: SubworkflowContext) => boolean;
}

/**
 * Subworkflow execution context
 */
export interface SubworkflowContext {
  cogitator: Cogitator;
  parentWorkflowId: string;
  parentRunId: string;
  parentNodeId: string;
  depth: number;
  checkpointStore?: CheckpointStore;
  metadata?: Record<string, unknown>;
}

/**
 * Subworkflow result
 */
export interface SubworkflowResult<PS extends WorkflowState, CS extends WorkflowState> {
  success: boolean;
  parentState: PS;
  childResult?: WorkflowResult<CS>;
  error?: Error;
  skipped: boolean;
  duration: number;
  depth: number;
}

/**
 * Error thrown when max depth is exceeded
 */
export class MaxDepthExceededError extends Error {
  readonly depth: number;
  readonly maxDepth: number;

  constructor(depth: number, maxDepth: number) {
    super(`Maximum subworkflow depth exceeded: ${depth} > ${maxDepth}`);
    this.name = 'MaxDepthExceededError';
    this.depth = depth;
    this.maxDepth = maxDepth;
  }
}

/**
 * Execute a subworkflow
 */
export async function executeSubworkflow<
  PS extends WorkflowState,
  CS extends WorkflowState
>(
  parentState: PS,
  config: SubworkflowConfig<PS, CS>,
  context: SubworkflowContext
): Promise<SubworkflowResult<PS, CS>> {
  const startTime = Date.now();
  const maxDepth = config.maxDepth ?? 10;

  if (context.depth > maxDepth) {
    throw new MaxDepthExceededError(context.depth, maxDepth);
  }

  if (config.condition && !config.condition(parentState, context)) {
    return {
      success: true,
      parentState,
      skipped: true,
      duration: Date.now() - startTime,
      depth: context.depth,
    };
  }

  const childInput = config.inputMapper(parentState, context);

  config.onStart?.(childInput, context);

  const executor = new WorkflowExecutor(
    context.cogitator,
    config.shareCheckpoints !== false ? context.checkpointStore : undefined
  );

  const executeOptions: WorkflowExecuteOptionsV2 = {
    checkpoint: config.shareCheckpoints !== false && !!context.checkpointStore,
    metadata: {
      ...context.metadata,
      parentWorkflowId: context.parentWorkflowId,
      parentRunId: context.parentRunId,
      parentNodeId: context.parentNodeId,
      depth: context.depth,
    },
  };

  let lastError: Error | undefined;
  let childResult: WorkflowResult<CS> | undefined;
  const maxAttempts =
    config.onError === 'retry' && config.retryConfig
      ? config.retryConfig.maxAttempts
      : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const executePromise = executor.execute(config.workflow, childInput, executeOptions);

      if (config.timeout) {
        childResult = await Promise.race([
          executePromise,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('Subworkflow timeout exceeded')),
              config.timeout
            )
          ),
        ]);
      } else {
        childResult = await executePromise;
      }

      config.onComplete?.(childResult, context);

      const newParentState = config.outputMapper(childResult, parentState, context);

      return {
        success: true,
        parentState: newParentState,
        childResult,
        skipped: false,
        duration: Date.now() - startTime,
        depth: context.depth,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      config.onChildError?.(lastError, context);

      if (attempt < maxAttempts - 1 && config.retryConfig) {
        const delay = config.retryConfig.delay ?? 1000;
        const actualDelay =
          config.retryConfig.backoff === 'exponential'
            ? delay * Math.pow(2, attempt)
            : delay * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, actualDelay));
      }
    }
  }

  switch (config.onError) {
    case 'ignore':
      return {
        success: true,
        parentState,
        error: lastError,
        skipped: false,
        duration: Date.now() - startTime,
        depth: context.depth,
      };

    case 'catch':
      return {
        success: false,
        parentState,
        error: lastError,
        skipped: false,
        duration: Date.now() - startTime,
        depth: context.depth,
      };

    case 'propagate':
    case 'retry':
    default:
      throw lastError;
  }
}

/**
 * Create a subworkflow node factory
 */
export function subworkflowNode<
  PS extends WorkflowState,
  CS extends WorkflowState
>(
  name: string,
  config: Omit<SubworkflowConfig<PS, CS>, 'name'>
): SubworkflowConfig<PS, CS> {
  return { name, ...config };
}

/**
 * Create a simple subworkflow that just passes state through
 */
export function simpleSubworkflow<S extends WorkflowState>(
  name: string,
  workflow: Workflow<S>,
  options: Partial<Omit<SubworkflowConfig<S, S>, 'name' | 'workflow' | 'inputMapper' | 'outputMapper'>> = {}
): SubworkflowConfig<S, S> {
  return {
    name,
    workflow,
    inputMapper: (state) => state,
    outputMapper: (result) => result.state,
    ...options,
  };
}

/**
 * Create a subworkflow that extracts a subset of parent state
 */
export function nestedSubworkflow<
  PS extends WorkflowState,
  K extends keyof PS,
  CS extends WorkflowState = PS[K] extends WorkflowState ? PS[K] : never
>(
  name: string,
  workflow: Workflow<CS>,
  stateKey: K,
  options: Partial<Omit<SubworkflowConfig<PS, CS>, 'name' | 'workflow' | 'inputMapper' | 'outputMapper'>> = {}
): SubworkflowConfig<PS, CS> {
  return {
    name,
    workflow,
    inputMapper: (state) => state[stateKey] as unknown as Partial<CS>,
    outputMapper: (result, parentState) => ({
      ...parentState,
      [stateKey]: result.state,
    }),
    ...options,
  };
}

/**
 * Create a conditional subworkflow
 */
export function conditionalSubworkflow<
  PS extends WorkflowState,
  CS extends WorkflowState
>(
  name: string,
  config: Omit<SubworkflowConfig<PS, CS>, 'name'> & {
    condition: (state: PS) => boolean;
  }
): SubworkflowConfig<PS, CS> {
  return {
    ...config,
    name,
    condition: (state) => config.condition(state),
  };
}
