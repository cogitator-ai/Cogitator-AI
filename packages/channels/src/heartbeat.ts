import type { ChannelMessage, TimerStore, TimerEntry } from '@cogitator-ai/types';
import {
  experimental_agentTaskInput,
  experimental_createTriggerEvent,
  experimental_Scheduler,
} from '@cogitator-ai/core';
import { channelsCron, getNextCronMs } from './cron';

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

function readString(meta: Record<string, unknown>, key: string): string | undefined {
  const value = meta[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Fires the tasks of a `TimerStore` as messages to the gateway: tasks agents gave themselves with
 * `schedule_task`, kept in `~/.cogitator/timers.json`. It is a client of the core's scheduler, so
 * claims, retries and cron times work as they do for routines. A task's description reaches the
 * agent as data (`source: 'agent'`), not as instructions. Entries of the trigger manager
 * (`entry.trigger`) are left to it
 */
export class HeartbeatScheduler {
  private readonly scheduler: experimental_Scheduler;

  constructor(
    private store: TimerStore,
    private config: HeartbeatConfig
  ) {
    this.scheduler = new experimental_Scheduler({
      store,
      cron: channelsCron,
      fire: ({ entry }) => this.config.onFire(this.messageOf(entry)),
      accepts: (entry) => entry.trigger === undefined,
      pollInterval: config.pollInterval ?? 30_000,
      batchSize: Number.MAX_SAFE_INTEGER,
      ...(config.staggerMs !== undefined && { staggerMs: config.staggerMs }),
      maxRetries: config.maxRetries ?? 5,
      reschedule: 'append',
      nextFire: (entry, now) => this.computeNextFire(entry, now),
      cleanup: 'cutoff',
      ...(config.retentionMs !== undefined && { retentionMs: config.retentionMs }),
      ...(config.onRunComplete && { onRunComplete: config.onRunComplete }),
      ...(config.onError && { onError: config.onError }),
      ...(config.onClaimLost && { onClaimLost: config.onClaimLost }),
    });
  }

  start(): void {
    this.scheduler.startNow();
  }

  stop(): void {
    void this.scheduler.stop();
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

  /**
   * The message a task sends: to the `channel`, `channelId`, `topicId` and `conversationId` of its
   * metadata, those it has, with its description wrapped as data the agent wrote earlier
   */
  private messageOf(entry: TimerEntry): ChannelMessage {
    const meta = entry.metadata ?? {};
    const description = readString(meta, 'description') ?? entry.name ?? '';
    const userId = readString(meta, 'userId');
    const topicId = readString(meta, 'topicId');
    const conversationId = readString(meta, 'conversationId');
    const event = experimental_createTriggerEvent({
      source: 'agent',
      triggerId: entry.id,
      verified: { method: 'agent', ok: true },
      text: description,
      scheduledFor: entry.firesAt,
    });
    return {
      id: `heartbeat_${entry.id}`,
      channelType: readString(meta, 'channel') ?? 'system',
      channelId: readString(meta, 'channelId') ?? userId ?? 'system',
      userId: userId ?? 'system',
      ...(topicId && { topicId }),
      ...(conversationId && { conversationId }),
      text: experimental_agentTaskInput(event),
      raw: { scheduled: true, taskId: entry.id, trigger: event },
    };
  }

  private computeNextFire(entry: TimerEntry, now: number): number | null {
    if (entry.cron) {
      return this.config.getNextCronMs
        ? this.config.getNextCronMs(entry.cron)
        : getNextCronMs(entry.cron, now, entry.timezone);
    }
    if (entry.type === 'recurring' && entry.interval) {
      return now + entry.interval;
    }
    return null;
  }
}
