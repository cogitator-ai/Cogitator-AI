import { nanoid } from 'nanoid';
import Redis from 'ioredis';
import { parseModel } from '@cogitator-ai/core';
import type {
  SwarmConfig,
  SwarmAgent,
  RunResult,
  Tool,
  ToolSchema,
  DistributedSwarmConfig,
} from '@cogitator-ai/types';
import { RedisMessageBus } from '../communication/redis-message-bus.js';
import { RedisBlackboard } from '../communication/redis-blackboard.js';
import { RedisSwarmEventEmitter } from '../communication/redis-event-emitter.js';
import { BaseSwarmCoordinator, type AgentRunRequest } from '../base-coordinator.js';

export interface DistributedCoordinatorOptions {
  config: SwarmConfig;
  distributed: DistributedSwarmConfig;
}

/**
 * Agent configuration as it travels to worker nodes. Tools travel as schemas and are
 * resolved by name against the worker's own tool registry.
 */
export interface SerializedSwarmAgentConfig {
  name: string;
  instructions: string;
  /** Model string exactly as configured on the agent (may include a provider prefix) */
  model: string;
  /** Provider resolved on the coordinator side */
  provider: string;
  temperature?: number;
  maxTokens?: number;
  maxIterations?: number;
  tools: ToolSchema[];
}

export interface SwarmAgentJobPayload {
  type: 'swarm-agent';
  jobId: string;
  swarmId: string;
  agentName: string;
  agentConfig: SerializedSwarmAgentConfig;
  input: string;
  context?: Record<string, unknown>;
  runOptions?: {
    threadId?: string;
    timeout?: number;
    saveHistory?: boolean;
  };
  stateKeys: {
    blackboard: string;
    messages: string;
    results: string;
  };
}

export interface SwarmAgentJobResult {
  jobId: string;
  swarmId: string;
  agentName: string;
  output: string;
  structured?: unknown;
  toolCalls: { name: string; input: unknown; output: unknown }[];
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
  resolve: (result: SwarmAgentJobResult) => void;
  reject: (error: Error) => void;
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
      messageBus: new RedisMessageBus(
        options.config.messaging ?? { enabled: true, protocol: 'direct' },
        { redis, swarmId, keyPrefix }
      ),
      blackboard: new RedisBlackboard(
        options.config.blackboard ?? { enabled: true, sections: {}, trackHistory: true },
        { redis, swarmId, keyPrefix }
      ),
      events: new RedisSwarmEventEmitter({ redis, swarmId, keyPrefix }),
    });

    this.distributed = options.distributed;
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
    const payload = this.createJobPayload(request);
    const jobResult = await this.dispatchJobAndWait(payload, request);
    return this.toRunResult(request.swarmAgent, jobResult);
  }

  private createJobPayload(request: AgentRunRequest): SwarmAgentJobPayload {
    const { agent, input, context } = request;
    const parsed = parseModel(agent.model);

    return {
      type: 'swarm-agent',
      jobId: `job_${nanoid(12)}`,
      swarmId: this.swarmId,
      agentName: request.swarmAgent.agent.name,
      agentConfig: {
        name: agent.name,
        instructions: agent.instructions,
        model: agent.model,
        provider: agent.config.provider ?? parsed.provider ?? 'ollama',
        temperature: agent.config.temperature,
        maxTokens: agent.config.maxTokens,
        maxIterations: agent.config.maxIterations,
        tools: agent.tools.map((t) => t.toJSON()),
      },
      input,
      context,
      runOptions: {
        threadId: request.threadId,
        timeout: request.timeout,
        saveHistory: request.saveHistory,
      },
      stateKeys: {
        blackboard: `${this.keyPrefix}:${this.swarmId}:blackboard`,
        messages: `${this.keyPrefix}:${this.swarmId}:messages`,
        results: this.resultsChannel(),
      },
    };
  }

  private dispatchJobAndWait(
    payload: SwarmAgentJobPayload,
    request: AgentRunRequest
  ): Promise<SwarmAgentJobResult> {
    const timeout = this.distributed.timeout ?? 300000;
    const queueKey = swarmJobQueueKey(this.keyPrefix, this.distributed.queue);

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
        reject(new Error(`Job timeout for agent '${payload.agentName}' after ${timeout}ms`));
      }, timeout);

      if (request.signal.aborted) {
        onAbort();
        return;
      }
      request.signal.addEventListener('abort', onAbort, { once: true });

      this.pendingJobs.set(payload.jobId, {
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });

      this.redis.rpush(queueKey, JSON.stringify(payload)).catch((error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private toRunResult(swarmAgent: SwarmAgent, jobResult: SwarmAgentJobResult): RunResult {
    return {
      output: jobResult.output,
      structured: jobResult.structured,
      runId: `run_${nanoid(8)}`,
      agentId: swarmAgent.agent.id,
      threadId: '',
      usage: {
        inputTokens: jobResult.tokenUsage.prompt,
        outputTokens: jobResult.tokenUsage.completion,
        totalTokens: jobResult.tokenUsage.total,
        cost: 0,
        duration: 0,
      },
      toolCalls: jobResult.toolCalls.map((tc) => ({
        id: nanoid(8),
        name: tc.name,
        arguments: isRecord(tc.input) ? tc.input : {},
      })),
      messages: [],
      trace: { traceId: `trace_${nanoid(12)}`, spans: [] },
    };
  }

  async reset(): Promise<void> {
    this.rejectPendingJobs(new Error('Swarm was reset'));
    super.reset();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    this.rejectPendingJobs(new Error('Distributed swarm coordinator closed'));
    this.subscriber.off('message', this.handleResultMessage);

    await this.messageBus.close();
    await this.blackboard.close();
    await this.events.close();
    await closeRedis(this.subscriber);
    await closeRedis(this.redis);
  }

  private rejectPendingJobs(error: Error): void {
    const pending = Array.from(this.pendingJobs.values());
    this.pendingJobs.clear();
    for (const job of pending) {
      job.reject(error);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function closeRedis(client: Redis): Promise<void> {
  if (client.status === 'end') return;
  if (client.status === 'wait') {
    client.disconnect();
    return;
  }
  await client.quit();
}
