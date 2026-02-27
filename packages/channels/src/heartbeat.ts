import type { ChannelMessage, TimerStore, TimerEntry } from '@cogitator-ai/types';

export interface HeartbeatConfig {
  onFire: (msg: ChannelMessage) => Promise<void> | void;
  pollInterval?: number;
  getNextCronMs?: (cron: string) => number;
}

export class HeartbeatScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private store: TimerStore,
    private config: HeartbeatConfig
  ) {}

  start(): void {
    void this.processOverdue();
    this.timer = setInterval(() => void this.processOverdue(), this.config.pollInterval ?? 30_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async processOverdue(): Promise<void> {
    const overdue = await this.store.getOverdue();

    for (const entry of overdue) {
      const meta = (entry.metadata ?? {}) as Record<string, unknown>;

      const msg: ChannelMessage = {
        id: `heartbeat_${entry.id}`,
        channelType: (meta.channel as string) ?? 'system',
        channelId: (meta.channelId as string) ?? (meta.userId as string) ?? 'system',
        userId: (meta.userId as string) ?? 'system',
        text: (meta.description as string) ?? '',
        raw: { scheduled: true, taskId: entry.id },
      };

      await this.config.onFire(msg);
      await this.store.markFired(entry.id);

      if (entry.cron) {
        await this.reschedule(entry, meta);
      }
    }
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
    });
  }
}
