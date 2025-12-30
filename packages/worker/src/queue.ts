/**
 * Job Queue for distributed agent execution
 *
 * Uses BullMQ with Redis for reliable job processing with:
 * - Automatic retries with exponential backoff
 * - Job priorities
 * - Delayed execution
 * - Rate limiting
 */

import { Queue, type Job } from 'bullmq';
import { nanoid } from 'nanoid';
import type {
  QueueConfig,
  QueueMetrics,
  JobPayload,
  AgentJobPayload,
  WorkflowJobPayload,
  SwarmJobPayload,
  SerializedAgent,
  SerializedWorkflow,
  SerializedSwarm,
} from './types';

const DEFAULT_QUEUE_NAME = 'cogitator-jobs';

export class JobQueue {
  private queue: Queue<JobPayload>;
  private readonly config: QueueConfig;

  constructor(config: QueueConfig) {
    this.config = config;

    const connection = config.redis.cluster
      ? {
          host: config.redis.cluster.nodes[0]?.host ?? 'localhost',
          port: config.redis.cluster.nodes[0]?.port ?? 6379,
          password: config.redis.password,
        }
      : {
          host: config.redis.host ?? 'localhost',
          port: config.redis.port ?? 6379,
          password: config.redis.password,
        };

    this.queue = new Queue(config.name ?? DEFAULT_QUEUE_NAME, {
      connection,
      prefix: config.redis.cluster ? '{cogitator}' : 'cogitator',
      defaultJobOptions: {
        attempts: config.defaultJobOptions?.attempts ?? 3,
        backoff: config.defaultJobOptions?.backoff ?? {
          type: 'exponential',
          delay: 1000,
        },
        removeOnComplete: config.defaultJobOptions?.removeOnComplete ?? 100,
        removeOnFail: config.defaultJobOptions?.removeOnFail ?? 500,
      },
    });
  }

  /**
   * Add an agent execution job to the queue
   */
  async addAgentJob(
    agentConfig: SerializedAgent,
    input: string,
    options?: {
      threadId?: string;
      priority?: number;
      delay?: number;
      metadata?: Record<string, unknown>;
    }
  ): Promise<Job<AgentJobPayload>> {
    const jobId = nanoid();
    const threadId = options?.threadId ?? nanoid();

    const payload: AgentJobPayload = {
      type: 'agent',
      jobId,
      agentConfig,
      input,
      threadId,
      metadata: options?.metadata,
    };

    return this.queue.add('agent', payload, {
      jobId,
      priority: options?.priority,
      delay: options?.delay,
    }) as Promise<Job<AgentJobPayload>>;
  }

  /**
   * Add a workflow execution job to the queue
   */
  async addWorkflowJob(
    workflowConfig: SerializedWorkflow,
    input: Record<string, unknown>,
    options?: {
      runId?: string;
      priority?: number;
      delay?: number;
      metadata?: Record<string, unknown>;
    }
  ): Promise<Job<WorkflowJobPayload>> {
    const jobId = nanoid();
    const runId = options?.runId ?? nanoid();

    const payload: WorkflowJobPayload = {
      type: 'workflow',
      jobId,
      workflowConfig,
      input,
      runId,
      metadata: options?.metadata,
    };

    return this.queue.add('workflow', payload, {
      jobId,
      priority: options?.priority,
      delay: options?.delay,
    }) as Promise<Job<WorkflowJobPayload>>;
  }

  /**
   * Add a swarm execution job to the queue
   */
  async addSwarmJob(
    swarmConfig: SerializedSwarm,
    input: string,
    options?: {
      priority?: number;
      delay?: number;
      metadata?: Record<string, unknown>;
    }
  ): Promise<Job<SwarmJobPayload>> {
    const jobId = nanoid();

    const payload: SwarmJobPayload = {
      type: 'swarm',
      jobId,
      swarmConfig,
      input,
      metadata: options?.metadata,
    };

    return this.queue.add('swarm', payload, {
      jobId,
      priority: options?.priority,
      delay: options?.delay,
    }) as Promise<Job<SwarmJobPayload>>;
  }

  /**
   * Get job by ID
   */
  async getJob(jobId: string): Promise<Job<JobPayload> | undefined> {
    return this.queue.getJob(jobId);
  }

  /**
   * Get job state
   */
  async getJobState(jobId: string): Promise<string> {
    const job = await this.queue.getJob(jobId);
    if (!job) return 'unknown';
    return job.getState();
  }

  /**
   * Get queue metrics for monitoring and HPA
   */
  async getMetrics(): Promise<QueueMetrics> {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
      this.queue.getDelayedCount(),
    ]);

    return {
      waiting,
      active,
      completed,
      failed,
      delayed,
      depth: waiting + delayed,
      workerCount: 0,
    };
  }

  /**
   * Pause the queue
   */
  async pause(): Promise<void> {
    await this.queue.pause();
  }

  /**
   * Resume the queue
   */
  async resume(): Promise<void> {
    await this.queue.resume();
  }

  /**
   * Clean old jobs
   */
  async clean(
    grace: number,
    limit: number,
    type: 'completed' | 'failed' | 'delayed' | 'active' | 'wait'
  ): Promise<string[]> {
    return this.queue.clean(grace, limit, type);
  }

  /**
   * Get the underlying BullMQ queue (for advanced usage)
   */
  getQueue(): Queue<JobPayload> {
    return this.queue;
  }

  /**
   * Close the queue connection
   */
  async close(): Promise<void> {
    await this.queue.close();
  }
}
