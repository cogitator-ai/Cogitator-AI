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
import type { ToolApprovalDecision } from '@cogitator-ai/types';
import type {
  JobState,
  QueueConfig,
  QueueMetrics,
  JobPayload,
  AgentJobPayload,
  AgentJobResult,
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
      userId?: string;
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
      ...(options?.userId !== undefined && { userId: options.userId }),
      metadata: options?.metadata,
    };

    return this.queue.add('agent', payload, {
      jobId,
      priority: options?.priority,
      delay: options?.delay,
    }) as Promise<Job<AgentJobPayload>>;
  }

  /**
   * Continue an agent job whose run paused for tool approvals (its result has
   * `status: 'paused'`) with the decisions for the waiting calls. The paused result's checkpoint
   * travels with the new job, so any worker can run it; a result without one is resumed from the
   * worker's `runCheckpoints` store by its thread. Calls without a decision pause the run again,
   * and the new job's result says so the same way.
   *
   * @example
   * ```ts
   * const paused = (await job.waitUntilFinished(events)) as AgentJobResult;
   * if (paused.status === 'paused') {
   *   const next = await queue.resumeAgentJob(agentConfig, paused, {
   *     decisions: { [paused.pendingApprovals![0].toolCallId]: { approved: true } },
   *   });
   * }
   * ```
   *
   * @throws Error when the result is not a paused run, or names no thread to resume
   */
  async resumeAgentJob(
    agentConfig: SerializedAgent,
    paused: Pick<AgentJobResult, 'status' | 'threadId' | 'checkpoint'>,
    options?: {
      /** Decisions for the waiting calls, by tool call id */
      decisions?: Record<string, ToolApprovalDecision>;
      /** Decision for every waiting call `decisions` leaves out */
      defaultDecision?: ToolApprovalDecision;
      /** Who resumes the run; when set it must be the user the run belongs to */
      userId?: string;
      priority?: number;
      delay?: number;
      metadata?: Record<string, unknown>;
    }
  ): Promise<Job<AgentJobPayload>> {
    if (paused.status !== undefined && paused.status !== 'paused') {
      throw new Error(`Cannot resume an agent job whose run is ${paused.status}, not paused`);
    }
    const threadId = paused.checkpoint?.threadId ?? paused.threadId;
    if (!threadId) {
      throw new Error('Cannot resume an agent job without the checkpoint or thread of its run');
    }
    const jobId = nanoid();

    const payload: AgentJobPayload = {
      type: 'agent',
      jobId,
      agentConfig,
      input: '',
      threadId,
      ...(options?.userId !== undefined && { userId: options.userId }),
      resume: {
        ...(paused.checkpoint && { checkpoint: paused.checkpoint }),
        ...(options?.decisions && { decisions: options.decisions }),
        ...(options?.defaultDecision && { defaultDecision: options.defaultDecision }),
      },
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
   * Queue one agent turn of a swarm as a BullMQ job. A `WorkerPool` runs it and publishes the
   * result to `stateKeys.results` (by default `${keyPrefix}:${swarmId}:results`). Swarms with
   * `distributed.enabled` do not use this queue: `DistributedSwarmCoordinator` pushes its turns
   * to a Redis list that `DistributedSwarmWorker` consumes, so run that worker for them.
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
   * State of a job, `'unknown'` when the queue does not have it (never added, or removed
   * after completing or failing). A job added with a `priority` waits as `'prioritized'`
   */
  async getJobState(jobId: string): Promise<JobState> {
    const job = await this.queue.getJob(jobId);
    if (!job) return 'unknown';
    return job.getState();
  }

  /**
   * Get queue metrics for monitoring and HPA. `waiting` counts jobs ready to run, those
   * added with a `priority` included, and `depth` adds the delayed ones
   */
  async getMetrics(): Promise<QueueMetrics> {
    const [counts, workerCount] = await Promise.all([
      this.queue.getJobCounts('waiting', 'prioritized', 'active', 'completed', 'failed', 'delayed'),
      this.queue.getWorkersCount(),
    ]);
    const waiting = (counts.waiting ?? 0) + (counts.prioritized ?? 0);
    const delayed = counts.delayed ?? 0;

    return {
      waiting,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
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
