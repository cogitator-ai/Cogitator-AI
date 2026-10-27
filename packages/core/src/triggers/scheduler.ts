/**
 * The scheduler of the runtime: entries of a `TimerStore` that fire once, on a cron expression or
 * every so often, with one claim logic, catch-up of missed occurrences and retries. Routines run
 * on it, and `HeartbeatScheduler` of channels is a client of it
 */

import type { CronEngine, TimerEntry, TimerStore } from '@cogitator-ai/types';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { experimental_loadCronEngine, planOccurrences, type OccurrencePlan } from './cron';
import {
  experimental_TimerPoller,
  toError,
  type experimental_TimerClaims,
  type TimerClaimListeners,
} from './poller';

/** One firing of a schedule entry, as the scheduler hands it over */
export interface ScheduledFire {
  entry: TimerEntry;
  /** The occurrence it fires for, ms since epoch */
  occurrence: number;
  /** Whether earlier occurrences were let go because of `catchUp` or its window */
  missed: boolean;
  /** Aborts when the claim on the entry is lost while it fires */
  signal: AbortSignal;
}

/**
 * What `fire` returns for a one-shot entry whose work goes on after it returned: the entry is
 * neither fired nor failed, it waits until `holdUntil` (ms since epoch) and the one who holds it
 * settles it (`markFired`, or a retry through `update`) once the work ends, or holds it longer.
 * Its failures in a row are left as they are
 */
export interface ScheduledHold {
  holdUntil: number;
}

/** What `add` takes */
export interface ScheduleInput {
  name?: string;
  /** A cron expression, 5 or 6 fields or a preset such as `@daily` */
  cron?: string;
  /** The time zone of `cron`, IANA */
  timezone?: string;
  /** Fires once at this time */
  at?: number | Date | string;
  /** Fires once after this many ms */
  delayMs?: number;
  /** Fires every this many ms */
  intervalMs?: number;
  catchUp?: TimerEntry['catchUp'];
  catchUpWindowMs?: number;
  trigger?: TimerEntry['trigger'];
  metadata?: Record<string, unknown>;
  enabled?: boolean;
  /** Default `schedules` */
  workflowId?: string;
  /** Default `scheduler` */
  runId?: string;
  /** Default `task` */
  nodeId?: string;
}

/** Options of {@link experimental_Scheduler} */
export interface SchedulerOptions extends TimerClaimListeners {
  store: TimerStore;
  /**
   * What a due occurrence does. A throw counts as a failed run. A one-shot entry may return a
   * {@link ScheduledHold} instead of finishing: its work goes on, the entry waits meanwhile
   */
  fire: (fire: ScheduledFire) => void | ScheduledHold | Promise<void | ScheduledHold>;
  /** The cron engine. Default: the one over `cron-parser`, loaded by `start()` and `add()` */
  cron?: CronEngine;
  /** The entries this scheduler runs, the rest it gives back. Default: all */
  accepts?: (entry: TimerEntry) => boolean;
  /** Default 1000 ms */
  pollInterval?: number;
  /** Most entries run per poll (default 100) */
  batchSize?: number;
  /** The first poll waits a random time up to this, ms */
  staggerMs?: number;
  /** Failed runs in a row after which an entry is skipped until enabled again (default 5) */
  maxRetries?: number;
  /**
   * How a repeating entry moves on after it fired: `update` (default) gives the same entry its
   * next time, `append` marks it fired and schedules a copy for the next time, as `timers.json`
   * of channels keeps them
   */
  reschedule?: 'update' | 'append';
  /**
   * The next time of a repeating entry instead of the plan's, null to end it. Called once the
   * occurrences fired, with the time they ended: the next time counts from the end of the run
   * (a fixed delay, as `HeartbeatScheduler` has it), so a long run never makes the next one due
   * at once
   */
  nextFire?: (entry: TimerEntry, now: number) => number | null;
  /** How late an occurrence may still fire with `catchUp: 'none'`, ms. Default: 2 polls, at least a minute */
  graceMs?: number;
  /** Most occurrences fired at once with `catchUp: 'all'` (default 100) */
  maxCatchUp?: number;
  /** How long fired and cancelled entries are kept, ms (default 7 days). Cleanup runs hourly */
  retentionMs?: number;
  /**
   * How the store's `cleanup` reads its argument: `age` (default, the stores of core and
   * workflows: entries older than that many ms) or `cutoff` (`SimpleTimerStore` of channels:
   * entries created before that time). `false` never cleans up
   */
  cleanup?: 'age' | 'cutoff' | false;
  onRunComplete?: (
    entry: TimerEntry,
    status: 'ok' | 'error',
    error?: string,
    durationMs?: number
  ) => void;
  /** Occurrences let go because of `catchUp` or its window */
  onMissed?: (entry: TimerEntry, plan: OccurrencePlan) => void;
}

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function timeOf(at: number | Date | string): number {
  const time = at instanceof Date ? at.getTime() : typeof at === 'string' ? Date.parse(at) : at;
  if (!Number.isFinite(time)) {
    throw new CogitatorError({
      message: `Invalid time: ${String(at)}`,
      code: ErrorCode.VALIDATION_ERROR,
    });
  }
  return time;
}

/**
 * Experimental. Runs the entries of a schedules store as they come due. Each due entry is
 * claimed (with a store that claims), its occurrences planned by `catchUp`, fired one after
 * another while the claim is renewed, and moved on to its next time. An entry whose run failed
 * `maxRetries` times in a row is skipped until it is enabled again. A one-shot entry that failed
 * stays due and fires again on a later poll, unless its metadata says `bestEffort`
 */
export class experimental_Scheduler {
  private readonly poller: experimental_TimerPoller;
  private engine?: CronEngine;
  private lastCleanupAt = 0;

  constructor(private readonly options: SchedulerOptions) {
    this.engine = options.cron;
    this.poller = new experimental_TimerPoller({
      store: options.store,
      process: (entry, claims) => this.process(entry, claims),
      ...(options.accepts && { accepts: options.accepts }),
      pollInterval: options.pollInterval ?? 1000,
      batchSize: options.batchSize ?? 100,
      runnable: (entry) =>
        entry.enabled !== false && (entry.consecutiveErrors ?? 0) < (options.maxRetries ?? 5),
      ...(options.staggerMs !== undefined && { staggerMs: options.staggerMs }),
      afterPoll: () => this.cleanupIfDue(),
      ...(options.onError && { onError: options.onError }),
      ...(options.onClaimLost && { onClaimLost: options.onClaimLost }),
    });
  }

  get store(): TimerStore {
    return this.options.store;
  }

  get isRunning(): boolean {
    return this.poller.isRunning;
  }

  /** The cron engine, loaded on first use */
  async cron(): Promise<CronEngine> {
    this.engine ??= await experimental_loadCronEngine();
    return this.engine;
  }

  /** Starts polling. Loads the cron engine first when none was given */
  async start(): Promise<void> {
    await this.cron();
    this.poller.start();
  }

  /**
   * Starts polling at once: with a cron engine given, or for stores without cron entries. Entries
   * with a cron expression fail until an engine is there
   */
  startNow(): void {
    this.poller.start();
  }

  /** Stops polling, resolves once the poll going on is done */
  stop(): Promise<void> {
    return this.poller.stop();
  }

  /** Runs the entries due now, resolves with how many ran */
  processNow(): Promise<number> {
    return this.poller.poll();
  }

  /**
   * Adds an entry and returns it. Its first time is the first occurrence of `cron` after now, `at`,
   * now plus `delayMs` or now plus `intervalMs`
   *
   * @throws CogitatorError `VALIDATION_ERROR` for an invalid cron expression or time zone, or
   * without exactly one of `cron`, `at`, `delayMs` and `intervalMs`
   */
  async add(input: ScheduleInput): Promise<TimerEntry> {
    const modes = [input.cron, input.at, input.delayMs, input.intervalMs].filter(
      (value) => value !== undefined
    );
    if (modes.length !== 1) {
      throw new CogitatorError({
        message: 'A schedule needs exactly one of cron, at, delayMs and intervalMs',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    const now = Date.now();
    let firesAt: number;
    let type: TimerEntry['type'];
    let cron: string | undefined;
    if (input.cron !== undefined) {
      const engine = await this.cron();
      const problem = engine.problem(input.cron, input.timezone);
      if (problem) throw new CogitatorError({ message: problem, code: ErrorCode.VALIDATION_ERROR });
      cron = engine.normalize(input.cron);
      firesAt = engine.next(cron, now, input.timezone);
      type = 'cron';
    } else if (input.intervalMs !== undefined) {
      if (!(input.intervalMs > 0)) {
        throw new CogitatorError({
          message: `intervalMs must be positive, got ${input.intervalMs}`,
          code: ErrorCode.VALIDATION_ERROR,
        });
      }
      firesAt = now + input.intervalMs;
      type = 'recurring';
    } else {
      firesAt = input.at !== undefined ? timeOf(input.at) : now + Math.max(0, input.delayMs ?? 0);
      type = 'fixed';
    }
    const id = await this.options.store.schedule({
      workflowId: input.workflowId ?? 'schedules',
      runId: input.runId ?? 'scheduler',
      nodeId: input.nodeId ?? 'task',
      firesAt,
      type,
      ...(cron !== undefined && { cron }),
      ...(input.timezone !== undefined && cron !== undefined && { timezone: input.timezone }),
      ...(input.intervalMs !== undefined && { interval: input.intervalMs }),
      ...(input.name !== undefined && { name: input.name }),
      ...(input.catchUp !== undefined && { catchUp: input.catchUp }),
      ...(input.catchUpWindowMs !== undefined && { catchUpWindowMs: input.catchUpWindowMs }),
      ...(input.trigger !== undefined && { trigger: input.trigger }),
      ...(input.metadata !== undefined && { metadata: input.metadata }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
    });
    const entry = await this.options.store.get(id);
    if (!entry) throw new Error(`The schedules store lost entry ${id} it just added`);
    return entry;
  }

  /** The entries that are not fired or cancelled, by time */
  async list(): Promise<TimerEntry[]> {
    return (await this.options.store.getPending()).sort((a, b) => a.firesAt - b.firesAt);
  }

  get(id: string): Promise<TimerEntry | null> {
    return this.options.store.get(id);
  }

  remove(id: string): Promise<void> {
    return this.options.store.cancel(id);
  }

  /** Stops an entry from firing until `resume` */
  async pause(id: string): Promise<void> {
    await this.options.store.update(id, { enabled: false });
  }

  /**
   * Lets a paused entry fire again, its errors forgotten. A repeating entry goes on from its next
   * occurrence: the time it was paused is not caught up
   */
  async resume(id: string): Promise<void> {
    const entry = await this.options.store.get(id);
    if (!entry) return;
    const patch: Partial<TimerEntry> = { enabled: true, consecutiveErrors: 0 };
    const now = Date.now();
    if (entry.firesAt < now && (entry.cron || entry.interval)) {
      patch.firesAt = entry.cron
        ? (await this.cron()).next(entry.cron, now, entry.timezone)
        : now + (entry.interval ?? 0);
    }
    await this.options.store.update(id, patch);
  }

  /** Makes an entry due now: the next poll fires it, then it goes on as before */
  async runNow(id: string): Promise<void> {
    await this.options.store.update(id, { firesAt: Date.now() });
  }

  /** The next time of an entry that repeats, after `after` */
  async nextAfter(entry: TimerEntry, after: number): Promise<number | null> {
    if (entry.cron) return (await this.cron()).next(entry.cron, after, entry.timezone);
    if (entry.interval) return after + entry.interval;
    return null;
  }

  private async cleanupIfDue(): Promise<void> {
    const mode = this.options.cleanup ?? 'age';
    const now = Date.now();
    if (mode === false || now - this.lastCleanupAt < CLEANUP_INTERVAL_MS) return;
    this.lastCleanupAt = now;
    const retention = this.options.retentionMs ?? DEFAULT_RETENTION_MS;
    await this.options.store.cleanup(mode === 'cutoff' ? now - retention : retention);
  }

  private async process(entry: TimerEntry, claims: experimental_TimerClaims): Promise<void> {
    const { store } = this.options;
    if (entry.enabled === false) {
      await claims.release(entry);
      return;
    }
    if ((entry.consecutiveErrors ?? 0) >= (this.options.maxRetries ?? 5)) {
      if (entry.lastRunStatus !== 'skipped') {
        await store.update(entry.id, { lastRunStatus: 'skipped' });
      }
      await claims.release(entry);
      return;
    }
    if (!(await claims.confirm(entry))) return;

    const startedAt = Date.now();
    const plan = this.plan(entry, startedAt);
    if (plan.missed) this.options.onMissed?.(entry, plan);
    const meta = entry.metadata ?? {};
    let status: 'ok' | 'error' = 'ok';
    let errorMessage: string | undefined;
    let lastOccurrence: number | undefined;
    let hold: ScheduledHold | undefined;

    const lost = new AbortController();
    const stopRenewing = claims.keep(entry, lost);
    try {
      for (const occurrence of plan.fire) {
        const fired = await this.options.fire({
          entry,
          occurrence,
          missed: plan.missed,
          signal: lost.signal,
        });
        if (fired) hold = fired;
        lastOccurrence = occurrence;
      }
    } catch (error) {
      status = 'error';
      errorMessage = toError(error).message;
    } finally {
      await stopRenewing();
    }

    const durationMs = Date.now() - startedAt;
    if (status === 'ok' && hold !== undefined && plan.next === null) {
      await store.update(entry.id, {
        firesAt: hold.holdUntil,
        lastRunAt: startedAt,
        ...(lastOccurrence !== undefined && { lastOccurrence }),
      });
      await claims.release(entry);
      this.options.onRunComplete?.(entry, status, undefined, durationMs);
      return;
    }
    const patch: Partial<TimerEntry> = { lastRunAt: startedAt, lastRunStatus: status };
    if (lastOccurrence !== undefined) patch.lastOccurrence = lastOccurrence;
    if (status === 'error') {
      patch.lastError = errorMessage;
      patch.consecutiveErrors = meta.bestEffort ? 0 : (entry.consecutiveErrors ?? 0) + 1;
    } else {
      patch.consecutiveErrors = 0;
      patch.lastError = undefined;
    }

    await store.update(entry.id, patch);
    const repeating =
      Boolean(entry.cron) || (entry.type === 'recurring' && Boolean(entry.interval));
    const next =
      this.options.nextFire && repeating ? this.options.nextFire(entry, Date.now()) : plan.next;
    const retry = status === 'error' && next === null && !meta.bestEffort;

    if ((this.options.reschedule ?? 'update') === 'update') {
      if (next !== null) {
        await store.update(entry.id, { firesAt: next });
        await claims.release(entry);
      } else if (!retry) {
        await store.markFired(entry.id);
      }
      this.options.onRunComplete?.(entry, status, errorMessage, durationMs);
      return;
    }

    if (!retry) await store.markFired(entry.id);
    this.options.onRunComplete?.(entry, status, errorMessage, durationMs);
    if (next !== null) {
      await store.schedule({
        workflowId: entry.workflowId ?? 'heartbeat',
        runId: entry.runId ?? 'scheduler',
        nodeId: entry.nodeId ?? 'task',
        firesAt: next,
        type: entry.type ?? (entry.cron ? 'cron' : 'recurring'),
        ...(entry.cron ? { cron: entry.cron } : {}),
        ...(entry.timezone ? { timezone: entry.timezone } : {}),
        ...(entry.interval ? { interval: entry.interval } : {}),
        ...(entry.catchUp ? { catchUp: entry.catchUp } : {}),
        ...(entry.catchUpWindowMs !== undefined && { catchUpWindowMs: entry.catchUpWindowMs }),
        ...(entry.trigger ? { trigger: entry.trigger } : {}),
        metadata: meta,
        name: entry.name,
        lastRunAt: patch.lastRunAt,
        lastRunStatus: patch.lastRunStatus,
        ...(patch.lastError ? { lastError: patch.lastError } : {}),
        ...(lastOccurrence !== undefined && { lastOccurrence }),
        consecutiveErrors: patch.consecutiveErrors,
      });
    }
  }

  private plan(entry: TimerEntry, now: number): OccurrencePlan {
    const pollInterval = this.options.pollInterval ?? 1000;
    const repeating =
      Boolean(entry.cron) || (entry.type === 'recurring' && Boolean(entry.interval));
    const plan = planOccurrences(
      {
        firesAt: entry.firesAt,
        ...(entry.cron && { cron: entry.cron }),
        ...(entry.timezone && { timezone: entry.timezone }),
        ...(repeating && entry.interval && { interval: entry.interval }),
        ...(entry.catchUp && { catchUp: entry.catchUp }),
        ...(entry.catchUpWindowMs !== undefined && { catchUpWindowMs: entry.catchUpWindowMs }),
      },
      this.engine,
      {
        now,
        graceMs: this.options.graceMs ?? Math.max(pollInterval * 2, 60_000),
        ...(this.options.maxCatchUp !== undefined && { maxCatchUp: this.options.maxCatchUp }),
      }
    );
    return repeating ? plan : { ...plan, next: null };
  }
}
