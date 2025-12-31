/**
 * SwarmCoordinator - Execution engine for multi-agent swarms
 */

import { nanoid } from 'nanoid';
import type { Cogitator } from '@cogitator-ai/core';
import type {
  Agent,
  SwarmConfig,
  SwarmAgent,
  SwarmAgentMetadata,
  SwarmAgentState,
  RunResult,
  MessageBus,
  Blackboard,
  SwarmEventEmitter,
  SwarmCoordinatorInterface,
} from '@cogitator-ai/types';
import {
  SwarmEventEmitterImpl,
  InMemoryMessageBus,
  InMemoryBlackboard,
} from './communication/index';
import { ResourceTracker } from './resources/index';
import { CircuitBreaker } from './resources/circuit-breaker';

export class SwarmCoordinator implements SwarmCoordinatorInterface {
  private cogitator: Cogitator;
  private config: SwarmConfig;
  private agents = new Map<string, SwarmAgent>();
  private _messageBus: MessageBus;
  private _blackboard: Blackboard;
  private _events: SwarmEventEmitterImpl;
  private resourceTracker: ResourceTracker;
  private circuitBreaker?: CircuitBreaker;
  private aborted = false;
  private paused = false;
  private swarmId: string;

  constructor(cogitator: Cogitator, config: SwarmConfig) {
    this.cogitator = cogitator;
    this.config = config;
    this.swarmId = `swarm_${nanoid(12)}`;

    this._messageBus = new InMemoryMessageBus(
      config.messaging ?? { enabled: true, protocol: 'direct' }
    );

    this._blackboard = new InMemoryBlackboard(
      config.blackboard ?? { enabled: true, sections: {}, trackHistory: true }
    );

    this._events = new SwarmEventEmitterImpl();

    this.resourceTracker = new ResourceTracker(config.resources ?? {});

    if (config.errorHandling?.circuitBreaker?.enabled) {
      this.circuitBreaker = new CircuitBreaker({
        threshold: config.errorHandling.circuitBreaker.threshold,
        resetTimeout: config.errorHandling.circuitBreaker.resetTimeout,
      });
    }

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
    const swarmAgent = this.agents.get(agentName);
    if (!swarmAgent) {
      throw new Error(`Agent '${agentName}' not found in swarm`);
    }

    if (this.circuitBreaker && !this.circuitBreaker.canExecute()) {
      throw new Error(`Circuit breaker is open for swarm '${this.config.name}'`);
    }

    if (!this.resourceTracker.isWithinBudget()) {
      throw new Error('Swarm resource budget exceeded');
    }

    while (this.paused) {
      await new Promise((r) => setTimeout(r, 100));
    }

    if (this.aborted) {
      throw new Error('Swarm execution aborted');
    }

    this.setAgentState(agentName, 'running');
    this._events.emit('agent:start', { agentName, input }, agentName);

    try {
      const result = await this.cogitator.run(swarmAgent.agent, {
        input,
        context: {
          ...context,
          swarmContext: {
            swarmId: this.swarmId,
            swarmName: this.config.name,
            agentRole: swarmAgent.metadata.role,
            availableAgents: Array.from(this.agents.keys()).filter((n) => n !== agentName),
          },
        },
      });

      this.setAgentState(agentName, 'completed');
      swarmAgent.lastResult = result;
      swarmAgent.tokenCount += result.usage.totalTokens;

      this.resourceTracker.trackAgentRun(agentName, result);

      this.circuitBreaker?.recordSuccess();

      this._events.emit('agent:complete', { agentName, result }, agentName);

      return result;
    } catch (error) {
      this.setAgentState(agentName, 'failed');

      this.circuitBreaker?.recordFailure();

      this._events.emit('agent:error', { agentName, error }, agentName);

      if (this.config.errorHandling) {
        return this.handleAgentError(swarmAgent, input, context, error as Error);
      }

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
          } else if (this.config.errorHandling?.onAgentFailure !== 'abort') {
            continue;
          } else {
            throw settled.reason;
          }
        }
      }
    }

    return results;
  }

  private async handleAgentError(
    swarmAgent: SwarmAgent,
    input: string,
    context: Record<string, unknown> | undefined,
    error: Error
  ): Promise<RunResult> {
    const errorConfig = this.config.errorHandling!;
    const agentName = swarmAgent.agent.name;

    switch (errorConfig.onAgentFailure) {
      case 'retry':
        if (errorConfig.retry) {
          return this.retryAgentRun(swarmAgent, input, context, errorConfig.retry);
        }
        throw error;

      case 'failover':
        if (errorConfig.failover?.[agentName]) {
          const backupAgentName = errorConfig.failover[agentName];
          return this.runAgent(backupAgentName, input, context);
        }
        throw error;

      case 'skip':
        return {
          output: '',
          runId: `run_skipped_${nanoid(8)}`,
          agentId: swarmAgent.agent.id,
          threadId: '',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, duration: 0 },
          toolCalls: [],
          messages: [],
          trace: { traceId: `trace_${nanoid(12)}`, spans: [] },
        };

      case 'abort':
      default:
        throw error;
    }
  }

  private async retryAgentRun(
    swarmAgent: SwarmAgent,
    input: string,
    context: Record<string, unknown> | undefined,
    retryConfig: NonNullable<NonNullable<SwarmConfig['errorHandling']>['retry']>
  ): Promise<RunResult> {
    const { maxRetries, backoff, initialDelay = 1000, maxDelay = 30000 } = retryConfig;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.setAgentState(swarmAgent.agent.name, 'idle');
        return await this.runAgent(swarmAgent.agent.name, input, context);
      } catch {
        if (attempt === maxRetries) {
          throw new Error(`Agent '${swarmAgent.agent.name}' failed after ${maxRetries} retries`);
        }

        let delay: number;
        switch (backoff) {
          case 'exponential':
            delay = Math.min(initialDelay * Math.pow(2, attempt - 1), maxDelay);
            break;
          case 'linear':
            delay = Math.min(initialDelay * attempt, maxDelay);
            break;
          default:
            delay = initialDelay;
        }

        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw new Error('Unexpected end of retry loop');
  }

  private setAgentState(agentName: string, state: SwarmAgentState): void {
    const agent = this.agents.get(agentName);
    if (agent) {
      agent.state = state;
    }
  }

  getResourceUsage() {
    return this.resourceTracker.getUsage();
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

  reset(): void {
    this.aborted = false;
    this.paused = false;
    this.resourceTracker.reset();
    this.circuitBreaker?.reset();

    for (const agent of this.agents.values()) {
      agent.state = 'idle';
      agent.lastResult = undefined;
      agent.messageCount = 0;
      agent.tokenCount = 0;
    }

    (this._messageBus as InMemoryMessageBus).clear();
    (this._blackboard as InMemoryBlackboard).clear();
  }
}
