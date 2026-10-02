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
        if (!this.running) break;
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

  private async processEntry(entry: TimerEntry): Promise<void> {
    if (entry.enabled === false) return;

    if ((entry.consecutiveErrors ?? 0) >= this.maxRetries) {
      if (entry.lastRunStatus !== 'skipped') {
        await this.store.update(entry.id, { lastRunStatus: 'skipped' });
      }
      return;
    }

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

    try {
      await this.config.onFire(msg);
    } catch (err) {
      status = 'error';
      errorMsg = toError(err).message;
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
