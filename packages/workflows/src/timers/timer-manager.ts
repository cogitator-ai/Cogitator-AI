/**
 * Timer Manager for background processing
 *
 * Features:
 * - Background timer processing
 * - Timer recovery on restart
 * - Automatic retry for missed timers
 * - Cancellation support
 * - Cleanup of old timers
 */

import type { TimerEntry, TimerStore } from '@cogitator/types';

/**
 * Timer handler function
 */
export type TimerHandler = (entry: TimerEntry) => Promise<void> | void;

/**
 * Timer manager configuration
 */
export interface TimerManagerConfig {
  /**
   * Interval for checking overdue timers (ms)
   * @default 1000
   */
  pollInterval?: number;

  /**
   * Maximum number of timers to process per poll
   * @default 100
   */
  batchSize?: number;

  /**
   * Whether to process overdue timers on startup
   * @default true
   */
  processOverdueOnStart?: boolean;

  /**
   * Maximum age for cleanup (ms)
   * @default 7 days
   */
  cleanupMaxAge?: number;

  /**
   * Interval for cleanup (ms)
   * @default 1 hour
   */
  cleanupInterval?: number;

  /**
   * Whether to enable cleanup
   * @default true
   */
  enableCleanup?: boolean;

  /**
   * Handler for timer errors
   */
  onError?: (error: Error, entry: TimerEntry) => void;

  /**
   * Handler for timer fired events
   */
  onTimerFired?: (entry: TimerEntry) => void;

  /**
   * Handler for timer missed events (overdue timers)
   */
  onTimerMissed?: (entry: TimerEntry, delayMs: number) => void;
}

const DEFAULT_POLL_INTERVAL = 1000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_CLEANUP_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL = 60 * 60 * 1000;

/**
 * Timer manager stats
 */
export interface TimerManagerStats {
  running: boolean;
  processedTotal: number;
  errorTotal: number;
  overdueProcessed: number;
  cleanedUpTotal: number;
  lastPollAt?: number;
  lastCleanupAt?: number;
  activeTimers: number;
}

/**
 * Timer Manager class
 */
export class TimerManager {
  private store: TimerStore;
  private config: Required<
    Omit<TimerManagerConfig, 'onError' | 'onTimerFired' | 'onTimerMissed'>
  > &
    Pick<TimerManagerConfig, 'onError' | 'onTimerFired' | 'onTimerMissed'>;
  private handlers: Map<string, TimerHandler> = new Map();
  private defaultHandler?: TimerHandler;
  private pollTimer?: ReturnType<typeof setInterval>;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private running = false;
  private processing = false;

  private processedTotal = 0;
  private errorTotal = 0;
  private overdueProcessed = 0;
  private cleanedUpTotal = 0;
  private lastPollAt?: number;
  private lastCleanupAt?: number;

  constructor(store: TimerStore, config: TimerManagerConfig = {}) {
    this.store = store;
    this.config = {
      pollInterval: config.pollInterval ?? DEFAULT_POLL_INTERVAL,
      batchSize: config.batchSize ?? DEFAULT_BATCH_SIZE,
      processOverdueOnStart: config.processOverdueOnStart ?? true,
      cleanupMaxAge: config.cleanupMaxAge ?? DEFAULT_CLEANUP_MAX_AGE,
      cleanupInterval: config.cleanupInterval ?? DEFAULT_CLEANUP_INTERVAL,
      enableCleanup: config.enableCleanup ?? true,
      onError: config.onError,
      onTimerFired: config.onTimerFired,
      onTimerMissed: config.onTimerMissed,
    };
  }

  /**
   * Register a handler for a specific workflow
   */
  registerHandler(workflowId: string, handler: TimerHandler): () => void {
    this.handlers.set(workflowId, handler);
    return () => this.handlers.delete(workflowId);
  }

  /**
   * Set default handler for all timers without specific handler
   */
  setDefaultHandler(handler: TimerHandler): void {
    this.defaultHandler = handler;
  }

  /**
   * Start the timer manager
   */
  async start(): Promise<void> {
    if (this.running) return;

    this.running = true;

    if (this.config.processOverdueOnStart) {
      await this.processOverdueTimers();
    }

    this.pollTimer = setInterval(() => {
      this.poll().catch((error) => {
        this.config.onError?.(error as Error, {} as TimerEntry);
      });
    }, this.config.pollInterval);

    if (this.config.enableCleanup) {
      this.cleanupTimer = setInterval(() => {
        this.cleanup().catch((error) => {
          this.config.onError?.(error as Error, {} as TimerEntry);
        });
      }, this.config.cleanupInterval);
    }
  }

  /**
   * Stop the timer manager
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    while (this.processing) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Poll for overdue timers and process them
   */
  private async poll(): Promise<void> {
    if (!this.running || this.processing) return;

    this.processing = true;
    this.lastPollAt = Date.now();

    try {
      const overdue = await this.store.getOverdue();
      const batch = overdue.slice(0, this.config.batchSize);

      for (const entry of batch) {
        await this.processTimer(entry);
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Process overdue timers (for recovery)
   */
  private async processOverdueTimers(): Promise<void> {
    const overdue = await this.store.getOverdue();
    const now = Date.now();

    for (const entry of overdue) {
      const delayMs = now - entry.firesAt;
      this.config.onTimerMissed?.(entry, delayMs);
      this.overdueProcessed++;

      await this.processTimer(entry);
    }
  }

  /**
   * Process a single timer
   */
  private async processTimer(entry: TimerEntry): Promise<void> {
    try {
      const handler =
        this.handlers.get(entry.workflowId) ?? this.defaultHandler;

      if (handler) {
        await handler(entry);
      }

      await this.store.markFired(entry.id);

      this.processedTotal++;
      this.config.onTimerFired?.(entry);
    } catch (error) {
      this.errorTotal++;
      this.config.onError?.(error as Error, entry);
    }
  }

  /**
   * Run cleanup
   */
  private async cleanup(): Promise<void> {
    this.lastCleanupAt = Date.now();
    const count = await this.store.cleanup(this.config.cleanupMaxAge);
    this.cleanedUpTotal += count;
  }

  /**
   * Schedule a timer
   */
  async schedule(
    entry: Omit<TimerEntry, 'id' | 'cancelled' | 'fired' | 'createdAt'>
  ): Promise<string> {
    return this.store.schedule(entry);
  }

  /**
   * Cancel a timer
   */
  async cancel(timerId: string): Promise<void> {
    await this.store.cancel(timerId);
  }

  /**
   * Cancel all timers for a workflow run
   */
  async cancelRun(runId: string): Promise<number> {
    const timers = await this.store.getByRun(runId);
    let cancelled = 0;

    for (const timer of timers) {
      if (!timer.cancelled && !timer.fired) {
        await this.store.cancel(timer.id);
        cancelled++;
      }
    }

    return cancelled;
  }

  /**
   * Cancel all timers for a workflow
   */
  async cancelWorkflow(workflowId: string): Promise<number> {
    const timers = await this.store.getByWorkflow(workflowId);
    let cancelled = 0;

    for (const timer of timers) {
      if (!timer.cancelled && !timer.fired) {
        await this.store.cancel(timer.id);
        cancelled++;
      }
    }

    return cancelled;
  }

  /**
   * Get timer by ID
   */
  async getTimer(timerId: string): Promise<TimerEntry | null> {
    return this.store.get(timerId);
  }

  /**
   * Get all pending timers
   */
  async getPendingTimers(): Promise<TimerEntry[]> {
    return this.store.getPending();
  }

  /**
   * Get timers for a workflow
   */
  async getWorkflowTimers(workflowId: string): Promise<TimerEntry[]> {
    return this.store.getByWorkflow(workflowId);
  }

  /**
   * Get timers for a run
   */
  async getRunTimers(runId: string): Promise<TimerEntry[]> {
    return this.store.getByRun(runId);
  }

  /**
   * Get manager stats
   */
  async getStats(): Promise<TimerManagerStats> {
    const pending = await this.store.getPending();

    return {
      running: this.running,
      processedTotal: this.processedTotal,
      errorTotal: this.errorTotal,
      overdueProcessed: this.overdueProcessed,
      cleanedUpTotal: this.cleanedUpTotal,
      lastPollAt: this.lastPollAt,
      lastCleanupAt: this.lastCleanupAt,
      activeTimers: pending.length,
    };
  }

  /**
   * Force process overdue timers now
   */
  async processNow(): Promise<number> {
    const overdue = await this.store.getOverdue();
    let processed = 0;

    for (const entry of overdue) {
      await this.processTimer(entry);
      processed++;
    }

    return processed;
  }

  /**
   * Force cleanup now
   */
  async cleanupNow(): Promise<number> {
    return this.cleanup().then(() => this.cleanedUpTotal);
  }

  /**
   * Check if manager is running
   */
  isRunning(): boolean {
    return this.running;
  }
}

/**
 * Create a timer manager
 */
export function createTimerManager(
  store: TimerStore,
  config?: TimerManagerConfig
): TimerManager {
  return new TimerManager(store, config);
}

/**
 * Timer scheduler for recurring timers
 */
export class RecurringTimerScheduler {
  private manager: TimerManager;
  private recurring: Map<
    string,
    {
      workflowId: string;
      nodeId: string;
      interval: number;
      metadata?: Record<string, unknown>;
      currentTimerId?: string;
    }
  > = new Map();

  constructor(manager: TimerManager) {
    this.manager = manager;
  }

  /**
   * Schedule a recurring timer
   */
  async scheduleRecurring(
    id: string,
    config: {
      workflowId: string;
      runId: string;
      nodeId: string;
      interval: number;
      metadata?: Record<string, unknown>;
      startImmediately?: boolean;
    }
  ): Promise<void> {
    const { workflowId, runId, nodeId, interval, metadata, startImmediately } =
      config;

    this.recurring.set(id, {
      workflowId,
      nodeId,
      interval,
      metadata,
    });

    const firesAt = startImmediately ? Date.now() : Date.now() + interval;

    const timerId = await this.manager.schedule({
      workflowId,
      runId,
      nodeId,
      firesAt,
      type: 'recurring',
      metadata: { recurringId: id, ...metadata },
    });

    this.recurring.get(id)!.currentTimerId = timerId;
  }

  /**
   * Cancel a recurring timer
   */
  async cancelRecurring(id: string): Promise<void> {
    const config = this.recurring.get(id);
    if (!config) return;

    if (config.currentTimerId) {
      await this.manager.cancel(config.currentTimerId);
    }

    this.recurring.delete(id);
  }

  /**
   * Schedule next occurrence (called after timer fires)
   */
  async scheduleNext(
    id: string,
    runId: string
  ): Promise<string | null> {
    const config = this.recurring.get(id);
    if (!config) return null;

    const timerId = await this.manager.schedule({
      workflowId: config.workflowId,
      runId,
      nodeId: config.nodeId,
      firesAt: Date.now() + config.interval,
      type: 'recurring',
      metadata: { recurringId: id, ...config.metadata },
    });

    config.currentTimerId = timerId;
    return timerId;
  }

  /**
   * Check if recurring timer exists
   */
  hasRecurring(id: string): boolean {
    return this.recurring.has(id);
  }

  /**
   * Get all recurring timer IDs
   */
  getRecurringIds(): string[] {
    return Array.from(this.recurring.keys());
  }
}

/**
 * Create a recurring timer scheduler
 */
export function createRecurringScheduler(
  manager: TimerManager
): RecurringTimerScheduler {
  return new RecurringTimerScheduler(manager);
}
