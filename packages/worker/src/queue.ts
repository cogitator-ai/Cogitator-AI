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
  SwarmAgentJobPayload,
  SerializedAgent,
  SerializedWorkflow,
  SerializedSwarm,
} from './types';
import {
  DEFAULT_QUEUE_NAME,
  createBullConnection,
  queuePrefix,
  type BullConnection,
} from './connection.js';

export class JobQueue {
  private queue: Queue<JobPayload>;
  private connection: BullConnection;

  constructor(config: QueueConfig) {
    this.connection = createBullConnection(config.redis);
    this.queue = new Queue(config.name ?? DEFAULT_QUEUE_NAME, {
      connection: this.connection.connection,
      prefix: queuePrefix(config.redis),
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
   * Add a distributed swarm agent job to the queue
   * Used by DistributedSwarmCoordinator for per-agent job dispatch
   */
  async addSwarmAgentJob(
    swarmId: string,
    agentName: string,
    agentConfig: SerializedAgent,
    input: string,
    options?: {
      context?: Record<string, unknown>;
      stateKeys?: SwarmAgentJobPayload['stateKeys'];
      runOptions?: SwarmAgentJobPayload['runOptions'];
      /** Key prefix used by the swarm's Redis state (default: 'swarm') */
      keyPrefix?: string;
      priority?: number;
      delay?: number;
      /** Agent run timeout in ms (shorthand for `runOptions.timeout`) */
      timeout?: number;
    }
  ): Promise<Job<SwarmAgentJobPayload>> {
    const jobId = nanoid();
    const keyPrefix = options?.keyPrefix ?? 'swarm';

    const payload: SwarmAgentJobPayload = {
      type: 'swarm-agent',
      jobId,
      swarmId,
      agentName,
      agentConfig,
      input,
      context: options?.context,
      runOptions:
        options?.timeout !== undefined
          ? { ...options.runOptions, timeout: options.timeout }
          : options?.runOptions,
      stateKeys: options?.stateKeys ?? {
        blackboard: `${keyPrefix}:${swarmId}:blackboard`,
        messages: `${keyPrefix}:${swarmId}:messages`,
        results: `${keyPrefix}:${swarmId}:results`,
      },
    };

    return this.queue.add('swarm-agent', payload, {
      jobId,
      priority: options?.priority,
      delay: options?.delay,
    }) as Promise<Job<SwarmAgentJobPayload>>;
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
    const [waiting, active, completed, failed, delayed, workerCount] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
      this.queue.getDelayedCount(),
      this.queue.getWorkersCount(),
    ]);

    return {
      waiting,
      active,
      completed,
      failed,
      delayed,
      depth: waiting + delayed,
      workerCount,
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
    await this.connection.dispose();
  }
}
