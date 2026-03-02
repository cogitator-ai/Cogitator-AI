import type { ChannelMessage, TimerStore, TimerEntry } from '@cogitator-ai/types';

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
}

export class HeartbeatScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private readonly maxRetries: number;

  constructor(
    private store: TimerStore,
    private config: HeartbeatConfig
  ) {
    this.maxRetries = config.maxRetries ?? 5;
  }

  start(): void {
    const stagger = this.config.staggerMs ? Math.floor(Math.random() * this.config.staggerMs) : 0;

    const begin = () => {
      void this.processOverdue();
      this.timer = setInterval(
        () => void this.processOverdue(),
        this.config.pollInterval ?? 30_000
      );
    };

    if (stagger > 0) {
      setTimeout(begin, stagger);
    } else {
      begin();
    }
  }

  stop(): void {
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

    let overdue: TimerEntry[];
    try {
      overdue = await this.store.getOverdue();
    } catch {
      this.processing = false;
      return;
    }

    for (const entry of overdue) {
      if (entry.enabled === false) continue;
      if ((entry.consecutiveErrors ?? 0) >= this.maxRetries) {
        await this.store.update(entry.id, { lastRunStatus: 'skipped' });
        continue;
      }

      const meta = (entry.metadata ?? {}) as Record<string, unknown>;
      const description = (meta.description as string) ?? '';
      const msg: ChannelMessage = {
        id: `heartbeat_${entry.id}`,
        channelType: (meta.channel as string) ?? 'system',
        channelId: (meta.channelId as string) ?? (meta.userId as string) ?? 'system',
        userId: (meta.userId as string) ?? 'system',
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
        errorMsg = err instanceof Error ? err.message : String(err);
      }

      const durationMs = Date.now() - startedAt;

      const patch: Partial<TimerEntry> = {
        lastRunAt: startedAt,
        lastRunStatus: status,
      };

      if (status === 'error') {
        patch.lastError = errorMsg;
        if (meta.bestEffort) {
          patch.consecutiveErrors = 0;
        } else {
          patch.consecutiveErrors = (entry.consecutiveErrors ?? 0) + 1;
        }
      } else {
        patch.consecutiveErrors = 0;
        patch.lastError = undefined;
      }

      await this.store.update(entry.id, patch);
      await this.store.markFired(entry.id);

      this.config.onRunComplete?.(entry, status, errorMsg, durationMs);

      if (entry.cron) {
        await this.reschedule(entry, meta);
      } else if (entry.type === 'recurring' && entry.interval) {
        await this.rescheduleInterval(entry, meta);
      }
    }

    this.processing = false;
  }

  private async reschedule(entry: TimerEntry, meta: Record<string, unknown>): Promise<void> {
    const nextFire = this.config.getNextCronMs
      ? this.config.getNextCronMs(entry.cron!)
      : Date.now() + 60_000;

    await this.store.schedule({
      workflowId: 'heartbeat',
      runId: 'scheduler',
      nodeId: 'task',
      firesAt: nextFire,
      type: 'cron',
      cron: entry.cron,
      metadata: meta,
      name: entry.name,
    });
  }

  private async rescheduleInterval(
    entry: TimerEntry,
    meta: Record<string, unknown>
  ): Promise<void> {
    await this.store.schedule({
      workflowId: 'heartbeat',
      runId: 'scheduler',
      nodeId: 'task',
      firesAt: Date.now() + entry.interval!,
      type: 'recurring',
      interval: entry.interval,
      metadata: meta,
      name: entry.name,
    });
  }
}
