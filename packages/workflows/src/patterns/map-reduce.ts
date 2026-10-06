export interface MapItemResult<T> {
  index: number;
  item: unknown;
  result: T;
  success: boolean;
  error?: Error;
  duration: number;
}

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
 * What a mapper gets besides the item: the signal to stop on and which attempt this is.
 */
export interface MapItemContext {
  /**
   * Aborted when this attempt times out, another item fails the map (without
   * `continueOnError`), or the workflow run is cancelled or paused. Pass it on to agent runs,
   * fetches and tools so their work stops too
   */
  signal: AbortSignal;
  /** 1 for the first attempt, 2 for the first retry, ... */
  attempt: number;
}

export interface MapNodeConfig<S, T> {
  name: string;
  items: (state: S) => unknown[];
  mapper: (item: unknown, index: number, state: S, ctx: MapItemContext) => Promise<T> | T;
  concurrency?: number;
  /**
   * Keep mapping when an item fails: failed items appear in the results with `success: false`.
   * Without it the first failure stops the map: no further item starts, items in flight are
   * aborted, and the map rejects with that failure
   */
  continueOnError?: boolean;
  onProgress?: (progress: MapProgressEvent<T>) => void;
  filter?: (item: unknown, index: number, state: S) => boolean;
  transform?: (item: unknown, index: number, state: S) => unknown;
  /** Time limit of one attempt in ms: a late attempt is aborted (`ctx.signal`) and fails */
  timeout?: number;
  retry?: {
    maxAttempts: number;
    delay?: number;
    backoff?: 'linear' | 'exponential';
  };
}

/** Options of a map run. */
export interface MapExecutionOptions {
  /** Cancels the map: no further item starts and the items in flight are aborted */
  signal?: AbortSignal;
}

/**
 * Result error of an item that never ran because the map stopped first: another item failed
 * or the run was cancelled. `cause` is what stopped the map.
 */
export class MapItemSkippedError extends Error {
  readonly index: number;

  constructor(index: number, cause: Error) {
    super(`Item ${index} was not mapped: ${cause.message}`, { cause });
    this.name = 'MapItemSkippedError';
    this.index = index;
  }
}

/** An attempt of an item that ran past the map's `timeout`. */
export class MapItemTimeoutError extends Error {
  readonly index: number;
  readonly timeoutMs: number;

  constructor(index: number, timeoutMs: number) {
    super(`Item ${index} timed out after ${timeoutMs}ms`);
    this.name = 'MapItemTimeoutError';
    this.index = index;
    this.timeoutMs = timeoutMs;
  }
}

export interface ReduceNodeConfig<S, T, R> {
  name: string;
  initial: R | ((state: S) => R);
  reducer: (accumulator: R, item: MapItemResult<T>, state: S) => R;
  streaming?: boolean;
  successOnly?: boolean;
  finalize?: (result: R, state: S) => R;
}

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

export interface MapReduceNodeConfig<S, T, R> {
  name: string;
  map: Omit<MapNodeConfig<S, T>, 'name'>;
  reduce: Omit<ReduceNodeConfig<S, T, R>, 'name'>;
}

function toError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(value === undefined ? fallback : String(value));
}

/** Resolve after `ms`, or reject with the signal's reason once it aborts. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(toError(signal.reason, 'Map aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(toError(signal.reason, 'Map aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Settle with `work`, or reject as soon as `signal` aborts. A mapper that ignores its signal
 * keeps running detached, but the map does not wait for it.
 */
function raceWithSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(toError(signal.reason, 'Map aborted'));
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(toError(error, 'Map item failed'));
      }
    );
  });
}

async function runAttempt<S, T>(
  item: unknown,
  index: number,
  state: S,
  config: MapNodeConfig<S, T>,
  attempt: number,
  mapSignal: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  const forward = () => controller.abort(mapSignal.reason);
  mapSignal.addEventListener('abort', forward, { once: true });
  const timer =
    config.timeout !== undefined && config.timeout > 0
      ? setTimeout(
          () => controller.abort(new MapItemTimeoutError(index, config.timeout!)),
          config.timeout
        )
      : undefined;

  try {
    const work = Promise.resolve().then(() => {
      const processed = config.transform ? config.transform(item, index, state) : item;
      return config.mapper(processed, index, state, { signal: controller.signal, attempt });
    });
    return await raceWithSignal(work, controller.signal);
  } finally {
    if (timer) clearTimeout(timer);
    mapSignal.removeEventListener('abort', forward);
  }
}

async function executeItem<S, T>(
  item: unknown,
  index: number,
  state: S,
  config: MapNodeConfig<S, T>,
  mapSignal: AbortSignal
): Promise<MapItemResult<T>> {
  const startTime = Date.now();
  let lastError: Error | undefined;
  const maxAttempts = Math.max(1, config.retry?.maxAttempts ?? 1);

  for (let attempt = 1; attempt <= maxAttempts && !mapSignal.aborted; attempt++) {
    try {
      const result = await runAttempt(item, index, state, config, attempt, mapSignal);
      return { index, item, result, success: true, duration: Date.now() - startTime };
    } catch (error) {
      lastError = toError(error, 'Map item failed');
    }

    if (attempt < maxAttempts && config.retry && !mapSignal.aborted) {
      const delay = config.retry.delay ?? 1000;
      const wait =
        config.retry.backoff === 'exponential' ? delay * Math.pow(2, attempt - 1) : delay * attempt;
      try {
        await abortableDelay(wait, mapSignal);
      } catch {
        break;
      }
    }
  }

  return {
    index,
    item,
    result: undefined as T,
    success: false,
    error: lastError ?? toError(mapSignal.reason, 'Map aborted'),
    duration: Date.now() - startTime,
  };
}

/**
 * Map the items of `state` with `config.mapper`, at most `concurrency` at a time. Without
 * `continueOnError` the first failed item stops the map: no further item starts, the items in
 * flight are aborted, and the map rejects with that item's error. Aborting `options.signal`
 * stops it the same way. The rejection carries `partialResults`, one entry per item: what it
 * returned, why it failed, or a `MapItemSkippedError` for an item that never ran.
 */
export async function executeMap<S, T>(
  state: S,
  config: MapNodeConfig<S, T>,
  options: MapExecutionOptions = {}
): Promise<MapItemResult<T>[]> {
  const runSignal = options.signal;
  if (runSignal?.aborted) throw toError(runSignal.reason, 'Map aborted');

  let items = config.items(state);
  if (config.filter) {
    items = items.filter((item, index) => config.filter!(item, index, state));
  }

  const controller = new AbortController();
  const forwardRunAbort = () => controller.abort(runSignal?.reason);
  runSignal?.addEventListener('abort', forwardRunAbort, { once: true });

  const results: (MapItemResult<T> | undefined)[] = new Array<MapItemResult<T> | undefined>(
    items.length
  );
  const concurrency = Math.max(1, config.concurrency ?? Infinity);
  let nextIndex = 0;
  let running = 0;
  let completed = 0;
  let successful = 0;
  let failed = 0;
  let failure: Error | undefined;

  const emitProgress = (current?: MapItemResult<T>) => {
    config.onProgress?.({
      total: items.length,
      completed,
      successful,
      failed,
      currentItem: current,
      pending: items.length - completed,
      running,
    });
  };

  const worker = async (): Promise<void> => {
    while (!controller.signal.aborted && nextIndex < items.length) {
      const index = nextIndex++;
      running++;
      const result = await executeItem(items[index], index, state, config, controller.signal);
      running--;
      results[index] = result;
      completed++;
      if (result.success) {
        successful++;
      } else {
        failed++;
        if (!config.continueOnError && !controller.signal.aborted) {
          failure = result.error ?? new Error(`Item ${index} failed`);
          controller.abort(failure);
        }
      }
      emitProgress(result);
    }
  };

  emitProgress();
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  } finally {
    runSignal?.removeEventListener('abort', forwardRunAbort);
  }

  if (!controller.signal.aborted) return results as MapItemResult<T>[];

  const reason = failure ?? toError(controller.signal.reason, 'Map aborted');
  const partialResults = items.map(
    (item, index): MapItemResult<T> =>
      results[index] ?? {
        index,
        item,
        result: undefined as T,
        success: false,
        error: new MapItemSkippedError(index, reason),
        duration: 0,
      }
  );
  throw Object.assign(reason, { partialResults });
}

export function executeReduce<S, T, R>(
  results: MapItemResult<T>[],
  state: S,
  config: ReduceNodeConfig<S, T, R>
): R {
  const initial =
    typeof config.initial === 'function'
      ? (config.initial as (state: S) => R)(state)
      : config.initial;

  const items = config.successOnly !== false ? results.filter((r) => r.success) : results;

  let result = items.reduce((acc, item) => config.reducer(acc, item, state), initial);

  if (config.finalize) {
    result = config.finalize(result, state);
  }

  return result;
}

export async function executeMapReduce<S, T, R>(
  state: S,
  config: MapReduceNodeConfig<S, T, R>,
  options: MapExecutionOptions = {}
): Promise<MapReduceResult<T, R>> {
  const startTime = Date.now();

  const mapConfig: MapNodeConfig<S, T> = {
    name: `${config.name}:map`,
    ...config.map,
  };

  let streamingAccumulator: R | undefined;
  if (config.reduce.streaming) {
    streamingAccumulator =
      typeof config.reduce.initial === 'function'
        ? (config.reduce.initial as (state: S) => R)(state)
        : config.reduce.initial;

    const reduceConfig = {
      name: `${config.name}:reduce`,
      ...config.reduce,
    };

    const streamingQueue: MapItemResult<T>[] = [];
    let nextExpectedIndex = 0;

    const drainQueue = () => {
      streamingQueue.sort((a, b) => a.index - b.index);
      while (streamingQueue.length > 0 && streamingQueue[0].index === nextExpectedIndex) {
        const item = streamingQueue.shift()!;
        if (item.success && reduceConfig.successOnly !== false) {
          streamingAccumulator = reduceConfig.reducer(streamingAccumulator!, item, state);
        }
        nextExpectedIndex++;
      }
    };

    const originalOnProgress = mapConfig.onProgress;
    mapConfig.onProgress = (progress) => {
      if (progress.currentItem) {
        streamingQueue.push(progress.currentItem);
        drainQueue();
      }
      originalOnProgress?.(progress);
    };
  }

  const results = await executeMap(state, mapConfig, options);

  const reduceConfig: ReduceNodeConfig<S, T, R> = {
    name: `${config.name}:reduce`,
    ...config.reduce,
  };

  let reduced: R;
  if (config.reduce.streaming && streamingAccumulator !== undefined) {
    reduced = streamingAccumulator;
    if (reduceConfig.finalize) {
      reduced = reduceConfig.finalize(reduced, state);
    }
  } else {
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

export function mapNode<S, T>(
  name: string,
  config: Omit<MapNodeConfig<S, T>, 'name'>
): MapNodeConfig<S, T> {
  return { name, ...config };
}

export function reduceNode<S, T, R>(
  name: string,
  config: Omit<ReduceNodeConfig<S, T, R>, 'name'>
): ReduceNodeConfig<S, T, R> {
  return { name, ...config };
}

export function mapReduceNode<S, T, R>(
  name: string,
  config: Omit<MapReduceNodeConfig<S, T, R>, 'name'>
): MapReduceNodeConfig<S, T, R> {
  return { name, ...config };
}

export async function parallelMap<S, T>(
  state: S,
  items: (state: S) => unknown[],
  mapper: (item: unknown, index: number, state: S, ctx: MapItemContext) => Promise<T> | T,
  options: {
    continueOnError?: boolean;
    onProgress?: (progress: MapProgressEvent<T>) => void;
    signal?: AbortSignal;
  } = {}
): Promise<MapItemResult<T>[]> {
  const { signal, ...mapOptions } = options;
  return executeMap(
    state,
    {
      name: 'parallelMap',
      items,
      mapper,
      concurrency: Infinity,
      ...mapOptions,
    },
    { signal }
  );
}

export async function sequentialMap<S, T>(
  state: S,
  items: (state: S) => unknown[],
  mapper: (item: unknown, index: number, state: S, ctx: MapItemContext) => Promise<T> | T,
  options: {
    continueOnError?: boolean;
    onProgress?: (progress: MapProgressEvent<T>) => void;
    signal?: AbortSignal;
  } = {}
): Promise<MapItemResult<T>[]> {
  const { signal, ...mapOptions } = options;
  return executeMap(
    state,
    {
      name: 'sequentialMap',
      items,
      mapper,
      concurrency: 1,
      ...mapOptions,
    },
    { signal }
  );
}

export async function batchedMap<S, T>(
  state: S,
  items: (state: S) => unknown[],
  mapper: (item: unknown, index: number, state: S, ctx: MapItemContext) => Promise<T> | T,
  batchSize: number,
  options: {
    continueOnError?: boolean;
    onProgress?: (progress: MapProgressEvent<T>) => void;
    signal?: AbortSignal;
  } = {}
): Promise<MapItemResult<T>[]> {
  const { signal, ...mapOptions } = options;
  return executeMap(
    state,
    {
      name: 'batchedMap',
      items,
      mapper,
      concurrency: batchSize,
      ...mapOptions,
    },
    { signal }
  );
}

export function collect<T>(): Omit<ReduceNodeConfig<unknown, T, T[]>, 'name'> {
  return {
    initial: () => [] as T[],
    reducer: (acc, item) => {
      acc.push(item.result);
      return acc;
    },
  };
}

export function sum(): Omit<ReduceNodeConfig<unknown, number, number>, 'name'> {
  return {
    initial: 0,
    reducer: (acc, item) => acc + item.result,
  };
}

export function count(): Omit<ReduceNodeConfig<unknown, unknown, number>, 'name'> {
  return {
    initial: 0,
    reducer: (acc) => acc + 1,
  };
}

export function first<T>(): Omit<ReduceNodeConfig<unknown, T, T | undefined>, 'name'> {
  return {
    initial: undefined,
    reducer: (acc, item) => acc ?? item.result,
  };
}

export function last<T>(): Omit<ReduceNodeConfig<unknown, T, T | undefined>, 'name'> {
  return {
    initial: undefined,
    reducer: (_, item) => item.result,
  };
}

export function groupBy<T, K extends string | number>(
  keyFn: (result: T, item: MapItemResult<T>) => K
): Omit<ReduceNodeConfig<unknown, T, Record<K, T[]>>, 'name'> {
  return {
    initial: () => ({}) as Record<K, T[]>,
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

export function partition<T>(
  predicate: (result: T, item: MapItemResult<T>) => boolean
): Omit<ReduceNodeConfig<unknown, T, { pass: T[]; fail: T[] }>, 'name'> {
  return {
    initial: () => ({ pass: [] as T[], fail: [] as T[] }),
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

export function flatMap<T>(): Omit<ReduceNodeConfig<unknown, T[], T[]>, 'name'> {
  return {
    initial: () => [] as T[],
    reducer: (acc, item) => {
      acc.push(...item.result);
      return acc;
    },
  };
}

export function stats(): Omit<
  ReduceNodeConfig<
    unknown,
    number,
    {
      count: number;
      sum: number;
      avg: number;
      min: number;
      max: number;
    }
  >,
  'name'
> {
  return {
    initial: () => ({
      count: 0,
      sum: 0,
      avg: 0,
      min: Infinity,
      max: -Infinity,
    }),
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
