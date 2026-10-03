import type { ChannelMessage, TimerStore, TimerEntry } from '@cogitator-ai/types';
import { getNextCronMs } from './cron';

export interface HeartbeatConfig {
  onFire: (msg: ChannelMessage) => Promise<void> | void;
  pollInterval?: number;
  getNextCronMs?: (cron: string) => number;
  maxRetries?: number;
  staggerMs?: number;
  onRunComplete?: (
    entry: TimerEntry,
    status: 'ok' | 'error',
    error?: string,
    durationMs?: number
  ) => void;
  onError?: (error: Error, entry?: TimerEntry) => void;
  /**
   * Called when a store that claims timers says this scheduler no longer holds the claim on a
   * task: before it fires (the task is then skipped, another worker has it) or while it runs
   * (its lease ran out before a renewal got through, so another worker may fire it too).
   */
  onClaimLost?: (entry: TimerEntry) => void;
  /** How long fired/cancelled entries are kept before cleanup. Default: 7 days. */
  retentionMs?: number;
}

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function readString(meta: Record<string, unknown>, key: string): string | undefined {
  const value = meta[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export class HeartbeatScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private staggerTimer: ReturnType<typeof setTimeout> | null = null;
  private processing = false;
  private running = false;
  private lastCleanupAt = 0;
  private readonly maxRetries: number;

  constructor(
    private store: TimerStore,
    private config: HeartbeatConfig
  ) {
    this.maxRetries = config.maxRetries ?? 5;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const stagger = this.config.staggerMs ? Math.floor(Math.random() * this.config.staggerMs) : 0;

    const begin = () => {
      this.staggerTimer = null;
      if (!this.running) return;
      void this.processOverdue();
      this.timer = setInterval(
        () => void this.processOverdue(),
        this.config.pollInterval ?? 30_000
      );
    };

    if (stagger > 0) {
      this.staggerTimer = setTimeout(begin, stagger);
    } else {
      begin();
    }
  }

  stop(): void {
    this.running = false;
    if (this.staggerTimer) {
      clearTimeout(this.staggerTimer);
      this.staggerTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async listJobs(): Promise<TimerEntry[]> {
    return this.store.list();
  }

  async getJob(id: string): Promise<TimerEntry | null> {
    return this.store.get(id);
  }

  async cancelJob(id: string): Promise<void> {
    return this.store.cancel(id);
  }

  async enableJob(id: string): Promise<void> {
    await this.store.update(id, { enabled: true, consecutiveErrors: 0 });
  }

  async disableJob(id: string): Promise<void> {
    await this.store.update(id, { enabled: false });
  }

  private async processOverdue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      const overdue = await this.store.getOverdue();
      for (const entry of overdue) {
        if (!this.running) {
          await this.releaseClaim(entry);
          continue;
        }
        try {
          await this.processEntry(entry);
        } catch (err) {
          this.config.onError?.(toError(err), entry);
        }
      }
      await this.cleanupIfDue();
    } catch (err) {
      this.config.onError?.(toError(err));
    } finally {
      this.processing = false;
    }
  }

  private async cleanupIfDue(): Promise<void> {
    const now = Date.now();
    if (now - this.lastCleanupAt < CLEANUP_INTERVAL_MS) return;
    this.lastCleanupAt = now;
    await this.store.cleanup(now - (this.config.retentionMs ?? DEFAULT_RETENTION_MS));
  }

  /**
   * Fire a single task. With a store that claims timers, the claim is renewed right before the
   * task fires (a task whose claim ran out while it waited is left to the worker that took it) and
   * every `claimTtl / 3` while it runs. Disabled and exhausted tasks are released so another
   * worker's poll is not blocked by this one's lease. A task that throws keeps the claim until its
   * lease runs out, which spaces out the retries.
   */
  private async processEntry(entry: TimerEntry): Promise<void> {
    if (entry.enabled === false) {
      await this.releaseClaim(entry);
      return;
    }

    if ((entry.consecutiveErrors ?? 0) >= this.maxRetries) {
      if (entry.lastRunStatus !== 'skipped') {
        await this.store.update(entry.id, { lastRunStatus: 'skipped' });
      }
      await this.releaseClaim(entry);
      return;
    }

    if (!(await this.confirmClaim(entry))) return;

    const meta = entry.metadata ?? {};
    const description = readString(meta, 'description') ?? entry.name ?? '';
    const userId = readString(meta, 'userId');
    const msg: ChannelMessage = {
      id: `heartbeat_${entry.id}`,
      channelType: readString(meta, 'channel') ?? 'system',
      channelId: readString(meta, 'channelId') ?? userId ?? 'system',
      userId: userId ?? 'system',
      text: `[SCHEDULED TASK] Execute this task that was scheduled earlier: "${description}". If it's a reminder — deliver it in a friendly way. If it's an action (e.g. check something, fetch data, run a tool) — do it and report the result.`,
      raw: { scheduled: true, taskId: entry.id },
    };

    const startedAt = Date.now();
    let status: 'ok' | 'error' = 'ok';
    let errorMsg: string | undefined;

    const stopRenewing = this.keepClaim(entry);
    try {
      await this.config.onFire(msg);
    } catch (err) {
      status = 'error';
      errorMsg = toError(err).message;
    } finally {
      await stopRenewing();
    }

    const durationMs = Date.now() - startedAt;

    const patch: Partial<TimerEntry> = {
      lastRunAt: startedAt,
      lastRunStatus: status,
    };

    if (status === 'error') {
      patch.lastError = errorMsg;
      patch.consecutiveErrors = meta.bestEffort ? 0 : (entry.consecutiveErrors ?? 0) + 1;
    } else {
      patch.consecutiveErrors = 0;
      patch.lastError = undefined;
    }

    await this.store.update(entry.id, patch);
    await this.store.markFired(entry.id);

    this.config.onRunComplete?.(entry, status, errorMsg, durationMs);

    const nextFiresAt = this.computeNextFire(entry);
    if (nextFiresAt !== null) {
      await this.store.schedule({
        workflowId: entry.workflowId ?? 'heartbeat',
        runId: entry.runId ?? 'scheduler',
        nodeId: entry.nodeId ?? 'task',
        firesAt: nextFiresAt,
        type: entry.type ?? (entry.cron ? 'cron' : 'recurring'),
        ...(entry.cron ? { cron: entry.cron } : {}),
        ...(entry.timezone ? { timezone: entry.timezone } : {}),
        ...(entry.interval ? { interval: entry.interval } : {}),
        metadata: meta,
        name: entry.name,
        lastRunAt: patch.lastRunAt,
        lastRunStatus: patch.lastRunStatus,
        ...(patch.lastError ? { lastError: patch.lastError } : {}),
        consecutiveErrors: patch.consecutiveErrors,
      });
    }
  }

  private async confirmClaim(entry: TimerEntry): Promise<boolean> {
    const store = this.store;
    if (!store.renew || !store.claimTtl) return true;
    try {
      if (await store.renew(entry.id)) return true;
      this.config.onClaimLost?.(entry);
    } catch (err) {
      this.config.onError?.(toError(err), entry);
    }
    return false;
  }

  /**
   * Renews the store's claim on a task every `claimTtl / 3` until the returned function is called;
   * it resolves once no renewal is in flight.
   */
  private keepClaim(entry: TimerEntry): () => Promise<void> {
    const store = this.store;
    const renew = store.renew;
    if (!renew || !store.claimTtl) return async () => undefined;

    let lost = false;
    let renewal: Promise<void> = Promise.resolve();
    const tick = async (): Promise<void> => {
      if (lost) return;
      try {
        if (await renew.call(store, entry.id)) return;
        lost = true;
        clearInterval(interval);
        this.config.onClaimLost?.(entry);
      } catch (err) {
        this.config.onError?.(toError(err), entry);
      }
    };
    const interval = setInterval(() => {
      renewal = renewal.then(tick);
    }, store.claimTtl / 3);

    return async () => {
      clearInterval(interval);
      await renewal;
    };
  }

  private async releaseClaim(entry: TimerEntry): Promise<void> {
    try {
      await this.store.release?.(entry.id);
    } catch (err) {
      this.config.onError?.(toError(err), entry);
    }
  }

  private computeNextFire(entry: TimerEntry): number | null {
    if (entry.cron) {
      return this.config.getNextCronMs
        ? this.config.getNextCronMs(entry.cron)
        : getNextCronMs(entry.cron, Date.now(), entry.timezone);
    }
    if (entry.type === 'recurring' && entry.interval) {
      return Date.now() + entry.interval;
    }
    return null;
  }
}
