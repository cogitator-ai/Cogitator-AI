import type {
  Workflow,
  WorkflowState,
  WorkflowExecuteOptionsV2,
  WorkflowResult,
  CheckpointStore,
} from '@cogitator-ai/types';
import type { Cogitator } from '@cogitator-ai/core';
import { WorkflowExecutor } from '../executor';

export type SubworkflowErrorStrategy = 'propagate' | 'catch' | 'retry' | 'ignore';

export interface SubworkflowRetryConfig {
  maxAttempts: number;
  delay?: number;
  backoff?: 'linear' | 'exponential';
}

export interface SubworkflowConfig<PS extends WorkflowState, CS extends WorkflowState> {
  name: string;
  workflow: Workflow<CS>;
  inputMapper: (parentState: PS, context: SubworkflowContext) => Partial<CS>;
  outputMapper: (
    childResult: WorkflowResult<CS>,
    parentState: PS,
    context: SubworkflowContext
  ) => PS;
  onError?: SubworkflowErrorStrategy;
  retryConfig?: SubworkflowRetryConfig;
  maxDepth?: number;
  timeout?: number;
  shareCheckpoints?: boolean;
  onStart?: (childState: Partial<CS>, context: SubworkflowContext) => void;
  onComplete?: (result: WorkflowResult<CS>, context: SubworkflowContext) => void;
  onChildError?: (error: Error, context: SubworkflowContext) => void;
  condition?: (parentState: PS, context: SubworkflowContext) => boolean;
}

export interface SubworkflowContext {
  cogitator: Cogitator;
  parentWorkflowId: string;
  parentRunId: string;
  parentNodeId: string;
  depth: number;
  checkpointStore?: CheckpointStore;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface SubworkflowResult<PS extends WorkflowState, CS extends WorkflowState> {
  success: boolean;
  parentState: PS;
  childResult?: WorkflowResult<CS>;
  error?: Error;
  skipped: boolean;
  duration: number;
  depth: number;
}

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

const DEFAULT_RETRY_CONFIG: SubworkflowRetryConfig = { maxAttempts: 3, delay: 1000 };

export async function executeSubworkflow<PS extends WorkflowState, CS extends WorkflowState>(
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

  const retryConfig =
    config.onError === 'retry' ? (config.retryConfig ?? DEFAULT_RETRY_CONFIG) : config.retryConfig;
  const maxAttempts = retryConfig?.maxAttempts ?? 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (context.signal?.aborted) {
      lastError = new Error('Subworkflow aborted');
      break;
    }

    try {
      const executePromise = executor.execute(config.workflow, childInput, executeOptions);

      if (config.timeout) {
        let timer: ReturnType<typeof setTimeout>;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Subworkflow timeout exceeded')),
            config.timeout
          );
        });
        try {
          childResult = await Promise.race([executePromise, timeoutPromise]);
        } finally {
          clearTimeout(timer!);
        }
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

      if (attempt < maxAttempts - 1 && retryConfig) {
        const delay = retryConfig.delay ?? 1000;
        const actualDelay =
          retryConfig.backoff === 'exponential'
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

export function subworkflowNode<PS extends WorkflowState, CS extends WorkflowState>(
  name: string,
  config: Omit<SubworkflowConfig<PS, CS>, 'name'>
): SubworkflowConfig<PS, CS> {
  return { name, ...config };
}

export function simpleSubworkflow<S extends WorkflowState>(
  name: string,
  workflow: Workflow<S>,
  options: Partial<
    Omit<SubworkflowConfig<S, S>, 'name' | 'workflow' | 'inputMapper' | 'outputMapper'>
  > = {}
): SubworkflowConfig<S, S> {
  return {
    name,
    workflow,
    inputMapper: (state) => state,
    outputMapper: (result) => result.state,
    ...options,
  };
}

export function nestedSubworkflow<
  PS extends WorkflowState,
  K extends keyof PS,
  CS extends WorkflowState = PS[K] extends WorkflowState ? PS[K] : never,
>(
  name: string,
  workflow: Workflow<CS>,
  stateKey: K,
  options: Partial<
    Omit<SubworkflowConfig<PS, CS>, 'name' | 'workflow' | 'inputMapper' | 'outputMapper'>
  > = {}
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

export function conditionalSubworkflow<PS extends WorkflowState, CS extends WorkflowState>(
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
