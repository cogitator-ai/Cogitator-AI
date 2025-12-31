/**
 * Workflow Scheduler
 *
 * Features:
 * - Priority queue for pending runs
 * - Cron-based scheduling
 * - Delayed execution
 * - Concurrency control
 */

import { nanoid } from 'nanoid';
import type {
  Workflow,
  WorkflowState,
  WorkflowRun,
  ScheduleOptions,
  RunStore,
} from '@cogitator-ai/types';
import { getNextCronOccurrence, validateCronExpression } from '../timers/cron-parser';

/**
 * Priority queue item
 */
export interface QueueItem {
  runId: string;
  workflowName: string;
  priority: number;
  scheduledFor: number;
}

/**
 * Scheduler configuration
 */
export interface SchedulerConfig {
  runStore: RunStore;
  maxConcurrency?: number;
  pollInterval?: number;
  onRunReady?: (runId: string) => void;
}

/**
 * Priority queue implementation using a heap
 */
export class PriorityQueue {
  private items: QueueItem[] = [];

  /**
   * Add item to queue (sorted by scheduledFor then priority)
   */
  enqueue(item: QueueItem): void {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  /**
   * Remove and return highest priority item
   */
  dequeue(): QueueItem | undefined {
    if (this.items.length === 0) return undefined;
    if (this.items.length === 1) return this.items.pop();

    const result = this.items[0];
    this.items[0] = this.items.pop()!;
    this.bubbleDown(0);
    return result;
  }

  /**
   * Peek at highest priority item without removing
   */
  peek(): QueueItem | undefined {
    return this.items[0];
  }

  /**
   * Remove item by runId
   */
  remove(runId: string): boolean {
    const index = this.items.findIndex((item) => item.runId === runId);
    if (index === -1) return false;

    if (index === this.items.length - 1) {
      this.items.pop();
    } else {
      this.items[index] = this.items.pop()!;
      this.bubbleDown(index);
      this.bubbleUp(index);
    }
    return true;
  }

  /**
   * Get items ready to execute (scheduledFor <= now)
   */
  getReady(now: number = Date.now()): QueueItem[] {
    const ready: QueueItem[] = [];

    while (this.items.length > 0) {
      const top = this.items[0];
      if (top.scheduledFor > now) break;
      ready.push(this.dequeue()!);
    }

    return ready;
  }

  /**
   * Get queue size
   */
  size(): number {
    return this.items.length;
  }

  /**
   * Clear the queue
   */
  clear(): void {
    this.items = [];
  }

  /**
   * Get all items (for inspection)
   */
  getAll(): QueueItem[] {
    return [...this.items];
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.compare(this.items[index], this.items[parentIndex]) >= 0) break;

      [this.items[index], this.items[parentIndex]] = [this.items[parentIndex], this.items[index]];
      index = parentIndex;
    }
  }

  private bubbleDown(index: number): void {
    while (true) {
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;
      let smallest = index;

      if (
        leftChild < this.items.length &&
        this.compare(this.items[leftChild], this.items[smallest]) < 0
      ) {
        smallest = leftChild;
      }

      if (
        rightChild < this.items.length &&
        this.compare(this.items[rightChild], this.items[smallest]) < 0
      ) {
        smallest = rightChild;
      }

      if (smallest === index) break;

      [this.items[index], this.items[smallest]] = [this.items[smallest], this.items[index]];
      index = smallest;
    }
  }

  private compare(a: QueueItem, b: QueueItem): number {
    if (a.scheduledFor !== b.scheduledFor) {
      return a.scheduledFor - b.scheduledFor;
    }
    return a.priority - b.priority;
  }
}

/**
 * Cron-based scheduled job
 */
export interface CronJob {
  id: string;
  workflowName: string;
  workflow: Workflow<WorkflowState>;
  expression: string;
  timezone?: string;
  options?: Omit<ScheduleOptions, 'at' | 'cron' | 'timezone'>;
  nextRun: number;
  enabled: boolean;
}

/**
 * Job scheduler for workflow runs
 */
export class JobScheduler {
  private queue = new PriorityQueue();
  private cronJobs = new Map<string, CronJob>();
  private runStore: RunStore;
  private maxConcurrency: number;
  private pollInterval: number;
  private onRunReady?: (runId: string) => void;
  private runningCount = 0;
  private pollTimer?: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(config: SchedulerConfig) {
    this.runStore = config.runStore;
    this.maxConcurrency = config.maxConcurrency ?? Infinity;
    this.pollInterval = config.pollInterval ?? 1000;
    this.onRunReady = config.onRunReady;
  }

  /**
   * Start the scheduler
   */
  start(): void {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(() => {
      this.tick();
    }, this.pollInterval);

    this.tick();
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /**
   * Schedule a workflow run
   */
  async scheduleRun<S extends WorkflowState>(
    workflow: Workflow<S>,
    options: ScheduleOptions = {}
  ): Promise<string> {
    const runId = nanoid();
    const now = Date.now();

    let scheduledFor = now;
    if (options.at) {
      scheduledFor = options.at;
    } else if (options.cron) {
      validateCronExpression(options.cron);
      scheduledFor = getNextCronOccurrence(options.cron, {
        currentDate: new Date(),
        timezone: options.timezone,
      }).getTime();
    }

    const run: WorkflowRun = {
      id: runId,
      workflowName: workflow.name,
      status: scheduledFor > now ? 'scheduled' : 'pending',
      state: options.input ?? {},
      input: options.input,
      currentNodes: [],
      completedNodes: [],
      failedNodes: [],
      scheduledFor: scheduledFor > now ? scheduledFor : undefined,
      priority: options.priority ?? 0,
      tags: options.tags ?? [],
      triggerId: options.triggerId,
      traceId: options.traceContext?.traceId,
      metadata: {
        baggage: options.baggage,
        timeout: options.timeout,
        maxRetries: options.maxRetries,
      },
    };

    await this.runStore.save(run);

    this.queue.enqueue({
      runId,
      workflowName: workflow.name,
      priority: options.priority ?? 0,
      scheduledFor,
    });

    return runId;
  }

  /**
   * Register a cron-based recurring job
   */
  registerCronJob<S extends WorkflowState>(
    workflow: Workflow<S>,
    expression: string,
    options: {
      id?: string;
      timezone?: string;
      jobOptions?: Omit<ScheduleOptions, 'at' | 'cron' | 'timezone'>;
    } = {}
  ): string {
    validateCronExpression(expression);

    const jobId = options.id ?? nanoid();
    const nextRun = getNextCronOccurrence(expression, {
      currentDate: new Date(),
      timezone: options.timezone,
    }).getTime();

    const job: CronJob = {
      id: jobId,
      workflowName: workflow.name,
      workflow: workflow as unknown as Workflow<WorkflowState>,
      expression,
      timezone: options.timezone,
      options: options.jobOptions,
      nextRun,
      enabled: true,
    };

    this.cronJobs.set(jobId, job);

    return jobId;
  }

  /**
   * Unregister a cron job
   */
  unregisterCronJob(jobId: string): boolean {
    return this.cronJobs.delete(jobId);
  }

  /**
   * Enable/disable a cron job
   */
  setCronJobEnabled(jobId: string, enabled: boolean): boolean {
    const job = this.cronJobs.get(jobId);
    if (!job) return false;

    job.enabled = enabled;
    if (enabled) {
      job.nextRun = getNextCronOccurrence(job.expression, {
        currentDate: new Date(),
        timezone: job.timezone,
      }).getTime();
    }

    return true;
  }

  /**
   * Cancel a scheduled run
   */
  async cancelRun(runId: string, reason?: string): Promise<boolean> {
    const run = await this.runStore.get(runId);
    if (!run) return false;

    if (run.status !== 'scheduled' && run.status !== 'pending') {
      return false;
    }

    this.queue.remove(runId);

    await this.runStore.update(runId, {
      status: 'cancelled',
      completedAt: Date.now(),
      error: reason ? { name: 'CancelError', message: reason } : undefined,
    });

    return true;
  }

  /**
   * Mark run as started
   */
  runStarted(_runId: string): void {
    this.runningCount++;
  }

  /**
   * Mark run as completed
   */
  runCompleted(_runId: string): void {
    this.runningCount = Math.max(0, this.runningCount - 1);
  }

  /**
   * Get queue size
   */
  getQueueSize(): number {
    return this.queue.size();
  }

  /**
   * Get running count
   */
  getRunningCount(): number {
    return this.runningCount;
  }

  /**
   * Get all cron jobs
   */
  getCronJobs(): CronJob[] {
    return Array.from(this.cronJobs.values());
  }

  /**
   * Dispose the scheduler
   */
  dispose(): void {
    this.disposed = true;
    this.stop();
    this.queue.clear();
    this.cronJobs.clear();
  }

  private tick(): void {
    if (this.disposed) return;

    const now = Date.now();

    for (const job of this.cronJobs.values()) {
      if (!job.enabled) continue;

      if (job.nextRun <= now) {
        void this.scheduleRun(job.workflow, {
          ...job.options,
          triggerId: `cron:${job.id}`,
        });

        job.nextRun = getNextCronOccurrence(job.expression, {
          currentDate: new Date(now + 1000),
          timezone: job.timezone,
        }).getTime();
      }
    }

    if (this.runningCount >= this.maxConcurrency) return;

    const ready = this.queue.getReady(now);

    for (const item of ready) {
      if (this.runningCount >= this.maxConcurrency) {
        this.queue.enqueue(item);
        break;
      }

      this.onRunReady?.(item.runId);
    }
  }
}

/**
 * Create a job scheduler
 */
export function createJobScheduler(config: SchedulerConfig): JobScheduler {
  return new JobScheduler(config);
}
