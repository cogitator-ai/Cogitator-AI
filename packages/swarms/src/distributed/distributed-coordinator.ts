import { nanoid } from 'nanoid';
import Redis from 'ioredis';
import type {
  SwarmConfig,
  SwarmAgent,
  SwarmAgentMetadata,
  SwarmAgentState,
  RunResult,
  MessageBus,
  Blackboard,
  SwarmEventEmitter,
  SwarmCoordinatorInterface,
  Agent,
  DistributedSwarmConfig,
} from '@cogitator-ai/types';
import { RedisMessageBus } from '../communication/redis-message-bus.js';
import { RedisBlackboard } from '../communication/redis-blackboard.js';
import { RedisSwarmEventEmitter } from '../communication/redis-event-emitter.js';

export interface DistributedCoordinatorOptions {
  config: SwarmConfig;
  distributed: DistributedSwarmConfig;
}

export interface SwarmAgentJobPayload {
  type: 'swarm-agent';
  jobId: string;
  swarmId: string;
  agentName: string;
  agentConfig: SerializedAgentConfig;
  input: string;
  context?: Record<string, unknown>;
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

interface SerializedAgentConfig {
  name: string;
  instructions: string;
  model: string;
  provider: string;
  temperature?: number;
  maxTokens?: number;
  tools: unknown[];
}

export class DistributedSwarmCoordinator implements SwarmCoordinatorInterface {
  private config: SwarmConfig;
  private distributed: DistributedSwarmConfig;
  private redis!: Redis;
  private subscriber!: Redis;
  private redisConfig: { host: string; port: number; password?: string; db: number };
  private agents = new Map<string, SwarmAgent>();
  private _messageBus!: RedisMessageBus;
  private _blackboard!: RedisBlackboard;
  private _events!: RedisSwarmEventEmitter;
  private swarmId: string;
  private keyPrefix: string;
  private resultHandlers = new Map<string, (result: SwarmAgentJobResult) => void>();
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  private initialized = false;
  private aborted = false;
  private paused = false;

  constructor(options: DistributedCoordinatorOptions) {
    this.config = options.config;
    this.distributed = options.distributed;
    this.swarmId = `swarm_${nanoid(12)}`;
    this.keyPrefix = options.distributed.redis?.keyPrefix ?? 'swarm';

    this.redisConfig = {
      host: options.distributed.redis?.host ?? 'localhost',
      port: options.distributed.redis?.port ?? 6379,
      password: options.distributed.redis?.password,
      db: options.distributed.redis?.db ?? 0,
    };

    this.initializeAgents();
  }

  private initializeAgents(): void {
    const agentEntries: { agent: Agent; metadata: SwarmAgentMetadata }[] = [];

    if (this.config.supervisor) {
      agentEntries.push({
        agent: this.config.supervisor,
        metadata: { role: 'supervisor', priority: 100 },
      });
    }

    if (this.config.workers) {
      for (const worker of this.config.workers) {
        agentEntries.push({
          agent: worker,
          metadata: { role: 'worker', priority: 50 },
        });
      }
    }

    if (this.config.agents) {
      for (const agent of this.config.agents) {
        agentEntries.push({ agent, metadata: {} });
      }
    }

    if (this.config.moderator) {
      agentEntries.push({
        agent: this.config.moderator,
        metadata: { role: 'moderator', priority: 90 },
      });
    }

    if (this.config.router) {
      agentEntries.push({
        agent: this.config.router,
        metadata: { role: 'router', priority: 95 },
      });
    }

    if (this.config.stages) {
      for (const stage of this.config.stages) {
        agentEntries.push({
          agent: stage.agent,
          metadata: { custom: { stageName: stage.name, isGate: stage.gate } },
        });
      }
    }

    if (this.config.pipeline?.stages) {
      for (const stage of this.config.pipeline.stages) {
        agentEntries.push({
          agent: stage.agent,
          metadata: { custom: { stageName: stage.name, isGate: stage.gate } },
        });
      }
    }

    for (const { agent, metadata } of agentEntries) {
      this.agents.set(agent.name, {
        agent,
        metadata,
        state: 'idle',
        messageCount: 0,
        tokenCount: 0,
      });
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.redis = new Redis(this.redisConfig);
    this.subscriber = new Redis(this.redisConfig);

    this._messageBus = new RedisMessageBus(
      this.config.messaging ?? { enabled: true, protocol: 'direct' },
      { redis: this.redis, swarmId: this.swarmId, keyPrefix: this.keyPrefix }
    );

    this._blackboard = new RedisBlackboard(
      this.config.blackboard ?? { enabled: true, sections: {}, trackHistory: true },
      { redis: this.redis, swarmId: this.swarmId, keyPrefix: this.keyPrefix }
    );

    this._events = new RedisSwarmEventEmitter({
      redis: this.redis,
      swarmId: this.swarmId,
      keyPrefix: this.keyPrefix,
    });

    await this._messageBus.initialize();
    await this._blackboard.initialize();
    await this._events.initialize();

    await this.subscribeToResults();

    this.initialized = true;
  }

  private async subscribeToResults(): Promise<void> {
    const resultsChannel = `${this.keyPrefix}:${this.swarmId}:results`;
    await this.subscriber.subscribe(resultsChannel);

    this.subscriber.on('message', (_channel, messageJson) => {
      try {
        const result = JSON.parse(messageJson) as SwarmAgentJobResult;
        const handler = this.resultHandlers.get(result.jobId);
        if (handler) {
          handler(result);
          this.resultHandlers.delete(result.jobId);
        }
      } catch (error) {
        console.warn('[DistributedSwarmCoordinator] Failed to process result message:', error);
      }
    });
  }

  get messageBus(): MessageBus {
    return this._messageBus;
  }

  get blackboard(): Blackboard {
    return this._blackboard;
  }

  get events(): SwarmEventEmitter {
    return this._events;
  }

  getSwarmId(): string {
    return this.swarmId;
  }

  getAgent(name: string): SwarmAgent | undefined {
    return this.agents.get(name);
  }

  getAgents(): SwarmAgent[] {
    return Array.from(this.agents.values());
  }

  getAgentsByRole(role: SwarmAgentMetadata['role']): SwarmAgent[] {
    return this.getAgents().filter((a) => a.metadata.role === role);
  }

  async runAgent(
    agentName: string,
    input: string,
    context?: Record<string, unknown>
  ): Promise<RunResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    const swarmAgent = this.agents.get(agentName);
    if (!swarmAgent) {
      throw new Error(`Agent '${agentName}' not found in swarm`);
    }

    while (this.paused && !this.aborted) {
      await new Promise((r) => setTimeout(r, 100));
    }

    if (this.aborted) {
      throw new Error('Swarm execution aborted');
    }

    this.setAgentState(agentName, 'running');
    await this._events.emitAsync('agent:start', { agentName, input }, agentName);

    const jobPayload = this.createJobPayload(swarmAgent, input, context);

    try {
      const result = await this.dispatchJobAndWait(jobPayload);

      this.setAgentState(agentName, 'completed');
      swarmAgent.tokenCount += result.tokenUsage.total;

      const runResult = this.toRunResult(swarmAgent, result);
      swarmAgent.lastResult = runResult;

      await this._events.emitAsync('agent:complete', { agentName, result: runResult }, agentName);

      return runResult;
    } catch (error) {
      this.setAgentState(agentName, 'failed');
      await this._events.emitAsync('agent:error', { agentName, error }, agentName);
      throw error;
    }
  }

  async runAgentsParallel(
    agents: { name: string; input: string; context?: Record<string, unknown> }[],
    maxConcurrency?: number
  ): Promise<Map<string, RunResult>> {
    const concurrency = maxConcurrency ?? this.config.resources?.maxConcurrency ?? 4;
    const results = new Map<string, RunResult>();

    for (let i = 0; i < agents.length; i += concurrency) {
      const chunk = agents.slice(i, i + concurrency);
      const chunkResults = await Promise.allSettled(
        chunk.map(async ({ name, input, context }) => {
          const result = await this.runAgent(name, input, context);
          return { name, result };
        })
      );

      for (const settled of chunkResults) {
        if (settled.status === 'fulfilled') {
          results.set(settled.value.name, settled.value.result);
        } else {
          if (this.config.errorHandling?.onAgentFailure === 'skip') {
            continue;
          } else if (this.config.errorHandling?.onAgentFailure === 'abort') {
            throw settled.reason;
          } else {
            throw settled.reason;
          }
        }
      }
    }

    return results;
  }

  private createJobPayload(
    swarmAgent: SwarmAgent,
    input: string,
    context?: Record<string, unknown>
  ): SwarmAgentJobPayload {
    const agent = swarmAgent.agent;

    const agentConfig: SerializedAgentConfig = {
      name: agent.name,
      instructions: agent.instructions,
      model: agent.model,
      provider: this.extractProvider(agent.model),
      temperature: agent.config.temperature,
      maxTokens: agent.config.maxTokens,
      tools: agent.tools.map((t) => t.toJSON()),
    };

    return {
      type: 'swarm-agent',
      jobId: `job_${nanoid(12)}`,
      swarmId: this.swarmId,
      agentName: agent.name,
      agentConfig,
      input,
      context: {
        ...context,
        swarmContext: {
          swarmId: this.swarmId,
          swarmName: this.config.name,
          agentRole: swarmAgent.metadata.role,
          availableAgents: Array.from(this.agents.keys()).filter((n) => n !== agent.name),
        },
      },
      stateKeys: {
        blackboard: `${this.keyPrefix}:${this.swarmId}:blackboard`,
        messages: `${this.keyPrefix}:${this.swarmId}:messages`,
        results: `${this.keyPrefix}:${this.swarmId}:results`,
      },
    };
  }

  private extractProvider(model: string): string {
    if (model.includes('/')) {
      return model.split('/')[0];
    }
    return 'openai';
  }

  private async dispatchJobAndWait(payload: SwarmAgentJobPayload): Promise<SwarmAgentJobResult> {
    const timeout = this.distributed.timeout ?? 300000;
    const queueName = this.distributed.queue ?? 'swarm-agent-jobs';

    const jobKey = `${this.keyPrefix}:jobs:${queueName}`;
    await this.redis.rpush(jobKey, JSON.stringify(payload));

    return new Promise<SwarmAgentJobResult>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingTimers.delete(timeoutId);
        this.resultHandlers.delete(payload.jobId);
        reject(new Error(`Job timeout for agent '${payload.agentName}' after ${timeout}ms`));
      }, timeout);

      this.pendingTimers.add(timeoutId);

      this.resultHandlers.set(payload.jobId, (result) => {
        clearTimeout(timeoutId);
        this.pendingTimers.delete(timeoutId);
        if (result.error) {
          reject(new Error(result.error));
        } else {
          resolve(result);
        }
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
        arguments: (tc.input ?? {}) as Record<string, unknown>,
        result: tc.output,
      })),
      messages: [],
      trace: { traceId: `trace_${nanoid(12)}`, spans: [] },
    };
  }

  private setAgentState(agentName: string, state: SwarmAgentState): void {
    const agent = this.agents.get(agentName);
    if (agent) {
      agent.state = state;
    }
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  abort(): void {
    this.aborted = true;
  }

  isAborted(): boolean {
    return this.aborted;
  }

  isPaused(): boolean {
    return this.paused;
  }

  async reset(): Promise<void> {
    this.aborted = false;
    this.paused = false;

    for (const agent of this.agents.values()) {
      agent.state = 'idle';
      agent.lastResult = undefined;
      agent.messageCount = 0;
      agent.tokenCount = 0;
    }

    if (this._messageBus) {
      await this._messageBus.clear();
    }
    if (this._blackboard) {
      await this._blackboard.clear();
    }
  }

  async close(): Promise<void> {
    for (const timer of this.pendingTimers) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
    this.resultHandlers.clear();

    if (this._messageBus) {
      await this._messageBus.close();
    }
    if (this._blackboard) {
      await this._blackboard.close();
    }
    if (this._events) {
      await this._events.close();
    }
    if (this.subscriber) {
      await this.subscriber.unsubscribe();
      await this.subscriber.quit();
    }
    if (this.redis) {
      await this.redis.quit();
    }
  }
}
