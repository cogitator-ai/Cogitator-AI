/**
 * Map-Reduce pattern implementation for workflows
 *
 * Features:
 * - Dynamic fan-out based on state
 * - Configurable concurrency limits
 * - Partial failure handling (continue with successful items)
 * - Progress tracking per item
 * - Streaming reduce (process as items complete)
 * - Nested map-reduce support
 */

/**
 * Item result wrapper
 */
export interface MapItemResult<T> {
  index: number;
  item: unknown;
  result: T;
  success: boolean;
  error?: Error;
  duration: number;
}

/**
 * Map progress event
 */
export interface MapProgressEvent<T> {
  total: number;
  completed: number;
  successful: number;
  failed: number;
  currentItem?: MapItemResult<T>;
  pending: number;
  running: number;
}

/**
 * Map node configuration
 */
export interface MapNodeConfig<S, T> {
  name: string;

  /**
   * Extract items to map over from state
   */
  items: (state: S) => unknown[];

  /**
   * Map function to apply to each item
   */
  mapper: (item: unknown, index: number, state: S) => Promise<T> | T;

  /**
   * Maximum concurrent mappers
   * @default Infinity
   */
  concurrency?: number;

  /**
   * Continue processing if some items fail
   * @default false
   */
  continueOnError?: boolean;

  /**
   * Progress callback
   */
  onProgress?: (progress: MapProgressEvent<T>) => void;

  /**
   * Filter items before mapping
   */
  filter?: (item: unknown, index: number, state: S) => boolean;

  /**
   * Transform items before mapping
   */
  transform?: (item: unknown, index: number, state: S) => unknown;

  /**
   * Timeout per item (ms)
   */
  timeout?: number;

  /**
   * Retry configuration per item
   */
  retry?: {
    maxAttempts: number;
    delay?: number;
    backoff?: 'linear' | 'exponential';
  };
}

/**
 * Reduce node configuration
 */
export interface ReduceNodeConfig<S, T, R> {
  name: string;

  /**
   * Initial accumulator value
   */
  initial: R | ((state: S) => R);

  /**
   * Reducer function
   */
  reducer: (accumulator: R, item: MapItemResult<T>, state: S) => R;

  /**
   * Process items as they complete (streaming)
   * @default false
   */
  streaming?: boolean;

  /**
   * Only include successful items in reduce
   * @default true
   */
  successOnly?: boolean;

  /**
   * Final transformation
   */
  finalize?: (result: R, state: S) => R;
}

/**
 * Map-Reduce result
 */
export interface MapReduceResult<T, R> {
  results: MapItemResult<T>[];
  reduced: R;
  stats: {
    total: number;
    successful: number;
    failed: number;
    duration: number;
    avgItemDuration: number;
  };
}

/**
 * Map-Reduce node configuration
 */
export interface MapReduceNodeConfig<S, T, R> {
  name: string;
  map: Omit<MapNodeConfig<S, T>, 'name'>;
  reduce: Omit<ReduceNodeConfig<S, T, R>, 'name'>;
}

/**
 * Execute items with concurrency limit
 */
async function executeWithConcurrency<T>(
  items: unknown[],
  mapper: (item: unknown, index: number) => Promise<MapItemResult<T>>,
  concurrency: number,
  onComplete?: (result: MapItemResult<T>) => void
): Promise<MapItemResult<T>[]> {
  const results: MapItemResult<T>[] = new Array(items.length);
  const pending: Promise<void>[] = [];
  let nextIndex = 0;

  const executeNext = async (): Promise<void> => {
    const index = nextIndex++;
    if (index >= items.length) return;

    const result = await mapper(items[index], index);
    results[index] = result;
    onComplete?.(result);

    // Continue with next item
    await executeNext();
  };

  // Start initial batch
  const initialBatch = Math.min(concurrency, items.length);
  for (let i = 0; i < initialBatch; i++) {
    pending.push(executeNext());
  }

  await Promise.all(pending);
  return results;
}

/**
 * Execute single item with timeout and retry
 */
async function executeItem<S, T>(
  item: unknown,
  index: number,
  state: S,
  config: MapNodeConfig<S, T>
): Promise<MapItemResult<T>> {
  const startTime = Date.now();
  let lastError: Error | undefined;
  const maxAttempts = config.retry?.maxAttempts ?? 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      let processedItem = item;

      // Apply transform if defined
      if (config.transform) {
        processedItem = config.transform(item, index, state);
      }

      // Execute with timeout if specified
      let resultPromise = Promise.resolve(config.mapper(processedItem, index, state));

      if (config.timeout) {
        resultPromise = Promise.race([
          resultPromise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Item timeout exceeded')), config.timeout)
          ),
        ]);
      }

      const result = await resultPromise;

      return {
        index,
        item,
        result,
        success: true,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Apply retry delay if not last attempt
      if (attempt < maxAttempts - 1 && config.retry) {
        const delay = config.retry.delay ?? 1000;
        const actualDelay =
          config.retry.backoff === 'exponential'
            ? delay * Math.pow(2, attempt)
            : delay * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, actualDelay));
      }
    }
  }

  return {
    index,
    item,
    result: undefined as T,
    success: false,
    error: lastError,
    duration: Date.now() - startTime,
  };
}

/**
 * Execute a map operation
 */
export async function executeMap<S, T>(
  state: S,
  config: MapNodeConfig<S, T>
): Promise<MapItemResult<T>[]> {
  // Extract items from state
  let items = config.items(state);

  // Apply filter if defined
  if (config.filter) {
    items = items.filter((item, index) => config.filter!(item, index, state));
  }

  const concurrency = config.concurrency ?? Infinity;
  const results: MapItemResult<T>[] = [];
  let completed = 0;
  let successful = 0;
  let failed = 0;

  const emitProgress = (current?: MapItemResult<T>) => {
    if (config.onProgress) {
      config.onProgress({
        total: items.length,
        completed,
        successful,
        failed,
        currentItem: current,
        pending: items.length - completed,
        running: Math.min(concurrency, items.length - completed),
      });
    }
  };

  // Emit initial progress
  emitProgress();

  const mapper = async (item: unknown, index: number): Promise<MapItemResult<T>> => {
    const result = await executeItem(item, index, state, config);

    completed++;
    if (result.success) {
      successful++;
    } else {
      failed++;
      if (!config.continueOnError) {
        throw result.error ?? new Error(`Item ${index} failed`);
      }
    }

    emitProgress(result);
    return result;
  };

  const allResults = await executeWithConcurrency(
    items,
    mapper,
    concurrency,
    (result) => results.push(result)
  );

  return allResults;
}

/**
 * Execute a reduce operation
 */
export function executeReduce<S, T, R>(
  results: MapItemResult<T>[],
  state: S,
  config: ReduceNodeConfig<S, T, R>
): R {
  // Get initial value
  const initial =
    typeof config.initial === 'function'
      ? (config.initial as (state: S) => R)(state)
      : config.initial;

  // Filter to successful items if required
  const items = config.successOnly !== false
    ? results.filter((r) => r.success)
    : results;

  // Apply reducer
  let result = items.reduce(
    (acc, item) => config.reducer(acc, item, state),
    initial
  );

  // Apply finalize if defined
  if (config.finalize) {
    result = config.finalize(result, state);
  }

  return result;
}

/**
 * Execute a map-reduce operation
 */
export async function executeMapReduce<S, T, R>(
  state: S,
  config: MapReduceNodeConfig<S, T, R>
): Promise<MapReduceResult<T, R>> {
  const startTime = Date.now();

  // Execute map phase
  const mapConfig: MapNodeConfig<S, T> = {
    name: `${config.name}:map`,
    ...config.map,
  };

  // For streaming reduce, we accumulate during map phase
  let streamingAccumulator: R | undefined;
  if (config.reduce.streaming) {
    streamingAccumulator =
      typeof config.reduce.initial === 'function'
        ? (config.reduce.initial as (state: S) => R)(state)
        : config.reduce.initial;

    const originalOnProgress = mapConfig.onProgress;
    mapConfig.onProgress = (progress) => {
      if (progress.currentItem && progress.currentItem.success) {
        const reduceConfig = {
          name: `${config.name}:reduce`,
          ...config.reduce,
        };

        if (reduceConfig.successOnly !== false || progress.currentItem.success) {
          streamingAccumulator = reduceConfig.reducer(
            streamingAccumulator!,
            progress.currentItem,
            state
          );
        }
      }
      originalOnProgress?.(progress);
    };
  }

  const results = await executeMap(state, mapConfig);

  // Execute reduce phase
  const reduceConfig: ReduceNodeConfig<S, T, R> = {
    name: `${config.name}:reduce`,
    ...config.reduce,
  };

  let reduced: R;
  if (config.reduce.streaming && streamingAccumulator !== undefined) {
    // Use streaming result
    reduced = streamingAccumulator;
    if (reduceConfig.finalize) {
      reduced = reduceConfig.finalize(reduced, state);
    }
  } else {
    // Normal batch reduce
    reduced = executeReduce(results, state, reduceConfig);
  }

  const duration = Date.now() - startTime;
  const successful = results.filter((r) => r.success).length;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  return {
    results,
    reduced,
    stats: {
      total: results.length,
      successful,
      failed: results.length - successful,
      duration,
      avgItemDuration: results.length > 0 ? totalDuration / results.length : 0,
    },
  };
}

/**
 * Create a map node factory
 */
export function mapNode<S, T>(
  name: string,
  config: Omit<MapNodeConfig<S, T>, 'name'>
): MapNodeConfig<S, T> {
  return { name, ...config };
}

/**
 * Create a reduce node factory
 */
export function reduceNode<S, T, R>(
  name: string,
  config: Omit<ReduceNodeConfig<S, T, R>, 'name'>
): ReduceNodeConfig<S, T, R> {
  return { name, ...config };
}

/**
 * Create a map-reduce node factory
 */
export function mapReduceNode<S, T, R>(
  name: string,
  config: Omit<MapReduceNodeConfig<S, T, R>, 'name'>
): MapReduceNodeConfig<S, T, R> {
  return { name, ...config };
}

/**
 * Parallel map helper - execute all items in parallel
 */
export async function parallelMap<S, T>(
  state: S,
  items: (state: S) => unknown[],
  mapper: (item: unknown, index: number, state: S) => Promise<T> | T,
  options: {
    continueOnError?: boolean;
    onProgress?: (progress: MapProgressEvent<T>) => void;
  } = {}
): Promise<MapItemResult<T>[]> {
  return executeMap(state, {
    name: 'parallelMap',
    items,
    mapper,
    concurrency: Infinity,
    ...options,
  });
}

/**
 * Sequential map helper - execute items one by one
 */
export async function sequentialMap<S, T>(
  state: S,
  items: (state: S) => unknown[],
  mapper: (item: unknown, index: number, state: S) => Promise<T> | T,
  options: {
    continueOnError?: boolean;
    onProgress?: (progress: MapProgressEvent<T>) => void;
  } = {}
): Promise<MapItemResult<T>[]> {
  return executeMap(state, {
    name: 'sequentialMap',
    items,
    mapper,
    concurrency: 1,
    ...options,
  });
}

/**
 * Batched map helper - process items in fixed-size batches
 */
export async function batchedMap<S, T>(
  state: S,
  items: (state: S) => unknown[],
  mapper: (item: unknown, index: number, state: S) => Promise<T> | T,
  batchSize: number,
  options: {
    continueOnError?: boolean;
    onProgress?: (progress: MapProgressEvent<T>) => void;
  } = {}
): Promise<MapItemResult<T>[]> {
  return executeMap(state, {
    name: 'batchedMap',
    items,
    mapper,
    concurrency: batchSize,
    ...options,
  });
}

/**
 * Collect helper - reduce results to an array
 */
export function collect<T>(): Omit<ReduceNodeConfig<unknown, T, T[]>, 'name'> {
  return {
    initial: [],
    reducer: (acc, item) => {
      acc.push(item.result);
      return acc;
    },
  };
}

/**
 * Sum helper - reduce numbers to sum
 */
export function sum(): Omit<ReduceNodeConfig<unknown, number, number>, 'name'> {
  return {
    initial: 0,
    reducer: (acc, item) => acc + item.result,
  };
}

/**
 * Count helper - count successful items
 */
export function count(): Omit<ReduceNodeConfig<unknown, unknown, number>, 'name'> {
  return {
    initial: 0,
    reducer: (acc) => acc + 1,
  };
}

/**
 * First helper - get first result
 */
export function first<T>(): Omit<ReduceNodeConfig<unknown, T, T | undefined>, 'name'> {
  return {
    initial: undefined,
    reducer: (acc, item) => acc ?? item.result,
  };
}

/**
 * Last helper - get last result
 */
export function last<T>(): Omit<ReduceNodeConfig<unknown, T, T | undefined>, 'name'> {
  return {
    initial: undefined,
    reducer: (_, item) => item.result,
  };
}

/**
 * GroupBy helper - group results by key
 */
export function groupBy<T, K extends string | number>(
  keyFn: (result: T, item: MapItemResult<T>) => K
): Omit<ReduceNodeConfig<unknown, T, Record<K, T[]>>, 'name'> {
  return {
    initial: {} as Record<K, T[]>,
    reducer: (acc, item) => {
      const key = keyFn(item.result, item);
      if (!acc[key]) {
        acc[key] = [];
      }
      acc[key].push(item.result);
      return acc;
    },
  };
}

/**
 * Partition helper - partition results by predicate
 */
export function partition<T>(
  predicate: (result: T, item: MapItemResult<T>) => boolean
): Omit<ReduceNodeConfig<unknown, T, { pass: T[]; fail: T[] }>, 'name'> {
  return {
    initial: { pass: [], fail: [] },
    reducer: (acc, item) => {
      if (predicate(item.result, item)) {
        acc.pass.push(item.result);
      } else {
        acc.fail.push(item.result);
      }
      return acc;
    },
  };
}

/**
 * FlatMap helper - flatten arrays of results
 */
export function flatMap<T>(): Omit<ReduceNodeConfig<unknown, T[], T[]>, 'name'> {
  return {
    initial: [],
    reducer: (acc, item) => {
      acc.push(...item.result);
      return acc;
    },
  };
}

/**
 * Stats helper - compute statistics from numeric results
 */
export function stats(): Omit<ReduceNodeConfig<unknown, number, {
  count: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
}>, 'name'> {
  return {
    initial: {
      count: 0,
      sum: 0,
      avg: 0,
      min: Infinity,
      max: -Infinity,
    },
    reducer: (acc, item) => {
      acc.count++;
      acc.sum += item.result;
      acc.min = Math.min(acc.min, item.result);
      acc.max = Math.max(acc.max, item.result);
      return acc;
    },
    finalize: (result) => ({
      ...result,
      avg: result.count > 0 ? result.sum / result.count : 0,
      min: result.count > 0 ? result.min : 0,
      max: result.count > 0 ? result.max : 0,
    }),
  };
}
