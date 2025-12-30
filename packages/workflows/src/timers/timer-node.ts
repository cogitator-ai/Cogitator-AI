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

import type {
  TimerEntry,
  TimerStore,
} from '@cogitator/types';
import { getNextCronOccurrence, isValidCronExpression } from './cron-parser.js';

/**
 * Timer node type
 */
export type TimerNodeType = 'fixed' | 'dynamic' | 'cron' | 'until';

/**
 * Base timer node config
 */
export interface TimerNodeConfig<S> {
  name: string;
  type: TimerNodeType;
  persist?: boolean;
  onScheduled?: (entry: TimerEntry) => void;
  onFired?: (entry: TimerEntry) => void;
  onCancelled?: (entry: TimerEntry) => void;
  /** Phantom type for state */
  _state?: S;
}

/**
 * Fixed delay node config
 */
export interface FixedDelayConfig<S> extends TimerNodeConfig<S> {
  type: 'fixed';
  delay: number; // milliseconds
}

/**
 * Dynamic delay node config
 */
export interface DynamicDelayConfig<S> extends TimerNodeConfig<S> {
  type: 'dynamic';
  getDelay: (state: S) => number; // returns milliseconds
}

/**
 * Cron wait node config
 */
export interface CronWaitConfig<S> extends TimerNodeConfig<S> {
  type: 'cron';
  expression: string;
  timezone?: string;
  waitForNext?: boolean; // If true, waits for next occurrence even if current time matches
}

/**
 * Until date node config
 */
export interface UntilDateConfig<S> extends TimerNodeConfig<S> {
  type: 'until';
  getDate: (state: S) => Date | number; // returns target date or timestamp
  skipIfPast?: boolean; // If true, skip delay if date is in the past
}

/**
 * Union of all timer node configs
 */
export type AnyTimerNodeConfig<S> =
  | FixedDelayConfig<S>
  | DynamicDelayConfig<S>
  | CronWaitConfig<S>
  | UntilDateConfig<S>;

/**
 * Timer node result
 */
export interface TimerNodeResult {
  timerId: string;
  scheduledAt: number;
  firesAt: number;
  waited: number;
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
  signal?: AbortSignal;
}

/**
 * Create a fixed delay node
 */
export function delayNode<S>(
  name: string,
  delay: number,
  options: Partial<Omit<FixedDelayConfig<S>, 'type' | 'delay'>> = {}
): FixedDelayConfig<S> {
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
export function cronWaitNode<S>(
  name: string,
  expression: string,
  options: Partial<Omit<CronWaitConfig<S>, 'type' | 'expression'>> = {}
): CronWaitConfig<S> {
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
export function calculateTimerDelay<S>(
  config: AnyTimerNodeConfig<S>,
  state: S
): number {
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
 * Execute a timer node
 */
export async function executeTimerNode<S>(
  config: AnyTimerNodeConfig<S>,
  state: S,
  context: TimerExecutionContext
): Promise<TimerNodeResult> {
  const now = Date.now();
  const delay = calculateTimerDelay(config, state);
  const firesAt = now + delay;

  let timerId: string | undefined;

  // Schedule in timer store if persistence is enabled
  if (config.persist && context.timerStore) {
    timerId = await context.timerStore.schedule({
      workflowId: context.workflowId,
      runId: context.runId,
      nodeId: context.nodeId,
      firesAt,
      type: config.type === 'cron' ? 'cron' : config.type === 'dynamic' ? 'dynamic' : 'fixed',
      metadata: { nodeType: config.type, delay },
    });

    const entry = await context.timerStore.get(timerId);
    if (entry) {
      config.onScheduled?.(entry);
    }
  } else {
    timerId = `timer_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  // Wait for the delay
  const startWait = Date.now();
  let cancelled = false;

  try {
    await waitWithAbort(delay, context.signal);
  } catch (error) {
    if (error instanceof AbortError) {
      cancelled = true;

      // Mark as cancelled in store
      if (config.persist && context.timerStore && timerId) {
        await context.timerStore.cancel(timerId);
        const entry = await context.timerStore.get(timerId);
        if (entry) {
          config.onCancelled?.(entry);
        }
      }
    } else {
      throw error;
    }
  }

  const waited = Date.now() - startWait;

  // Mark as fired in store
  if (!cancelled && config.persist && context.timerStore && timerId) {
    await context.timerStore.markFired(timerId);
    const entry = await context.timerStore.get(timerId);
    if (entry) {
      config.onFired?.(entry);
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

    const timeout = setTimeout(resolve, delay);

    const onAbort = () => {
      clearTimeout(timeout);
      reject(new AbortError());
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Create timer node helpers with bound store
 */
export function createTimerNodeHelpers(timerStore: TimerStore) {
  return {
    delayNode: <S>(
      name: string,
      delay: number,
      options: Partial<Omit<FixedDelayConfig<S>, 'type' | 'delay'>> = {}
    ) => delayNode(name, delay, { ...options, persist: true }),

    dynamicDelayNode: <S>(
      name: string,
      getDelay: (state: S) => number,
      options: Partial<Omit<DynamicDelayConfig<S>, 'type' | 'getDelay'>> = {}
    ) => dynamicDelayNode(name, getDelay, { ...options, persist: true }),

    cronWaitNode: <S>(
      name: string,
      expression: string,
      options: Partial<Omit<CronWaitConfig<S>, 'type' | 'expression'>> = {}
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
  const match = duration.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i);
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
