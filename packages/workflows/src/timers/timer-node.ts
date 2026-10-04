/**
 * Timer node factories for workflow delays
 *
 * Features:
 * - Fixed delay nodes
 * - Dynamic delay from state
 * - Cron-based wait nodes
 * - Cancellation support
 * - Integration with timer store
 */

import type { TimerEntry, TimerStore } from '@cogitator-ai/types';
import { getNextCronOccurrence, isValidCronExpression } from './cron-parser';

/**
 * Timer node type
 */
export type TimerNodeType = 'fixed' | 'dynamic' | 'cron' | 'until';

/**
 * Base timer node config
 */
export interface TimerNodeConfig {
  name: string;
  type: TimerNodeType;
  persist?: boolean;
  onScheduled?: (entry: TimerEntry) => void;
  onFired?: (entry: TimerEntry) => void;
  onCancelled?: (entry: TimerEntry) => void;
}

/**
 * Fixed delay node config
 */
export interface FixedDelayConfig extends TimerNodeConfig {
  type: 'fixed';
  delay: number;
}

/**
 * Dynamic delay node config
 */
export interface DynamicDelayConfig<S> extends TimerNodeConfig {
  type: 'dynamic';
  getDelay: (state: S) => number;
}

/**
 * Cron wait node config
 */
export interface CronWaitConfig extends TimerNodeConfig {
  type: 'cron';
  expression: string;
  timezone?: string;
  waitForNext?: boolean;
}

/**
 * Until date node config
 */
export interface UntilDateConfig<S> extends TimerNodeConfig {
  type: 'until';
  getDate: (state: S) => Date | number;
  skipIfPast?: boolean;
}

/**
 * Union of all timer node configs
 */
export type AnyTimerNodeConfig<S> =
  FixedDelayConfig | DynamicDelayConfig<S> | CronWaitConfig | UntilDateConfig<S>;

/**
 * Timer node result
 */
export interface TimerNodeResult {
  timerId: string;
  scheduledAt: number;
  firesAt: number;
  waited: number;
  /**
   * The persisted timer was cancelled through its store (for example `TimerManager.cancel`)
   * before the wait ended. An abort of the run does not resolve, it rejects with `AbortError`
   */
  cancelled: boolean;
}

/**
 * Timer execution context
 */
export interface TimerExecutionContext {
  workflowId: string;
  runId: string;
  nodeId: string;
  timerStore?: TimerStore;
  /** Abort signal of the run; aborting it stops the wait and rejects with `AbortError` */
  signal?: AbortSignal;
  /** Called with the stored entry once a persisted timer is scheduled */
  onTimerScheduled?: (entry: TimerEntry) => void;
}

/**
 * Create a fixed delay node
 */
export function delayNode(
  name: string,
  delay: number,
  options: Partial<Omit<FixedDelayConfig, 'type' | 'delay'>> = {}
): FixedDelayConfig {
  return {
    name,
    type: 'fixed',
    delay,
    ...options,
  };
}

/**
 * Create a dynamic delay node
 */
export function dynamicDelayNode<S>(
  name: string,
  getDelay: (state: S) => number,
  options: Partial<Omit<DynamicDelayConfig<S>, 'type' | 'getDelay'>> = {}
): DynamicDelayConfig<S> {
  return {
    name,
    type: 'dynamic',
    getDelay,
    ...options,
  };
}

/**
 * Create a cron wait node
 */
export function cronWaitNode(
  name: string,
  expression: string,
  options: Partial<Omit<CronWaitConfig, 'type' | 'expression'>> = {}
): CronWaitConfig {
  if (!isValidCronExpression(expression)) {
    throw new Error(`Invalid cron expression: ${expression}`);
  }

  return {
    name,
    type: 'cron',
    expression,
    ...options,
  };
}

/**
 * Create an until-date node
 */
export function untilNode<S>(
  name: string,
  getDate: (state: S) => Date | number,
  options: Partial<Omit<UntilDateConfig<S>, 'type' | 'getDate'>> = {}
): UntilDateConfig<S> {
  return {
    name,
    type: 'until',
    getDate,
    ...options,
  };
}

/**
 * Calculate the delay for a timer node
 */
export function calculateTimerDelay<S>(config: AnyTimerNodeConfig<S>, state: S): number {
  const now = Date.now();

  switch (config.type) {
    case 'fixed':
      return config.delay;

    case 'dynamic':
      return config.getDelay(state);

    case 'cron': {
      const next = getNextCronOccurrence(config.expression, {
        currentDate: config.waitForNext ? new Date(now + 1000) : new Date(now),
        timezone: config.timezone,
      });
      return Math.max(0, next.getTime() - now);
    }

    case 'until': {
      const target = config.getDate(state);
      const targetTime = target instanceof Date ? target.getTime() : target;
      const delay = targetTime - now;

      if (delay < 0 && config.skipIfPast) {
        return 0;
      }

      return Math.max(0, delay);
    }
  }
}

/**
 * Metadata key set on a persisted timer whose wait was interrupted by an abort of the run.
 * The next execution of the same node in the same run waits until its `firesAt`.
 */
const INTERRUPTED = 'interrupted';

/**
 * Metadata key pointing from an interrupted timer to the timer that took over its wait.
 */
const RESUMED_BY = 'resumedBy';

/**
 * Execute a timer node
 *
 * Aborting `context.signal` stops the wait and rejects with {@link AbortError}, so a run
 * paused or cancelled mid-wait does not record the node as completed. A persisted timer is
 * cancelled in its store and marked as interrupted, and the next execution of the node in
 * the same run (a resumed run) waits only until the interrupted timer's `firesAt`.
 *
 * A persisted timer cancelled through its store while the node waits (for example with
 * `TimerManager.cancel`) resolves with `cancelled: true` once the wait ends, and reports
 * `onCancelled` instead of `onFired`.
 */
export async function executeTimerNode<S>(
  config: AnyTimerNodeConfig<S>,
  state: S,
  context: TimerExecutionContext
): Promise<TimerNodeResult> {
  const now = Date.now();
  const store = config.persist ? context.timerStore : undefined;
  const interrupted = store ? await findInterruptedTimer(store, context) : undefined;
  const firesAt = interrupted?.firesAt ?? now + calculateTimerDelay(config, state);
  const delay = Math.max(0, firesAt - now);

  let timerId: string;

  if (store) {
    timerId = await store.schedule({
      workflowId: context.workflowId,
      runId: context.runId,
      nodeId: context.nodeId,
      firesAt,
      type: config.type === 'until' ? 'fixed' : config.type,
      metadata: {
        nodeType: config.type,
        delay,
        ...(interrupted && { resumedFrom: interrupted.id }),
      },
    });

    if (interrupted) {
      await store.update(interrupted.id, {
        metadata: { ...interrupted.metadata, [RESUMED_BY]: timerId },
      });
    }

    const entry = await store.get(timerId);
    if (entry) {
      config.onScheduled?.(entry);
      try {
        context.onTimerScheduled?.(entry);
      } catch (error) {
        console.warn(`[TimerNode] onTimerScheduled failed for timer '${entry.id}':`, error);
      }
    }
  } else {
    timerId = `timer_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  const startWait = Date.now();

  try {
    await waitWithAbort(delay, context.signal);
  } catch (error) {
    if (error instanceof AbortError && store) {
      await interruptTimer(store, timerId, config);
    }
    throw error;
  }

  const waited = Date.now() - startWait;
  let cancelled = false;

  if (store) {
    await store.markFired(timerId);
    const entry = await store.get(timerId);
    cancelled = entry?.cancelled === true && !entry.fired;
    if (entry) {
      if (cancelled) config.onCancelled?.(entry);
      else config.onFired?.(entry);
    }
  }

  return {
    timerId,
    scheduledAt: now,
    firesAt,
    waited,
    cancelled,
  };
}

/**
 * The latest persisted timer of this node and run whose wait an abort interrupted and no
 * later execution has taken over yet
 */
async function findInterruptedTimer(
  store: TimerStore,
  context: TimerExecutionContext
): Promise<TimerEntry | undefined> {
  const entries = await store.getByRun(context.runId);
  return entries
    .filter(
      (entry) =>
        entry.workflowId === context.workflowId &&
        entry.nodeId === context.nodeId &&
        !entry.fired &&
        entry.metadata?.[INTERRUPTED] === true &&
        entry.metadata[RESUMED_BY] === undefined
    )
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

/**
 * Cancel a persisted timer whose wait was aborted and mark it as interrupted
 */
async function interruptTimer<S>(
  store: TimerStore,
  timerId: string,
  config: AnyTimerNodeConfig<S>
): Promise<void> {
  await store.cancel(timerId);
  const entry = await store.get(timerId);
  if (!entry) return;
  const metadata = { ...entry.metadata, [INTERRUPTED]: true };
  await store.update(timerId, { metadata });
  config.onCancelled?.({ ...entry, metadata });
}

/**
 * Abort error for timer cancellation
 */
export class AbortError extends Error {
  constructor(message = 'Timer aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

/**
 * Wait with abort signal support
 */
function waitWithAbort(delay: number, signal?: AbortSignal): Promise<void> {
  if (delay <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }

    const onAbort = () => {
      clearTimeout(timeout);
      reject(new AbortError());
    };

    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    timeout.unref?.();

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Create timer node helpers with bound store
 */
export function createTimerNodeHelpers(timerStore: TimerStore) {
  return {
    delayNode: (
      name: string,
      delay: number,
      options: Partial<Omit<FixedDelayConfig, 'type' | 'delay'>> = {}
    ) => delayNode(name, delay, { ...options, persist: true }),

    dynamicDelayNode: <S>(
      name: string,
      getDelay: (state: S) => number,
      options: Partial<Omit<DynamicDelayConfig<S>, 'type' | 'getDelay'>> = {}
    ) => dynamicDelayNode(name, getDelay, { ...options, persist: true }),

    cronWaitNode: (
      name: string,
      expression: string,
      options: Partial<Omit<CronWaitConfig, 'type' | 'expression'>> = {}
    ) => cronWaitNode(name, expression, { ...options, persist: true }),

    untilNode: <S>(
      name: string,
      getDate: (state: S) => Date | number,
      options: Partial<Omit<UntilDateConfig<S>, 'type' | 'getDate'>> = {}
    ) => untilNode(name, getDate, { ...options, persist: true }),

    executeTimerNode: <S>(
      config: AnyTimerNodeConfig<S>,
      state: S,
      context: Omit<TimerExecutionContext, 'timerStore'>
    ) => executeTimerNode(config, state, { ...context, timerStore }),
  };
}

/**
 * Duration helpers for readable delays
 */
export const Duration = {
  milliseconds: (n: number) => n,
  seconds: (n: number) => n * 1000,
  minutes: (n: number) => n * 60 * 1000,
  hours: (n: number) => n * 60 * 60 * 1000,
  days: (n: number) => n * 24 * 60 * 60 * 1000,
  weeks: (n: number) => n * 7 * 24 * 60 * 60 * 1000,
} as const;

/**
 * Parse duration string to milliseconds
 * Supports: "1s", "5m", "2h", "1d", "1w"
 */
export function parseDuration(duration: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i.exec(duration);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}`);
  }

  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 'ms':
      return Duration.milliseconds(value);
    case 's':
      return Duration.seconds(value);
    case 'm':
      return Duration.minutes(value);
    case 'h':
      return Duration.hours(value);
    case 'd':
      return Duration.days(value);
    case 'w':
      return Duration.weeks(value);
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }
}

/**
 * Format duration to human-readable string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  if (ms < 3600000) {
    return `${(ms / 60000).toFixed(1)}m`;
  }

  if (ms < 86400000) {
    return `${(ms / 3600000).toFixed(1)}h`;
  }

  return `${(ms / 86400000).toFixed(1)}d`;
}
