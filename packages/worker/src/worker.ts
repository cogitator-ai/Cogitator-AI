/**
 * Worker Pool for distributed job processing
 *
 * Manages multiple BullMQ workers that process agent, workflow, and swarm jobs.
 * Supports graceful shutdown and health monitoring.
 */

import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { Cogitator, findAgentRunPausedError } from '@cogitator-ai/core';
import type { WorkerConfig, JobPayload, JobResult, QueueMetrics, WorkerRuntime } from './types';
import { processAgentJob } from './processors/agent.js';
import { processWorkflowJob } from './processors/workflow.js';
import { processSwarmJob } from './processors/swarm.js';
import { processSwarmAgentJob } from './processors/swarm-agent.js';
import { MetricsCollector } from './metrics.js';
import {
  DEFAULT_QUEUE_NAME,
  createBullConnection,
  createRedisClient,
  queuePrefix,
  type BullConnection,
  type RedisClient,
} from './connection.js';

export interface WorkerPoolEvents {
  onJobStarted?: (jobId: string, type: JobPayload['type']) => void;
  onJobCompleted?: (jobId: string, result: JobResult) => void;
  onJobFailed?: (jobId: string, error: Error) => void;
  onWorkerError?: (error: Error) => void;
}

export class WorkerPool {
  private workers: Worker<JobPayload, JobResult>[] = [];
  private connections: BullConnection[] = [];
  private readonly config: WorkerConfig;
  private readonly events: WorkerPoolEvents;
  private readonly runtime: Required<WorkerRuntime>;
  private publisher?: RedisClient;
  private isRunning = false;

  /** Job duration and per-type counters, ready for Prometheus exposition */
  readonly metrics = new MetricsCollector();

  constructor(config: WorkerConfig, events: WorkerPoolEvents = {}) {
    this.config = config;
    this.events = events;
    this.runtime = {
      cogitator: config.cogitator ?? new Cogitator(),
      tools: config.tools ?? [],
    };
  }

  /**
   * Start the worker pool
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    const workerCount = this.config.workerCount ?? 1;
    const concurrency = this.config.concurrency ?? 5;

    for (let i = 0; i < workerCount; i++) {
      const connection = createBullConnection(this.config.redis, { blocking: true });
      this.connections.push(connection);
      const worker = new Worker<JobPayload, JobResult>(
        this.config.name ?? DEFAULT_QUEUE_NAME,
        async (job, _token, signal) => this.processJob(job, signal),
        {
          connection: connection.connection,
          prefix: queuePrefix(this.config.redis),
          concurrency,
          lockDuration: this.config.lockDuration ?? 30000,
          stalledInterval: this.config.stalledInterval ?? 30000,
        }
      );

      worker.on('completed', (job, result) => {
        if (job.processedOn !== undefined && job.finishedOn !== undefined) {
          this.metrics.recordJob(job.data.type, job.finishedOn - job.processedOn);
        }
        this.events.onJobCompleted?.(job.id ?? job.data.jobId, result);
      });

      worker.on('failed', (job, error) => {
        if (job) {
          if (job.finishedOn !== undefined) this.metrics.recordFailure(job.data.type);
          this.events.onJobFailed?.(job.id ?? job.data.jobId, error);
        }
      });

      worker.on('error', (error) => {
        this.events.onWorkerError?.(error);
      });

      this.workers.push(worker);
    }

    this.isRunning = true;
  }

  /**
   * Process a job based on its type. `signal` is the one BullMQ gives the job: it aborts on
   * `cancelJob()` and when a shutdown runs out of time, and reaches every agent run of the job.
   * A job cancelled while the pool runs fails without retries. One stopped by a shutdown is left
   * to BullMQ, which hands it to another worker once its lock expires. A workflow or swarm job
   * whose agent run paused for tool approvals fails without retries too: another attempt would
   * only pause again.
   */
  private async processJob(job: Job<JobPayload>, signal?: AbortSignal): Promise<JobResult> {
    this.events.onJobStarted?.(job.id ?? job.data.jobId, job.data.type);

    try {
      return await this.runJob(job, signal);
    } catch (error) {
      if (signal?.aborted && this.isRunning) {
        throw new UnrecoverableError(`Job cancelled: ${abortMessage(signal)}`);
      }
      const paused = findAgentRunPausedError(error);
      if (paused) throw new UnrecoverableError(paused.message);
      throw error;
    }
  }

  private runJob(job: Job<JobPayload>, signal?: AbortSignal): Promise<JobResult> {
    const execution = { ...(signal && { signal }) };
    switch (job.data.type) {
      case 'agent':
        return processAgentJob(job.data, this.runtime, execution);
      case 'workflow':
        return processWorkflowJob(job.data, this.runtime, execution);
      case 'swarm':
        return processSwarmJob(job.data, this.runtime, execution);
      case 'swarm-agent':
        return processSwarmAgentJob(job.data, {
          ...this.runtime,
          ...execution,
          publisher: this.getPublisher(),
          isFinalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
        });
      default: {
        const _exhaustive: never = job.data;
        throw new Error(`Unknown job type: ${(_exhaustive as JobPayload).type}`);
      }
    }
  }

  /**
   * Cancel a job this pool is running: its agent runs, workflow nodes and swarm turns are
   * aborted and the job fails without retries.
   *
   * @returns whether a worker of this pool was running the job
   */
  cancelJob(jobId: string, reason = 'Cancelled'): boolean {
    let found = false;
    for (const worker of this.workers) {
      if (worker.cancelJob(jobId, reason)) found = true;
    }
    return found;
  }

  private getPublisher(): RedisClient {
    this.publisher ??= createRedisClient(this.config.redis);
    return this.publisher;
  }

  /**
   * Get current worker count
   */
  getWorkerCount(): number {
    return this.workers.length;
  }

  /**
   * Check if pool is running
   */
  isPoolRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Get metrics including worker count
   */
  async getMetrics(baseMetrics: Omit<QueueMetrics, 'workerCount'>): Promise<QueueMetrics> {
    return {
      ...baseMetrics,
      workerCount: this.workers.length,
    };
  }

  /**
   * Graceful shutdown
   * Waits up to `timeout` ms for active jobs to complete. Then the jobs still running are
   * aborted (their agent runs stop) and the workers are force-closed, BullMQ handing those jobs
   * to another worker once their locks expire.
   */
  async stop(timeout = 30000): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;
    const workers = this.workers;
    this.workers = [];

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      Promise.all(workers.map((w) => w.close())).then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeout);
      }),
    ]);
    if (timer) clearTimeout(timer);

    if (timedOut) {
      for (const worker of workers) worker.cancelAllJobs('Worker pool stopped');
      await Promise.all(workers.map((w) => w.close(true)));
    }

    await this.releaseConnections();
  }

  /**
   * Force shutdown without waiting for jobs: the jobs still running are aborted
   */
  async forceStop(): Promise<void> {
    this.isRunning = false;
    const workers = this.workers;
    this.workers = [];
    for (const worker of workers) worker.cancelAllJobs('Worker pool stopped');
    await Promise.all(workers.map((w) => w.close(true)));
    await this.releaseConnections();
  }

  private async releaseConnections(): Promise<void> {
    const connections = this.connections;
    this.connections = [];
    await Promise.all(connections.map((c) => c.dispose()));
    await this.closePublisher();
  }

  private async closePublisher(): Promise<void> {
    const publisher = this.publisher;
    this.publisher = undefined;
    if (publisher) {
      await publisher.quit();
    }
  }
}

function abortMessage(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason.message;
  return typeof reason === 'string' && reason !== '' ? reason : 'aborted';
}
