import { nanoid } from 'nanoid';
import Redis from 'ioredis';
import type {
  Agent,
  AgentWireConfig,
  AgentWireRunResult,
  AgentWireUsage,
  SwarmConfig,
  SwarmAgent,
  RunResult,
  Tool,
  DistributedSwarmConfig,
} from '@cogitator-ai/types';
import { fromAgentWireRunResult, toAgentWire } from '@cogitator-ai/core';
import { RedisMessageBus } from '../communication/redis-message-bus.js';
import { RedisBlackboard } from '../communication/redis-blackboard.js';
import { RedisSwarmEventEmitter } from '../communication/redis-event-emitter.js';
import {
  BaseSwarmCoordinator,
  computeBackoffDelay,
  toError,
  type AgentRunRequest,
} from '../base-coordinator.js';

export interface DistributedCoordinatorOptions {
  config: SwarmConfig;
  distributed: DistributedSwarmConfig;
  /** The model an agent runs on when it sets none, e.g. `(agent) => cogitator.resolveModel(agent)` */
  resolveModel?: (agent: Agent) => string;
}

/**
 * Agent configuration as it travels to worker nodes: the agent wire format of
 * `@cogitator-ai/core` (`toAgentWire`), the same one worker queue jobs use.
 *
 * @deprecated Use `AgentWireConfig` from `@cogitator-ai/types`
 */
export type SerializedSwarmAgentConfig = AgentWireConfig;

export interface SwarmAgentJobPayload {
  type: 'swarm-agent';
  jobId: string;
  swarmId: string;
  agentName: string;
  agentConfig: AgentWireConfig;
  input: string;
  context?: Record<string, unknown>;
  runOptions?: {
    threadId?: string;
    userId?: string;
    timeout?: number;
    saveHistory?: boolean;
  };
  stateKeys: {
    blackboard: string;
    messages: string;
    results: string;
    /**
     * Redis set of the job ids the coordinator gave up on (the run was aborted or timed out, the
     * swarm closed, or another attempt of the turn already answered). A worker skips such a job
     * and aborts it when it shows up while the turn runs
     */
    cancelled?: string;
  };
}

/**
 * Outcome of one agent turn, published by the worker: the run result wire format of
 * `@cogitator-ai/core` (`toAgentWireRunResult`) tagged with the job, or an `error`.
 */
export interface SwarmAgentJobResult extends Omit<AgentWireRunResult, 'usage'> {
  jobId: string;
  swarmId: string;
  agentName: string;
  /** Usage with cost and duration; absent in results of workers that only report `tokenUsage` */
  usage?: AgentWireUsage;
  /** @deprecated Use `usage`, which also carries cost, duration and reasoning tokens */
  tokenUsage: { prompt: number; completion: number; total: number };
  error?: string;
}

/**
 * Redis list key that distributed swarm workers consume jobs from.
 */
export function swarmJobQueueKey(keyPrefix = 'swarm', queue = 'swarm-agent-jobs'): string {
  return `${keyPrefix}:jobs:${queue}`;
}

function isJobResult(value: unknown): value is SwarmAgentJobResult {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SwarmAgentJobResult>;
  return typeof candidate.jobId === 'string' && typeof candidate.agentName === 'string';
}

interface PendingJob {
  /** The payload as queued: LREM needs the exact string */
  raw: string;
  resolve: (result: SwarmAgentJobResult) => void;
  reject: (error: Error) => void;
}

/**
 * A dispatched turn timed out without the worker's answer. `withdrawn` tells whether the job was
 * still queued (and is now off the queue) or a worker may still be running it.
 */
class UnansweredJobError extends Error {
  constructor(
    message: string,
    readonly withdrawn: boolean
  ) {
    super(message);
    this.name = 'UnansweredJobError';
  }
}

export class DistributedSwarmCoordinator extends BaseSwarmCoordinator<
  RedisMessageBus,
  RedisBlackboard,
  RedisSwarmEventEmitter
> {
  private readonly distributed: DistributedSwarmConfig;
  private readonly redis: Redis;
  private readonly subscriber: Redis;
  private readonly keyPrefix: string;
  private readonly pendingJobs = new Map<string, PendingJob>();
  private initialization?: Promise<void>;
  private closed = false;
  private readonly resolveAgentModel: (agent: Agent) => string;

  constructor(options: DistributedCoordinatorOptions) {
    const keyPrefix = options.distributed.redis?.keyPrefix ?? 'swarm';
    const swarmId = `swarm_${nanoid(12)}`;
    const redisOptions = {
      host: options.distributed.redis?.host ?? 'localhost',
      port: options.distributed.redis?.port ?? 6379,
      password: options.distributed.redis?.password,
      db: options.distributed.redis?.db ?? 0,
      lazyConnect: true,
    };
    const redis = new Redis(redisOptions);

    super(options.config, swarmId, {
      messageBus: new RedisMessageBus(options.config.messaging ?? { enabled: true }, {
        redis,
        swarmId,
        keyPrefix,
      }),
      blackboard: new RedisBlackboard(
        options.config.blackboard ?? { enabled: true, sections: {}, trackHistory: true },
        { redis, swarmId, keyPrefix }
      ),
      events: new RedisSwarmEventEmitter({ redis, swarmId, keyPrefix }),
    });

    this.distributed = options.distributed;
    this.resolveAgentModel =
      options.resolveModel ??
      ((agent) => {
        if (!agent.model) {
          throw new Error(
            `Agent "${agent.name}" has no model: set one, or pass resolveModel to the coordinator`
          );
        }
        return agent.model;
      });
    this.keyPrefix = keyPrefix;
    this.redis = redis;
    this.subscriber = new Redis(redisOptions);
  }

  /**
   * Connect to Redis and subscribe to shared state and job results. Safe to call repeatedly.
   */
  initialize(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('Distributed swarm coordinator has been closed'));
    }
    this.initialization ??= this.connect().catch((error: unknown) => {
      this.initialization = undefined;
      throw error;
    });
    return this.initialization;
  }

  protected prepare(): Promise<void> {
    return this.initialize();
  }

  private async connect(): Promise<void> {
    await this.messageBus.initialize();
    await this.blackboard.initialize();
    await this.events.initialize();

    this.subscriber.on('message', this.handleResultMessage);
    await this.subscriber.subscribe(this.resultsChannel());
  }

  private resultsChannel(): string {
    return `${this.keyPrefix}:${this.swarmId}:results`;
  }

  private readonly handleResultMessage = (_channel: string, messageJson: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(messageJson);
    } catch (error) {
      console.warn('[DistributedSwarmCoordinator] Failed to parse result message:', error);
      return;
    }

    if (!isJobResult(parsed)) {
      console.warn('[DistributedSwarmCoordinator] Ignoring malformed job result');
      return;
    }

    const pending = this.pendingJobs.get(parsed.jobId);
    if (!pending) return;
    this.pendingJobs.delete(parsed.jobId);

    if (parsed.error !== undefined) {
      pending.reject(new Error(parsed.error));
    } else {
      pending.resolve(parsed);
    }
  };

  /**
   * Strategy tools are bound to this process (they call back into the coordinator and the
   * local blackboard), so they cannot run on remote workers. Worker agents use the tools
   * registered on the worker instead.
   */
  protected strategyTools(): Tool[] {
    return [];
  }

  protected async executeRun(request: AgentRunRequest): Promise<RunResult> {
    const jobResult = await this.dispatchWithRetry(request);
    return this.toRunResult(request.swarmAgent, jobResult, request);
  }

  /**
   * Dispatch the agent turn as a job, re-dispatching it per `distributed.retry` when it fails
   * on a worker or times out. Cancellation is never retried. Every attempt carries the same job
   * id and payload, a timed-out attempt is taken off the queue before the next one is pushed,
   * and once the turn settles any copy a worker may still hold is cancelled, so an abandoned
   * turn never runs on its own later.
   */
  private async dispatchWithRetry(request: AgentRunRequest): Promise<SwarmAgentJobResult> {
    const retry = this.distributed.retry;
    const maxRetries = retry ? Math.max(0, retry.maxRetries ?? 3) : 0;
    const payload = this.createJobPayload(request);
    const raw = JSON.stringify(payload);
    let abandoned = false;

    try {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.dispatchJobAndWait(payload, raw, request);
        } catch (error) {
          if (error instanceof UnansweredJobError && !error.withdrawn) abandoned = true;
          if (attempt >= maxRetries || request.signal.aborted || this.closed) throw error;

          const delay = computeBackoffDelay(
            retry?.backoff ?? 'exponential',
            attempt + 1,
            retry?.initialDelay ?? 1000,
            retry?.maxDelay ?? 30000
          );
          await abortableDelay(delay, request.signal);
        }
      }
    } finally {
      if (!this.closed && (abandoned || request.signal.aborted)) {
        await this.cancelJob(payload.jobId, raw);
      }
    }
  }

  private createJobPayload(request: AgentRunRequest): SwarmAgentJobPayload {
    const { agent, input, context } = request;

    return {
      type: 'swarm-agent',
      jobId: `job_${nanoid(12)}`,
      swarmId: this.swarmId,
      agentName: request.swarmAgent.agent.name,
      agentConfig: toAgentWire(agent, { resolveModel: this.resolveAgentModel }),
      input,
      context,
      runOptions: {
        threadId: request.threadId,
        userId: request.userId,
        timeout: request.timeout,
        saveHistory: request.saveHistory,
      },
      stateKeys: {
        blackboard: `${this.keyPrefix}:${this.swarmId}:blackboard`,
        messages: `${this.keyPrefix}:${this.swarmId}:messages`,
        results: this.resultsChannel(),
        cancelled: this.cancelledKey(),
      },
    };
  }

  private queueKey(): string {
    return swarmJobQueueKey(this.keyPrefix, this.distributed.queue);
  }

  private cancelledKey(): string {
    return `${this.keyPrefix}:${this.swarmId}:cancelled`;
  }

  /** Take a queued copy of the job off the queue; resolves to whether one was there. */
  private async withdrawJob(raw: string): Promise<boolean> {
    if (this.redis.status !== 'ready') return false;
    try {
      return (await this.redis.lrem(this.queueKey(), 0, raw)) > 0;
    } catch (error) {
      console.warn('[DistributedSwarmCoordinator] Failed to withdraw a job:', error);
      return false;
    }
  }

  /**
   * Make sure no copy of the job runs any more: take it off the queue and add its id to the
   * cancelled set that workers check before and while running a turn.
   */
  private async cancelJob(jobId: string, raw: string): Promise<void> {
    if (this.redis.status !== 'ready') return;
    const ttl = Math.max(
      this.distributed.timeout ?? 300000,
      this.distributed.cleanupAfter ?? 3600000
    );
    try {
      await this.redis
        .pipeline()
        .lrem(this.queueKey(), 0, raw)
        .sadd(this.cancelledKey(), jobId)
        .pexpire(this.cancelledKey(), ttl)
        .exec();
    } catch (error) {
      console.warn('[DistributedSwarmCoordinator] Failed to cancel a job:', error);
    }
  }

  private dispatchJobAndWait(
    payload: SwarmAgentJobPayload,
    raw: string,
    request: AgentRunRequest
  ): Promise<SwarmAgentJobResult> {
    const timeout = this.distributed.timeout ?? 300000;

    return new Promise<SwarmAgentJobResult>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeoutId);
        request.signal.removeEventListener('abort', onAbort);
        this.pendingJobs.delete(payload.jobId);
      };

      const onAbort = () => {
        cleanup();
        const reason: unknown = request.signal.reason;
        reject(reason instanceof Error ? reason : new Error('Swarm execution aborted'));
      };

      const timeoutId = setTimeout(() => {
        cleanup();
        void this.withdrawJob(raw).then((withdrawn) => {
          reject(
            new UnansweredJobError(
              `Job timeout for agent '${payload.agentName}' after ${timeout}ms`,
              withdrawn
            )
          );
        });
      }, timeout);

      if (request.signal.aborted) {
        onAbort();
        return;
      }
      request.signal.addEventListener('abort', onAbort, { once: true });

      this.pendingJobs.set(payload.jobId, {
        raw,
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });

      this.redis.rpush(this.queueKey(), raw).catch((error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  /**
   * The turn's result as a `RunResult`, with the usage and cost the worker reported, so resource
   * limits and strategies see the turn like a local one. A worker that only reports `tokenUsage`
   * gives the tokens without cost or duration.
   */
  private toRunResult(
    swarmAgent: SwarmAgent,
    jobResult: SwarmAgentJobResult,
    request: AgentRunRequest
  ): RunResult {
    const { usage, tokenUsage } = jobResult;
    return fromAgentWireRunResult(
      {
        ...jobResult,
        usage: usage ?? {
          inputTokens: tokenUsage.prompt,
          outputTokens: tokenUsage.completion,
          totalTokens: tokenUsage.total,
          cost: 0,
        },
      },
      { agentId: swarmAgent.agent.id, threadId: request.threadId }
    );
  }

  async reset(): Promise<void> {
    this.rejectPendingJobs(new Error('Swarm was reset'));
    super.reset();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const pending = Array.from(this.pendingJobs, ([jobId, job]) => ({ jobId, raw: job.raw }));
    await Promise.all(pending.map(({ jobId, raw }) => this.cancelJob(jobId, raw)));
    this.closed = true;

    this.rejectPendingJobs(new Error('Distributed swarm coordinator closed'));
    this.subscriber.off('message', this.handleResultMessage);

    await this.messageBus.close();
    await this.blackboard.close();
    await this.events.close();
    await this.scheduleStateCleanup();
    await closeRedis(this.subscriber);
    await closeRedis(this.redis);
  }

  /**
   * Expire the swarm's shared state in Redis `distributed.cleanupAfter` ms from now. Only a
   * connection that is still up is used; a coordinator that never connected left no state.
   */
  private async scheduleStateCleanup(): Promise<void> {
    if (this.redis.status !== 'ready') return;

    const ttl = Math.max(0, this.distributed.cleanupAfter ?? 3600000);
    const pattern = `${this.keyPrefix}:${this.swarmId}:*`;
    let cursor = '0';

    try {
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = next;
        if (keys.length === 0) continue;

        const pipeline = this.redis.pipeline();
        for (const key of keys) pipeline.pexpire(key, ttl);
        await pipeline.exec();
      } while (cursor !== '0');
    } catch (error) {
      console.warn('[DistributedSwarmCoordinator] Failed to schedule state cleanup:', error);
    }
  }

  private rejectPendingJobs(error: Error): void {
    const pending = Array.from(this.pendingJobs.values());
    this.pendingJobs.clear();
    for (const job of pending) {
      job.reject(error);
    }
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(toError(signal.reason));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(toError(signal.reason));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function closeRedis(client: Redis): Promise<void> {
  if (client.status === 'end') return;
  if (client.status === 'wait') {
    client.disconnect();
    return;
  }
  await client.quit();
}
