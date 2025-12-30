/**
 * Worker Pool for distributed job processing
 *
 * Manages multiple BullMQ workers that process agent, workflow, and swarm jobs.
 * Supports graceful shutdown and health monitoring.
 */

import { Worker, Job } from 'bullmq';
import type {
  WorkerConfig,
  JobPayload,
  JobResult,
  QueueMetrics,
} from './types.js';
import { processAgentJob } from './processors/agent.js';
import { processWorkflowJob } from './processors/workflow.js';
import { processSwarmJob } from './processors/swarm.js';

const DEFAULT_QUEUE_NAME = 'cogitator-jobs';

export interface WorkerPoolEvents {
  onJobStarted?: (jobId: string, type: JobPayload['type']) => void;
  onJobCompleted?: (jobId: string, result: JobResult) => void;
  onJobFailed?: (jobId: string, error: Error) => void;
  onWorkerError?: (error: Error) => void;
}

export class WorkerPool {
  private workers: Worker<JobPayload, JobResult>[] = [];
  private readonly config: WorkerConfig;
  private readonly events: WorkerPoolEvents;
  private isRunning = false;

  constructor(config: WorkerConfig, events: WorkerPoolEvents = {}) {
    this.config = config;
    this.events = events;
  }

  /**
   * Start the worker pool
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    const workerCount = this.config.workerCount ?? 1;
    const concurrency = this.config.concurrency ?? 5;

    const connection = this.config.redis.cluster
      ? {
          host: this.config.redis.cluster.nodes[0]?.host ?? 'localhost',
          port: this.config.redis.cluster.nodes[0]?.port ?? 6379,
          password: this.config.redis.password,
        }
      : {
          host: this.config.redis.host ?? 'localhost',
          port: this.config.redis.port ?? 6379,
          password: this.config.redis.password,
        };

    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker<JobPayload, JobResult>(
        this.config.name ?? DEFAULT_QUEUE_NAME,
        async (job) => this.processJob(job),
        {
          connection,
          prefix: this.config.redis.cluster ? '{cogitator}' : 'cogitator',
          concurrency,
          lockDuration: this.config.lockDuration ?? 30000,
          stalledInterval: this.config.stalledInterval ?? 30000,
        }
      );

      worker.on('completed', (job, result) => {
        this.events.onJobCompleted?.(job.id ?? job.data.jobId, result);
      });

      worker.on('failed', (job, error) => {
        if (job) {
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
   * Process a job based on its type
   */
  private async processJob(job: Job<JobPayload>): Promise<JobResult> {
    this.events.onJobStarted?.(job.id ?? job.data.jobId, job.data.type);

    switch (job.data.type) {
      case 'agent':
        return processAgentJob(job.data);
      case 'workflow':
        return processWorkflowJob(job.data);
      case 'swarm':
        return processSwarmJob(job.data);
      default: {
        const _exhaustive: never = job.data;
        throw new Error(`Unknown job type: ${(_exhaustive as JobPayload).type}`);
      }
    }
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
   * Waits for active jobs to complete before closing
   */
  async stop(timeout = 30000): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    // Close all workers with timeout
    await Promise.race([
      Promise.all(this.workers.map((w) => w.close())),
      new Promise<void>((resolve) => setTimeout(resolve, timeout)),
    ]);

    this.workers = [];
  }

  /**
   * Force shutdown without waiting for jobs
   */
  async forceStop(): Promise<void> {
    this.isRunning = false;
    await Promise.all(this.workers.map((w) => w.close(true)));
    this.workers = [];
  }
}
