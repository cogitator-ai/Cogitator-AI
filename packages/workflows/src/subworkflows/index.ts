/**
 * @cogitator-ai/workflows - Subworkflows module
 *
 * Enables nested and parallel workflow execution.
 *
 * Features:
 * - Single subworkflow execution
 * - Parallel subworkflows with concurrency control
 * - State mapping between parent and child
 * - Error handling strategies
 * - Depth limits to prevent infinite recursion
 * - Race and fallback patterns
 */

export {
  type SubworkflowErrorStrategy,
  type SubworkflowRetryConfig,
  type SubworkflowConfig,
  type SubworkflowContext,
  type SubworkflowResult,
  MaxDepthExceededError,
  executeSubworkflow,
  subworkflowNode,
  simpleSubworkflow,
  nestedSubworkflow,
  conditionalSubworkflow,
} from './subworkflow-node';

export {
  type ParallelSubworkflowDef,
  type ParallelSubworkflowsConfig,
  type ParallelProgress,
  type ParallelSubworkflowsResult,
  executeParallelSubworkflows,
  parallelSubworkflows,
  fanOutFanIn,
  scatterGather,
  raceSubworkflows,
  fallbackSubworkflows,
} from './parallel-subworkflows';
