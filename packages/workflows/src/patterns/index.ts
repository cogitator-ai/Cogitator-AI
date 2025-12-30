/**
 * @cogitator/workflows - Patterns module
 *
 * Advanced workflow patterns for complex data processing.
 *
 * Features:
 * - Map-Reduce pattern for parallel processing
 * - Dynamic fan-out based on state
 * - Configurable concurrency limits
 * - Partial failure handling
 * - Progress tracking
 * - Streaming reduce
 */

export {
  // Types
  type MapItemResult,
  type MapProgressEvent,
  type MapNodeConfig,
  type ReduceNodeConfig,
  type MapReduceResult,
  type MapReduceNodeConfig,

  // Core functions
  executeMap,
  executeReduce,
  executeMapReduce,

  // Node factories
  mapNode,
  reduceNode,
  mapReduceNode,

  // Helpers
  parallelMap,
  sequentialMap,
  batchedMap,

  // Reducer helpers
  collect,
  sum,
  count,
  first,
  last,
  groupBy,
  partition,
  flatMap,
  stats,
} from './map-reduce.js';
