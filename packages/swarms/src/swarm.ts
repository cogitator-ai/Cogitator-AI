/**
 * Swarm - Main facade for multi-agent swarm coordination
 */

import type { Cogitator } from '@cogitator/core';
import type {
  SwarmConfig,
  SwarmRunOptions,
  StrategyResult,
  SwarmAgent,
  SwarmEventEmitter,
  SwarmEventType,
  SwarmEventHandler,
  MessageBus,
  Blackboard,
  IStrategy,
} from '@cogitator/types';
import { SwarmCoordinator } from './coordinator.js';
import { createStrategy } from './strategies/index.js';

export class Swarm {
  private config: SwarmConfig;
  private coordinator: SwarmCoordinator;
  private strategy: IStrategy;

  constructor(cogitator: Cogitator, config: SwarmConfig) {
    this.config = this.validateConfig(config);
    this.coordinator = new SwarmCoordinator(cogitator, config);
    this.strategy = createStrategy(this.coordinator, config);
  }

  /**
   * Swarm name
   */
  get name(): string {
    return this.config.name;
  }

  /**
   * Swarm ID
   */
  get id(): string {
    return this.coordinator.getSwarmId();
  }

  /**
   * Strategy type
   */
  get strategyType(): string {
    return this.config.strategy;
  }

  /**
   * Message bus for agent communication
   */
  get messageBus(): MessageBus {
    return this.coordinator.messageBus;
  }

  /**
   * Shared blackboard
   */
  get blackboard(): Blackboard {
    return this.coordinator.blackboard;
  }

  /**
   * Event emitter for swarm events
   */
  get events(): SwarmEventEmitter {
    return this.coordinator.events;
  }

  /**
   * Run the swarm with the configured strategy
   */
  async run(options: SwarmRunOptions): Promise<StrategyResult> {
    this.coordinator.events.emit('swarm:start', {
      swarmId: this.id,
      strategy: this.config.strategy,
      input: options.input.slice(0, 100),
    });

    try {
      const result = await this.strategy.execute(options);

      this.coordinator.events.emit('swarm:complete', {
        swarmId: this.id,
        outputLength: typeof result.output === 'string' ? result.output.length : 0,
        agentCount: result.agentResults.size,
      });

      return result;
    } catch (error) {
      this.coordinator.events.emit('swarm:error', {
        swarmId: this.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }

  /**
   * Get all agents in the swarm
   */
  getAgents(): SwarmAgent[] {
    return this.coordinator.getAgents();
  }

  /**
   * Get a specific agent by name
   */
  getAgent(name: string): SwarmAgent | undefined {
    return this.coordinator.getAgent(name);
  }

  /**
   * Subscribe to swarm events
   */
  on(event: SwarmEventType | '*', handler: SwarmEventHandler): () => void {
    return this.coordinator.events.on(event, handler);
  }

  /**
   * Subscribe to swarm event once
   */
  once(event: SwarmEventType | '*', handler: SwarmEventHandler): () => void {
    return this.coordinator.events.once(event, handler);
  }

  /**
   * Get resource usage
   */
  getResourceUsage() {
    return this.coordinator.getResourceUsage();
  }

  /**
   * Pause swarm execution
   */
  pause(): void {
    this.coordinator.pause();
    this.coordinator.events.emit('swarm:paused', { swarmId: this.id });
  }

  /**
   * Resume swarm execution
   */
  resume(): void {
    this.coordinator.resume();
    this.coordinator.events.emit('swarm:resumed', { swarmId: this.id });
  }

  /**
   * Abort swarm execution
   */
  abort(): void {
    this.coordinator.abort();
    this.coordinator.events.emit('swarm:aborted', { swarmId: this.id });
  }

  /**
   * Check if swarm is paused
   */
  isPaused(): boolean {
    return this.coordinator.isPaused();
  }

  /**
   * Check if swarm is aborted
   */
  isAborted(): boolean {
    return this.coordinator.isAborted();
  }

  /**
   * Reset swarm state for a new run
   */
  reset(): void {
    this.coordinator.reset();
    this.coordinator.events.emit('swarm:reset', { swarmId: this.id });
  }

  private validateConfig(config: SwarmConfig): SwarmConfig {
    const validStrategies = [
      'hierarchical',
      'round-robin',
      'consensus',
      'auction',
      'pipeline',
      'debate',
    ];

    if (!validStrategies.includes(config.strategy)) {
      throw new Error(
        `Invalid swarm strategy: ${config.strategy}. Valid strategies: ${validStrategies.join(', ')}`
      );
    }

    switch (config.strategy) {
      case 'hierarchical':
        if (!config.supervisor) {
          throw new Error('Hierarchical strategy requires a supervisor agent');
        }
        break;

      case 'pipeline':
        if (!config.pipeline?.stages || config.pipeline.stages.length === 0) {
          throw new Error('Pipeline strategy requires at least one stage');
        }
        break;

      case 'consensus':
        if (!config.consensus) {
          throw new Error('Consensus strategy requires consensus configuration');
        }
        if (!config.agents || config.agents.length < 2) {
          throw new Error('Consensus strategy requires at least 2 agents');
        }
        break;

      case 'debate':
        if (!config.debate) {
          throw new Error('Debate strategy requires debate configuration');
        }
        break;

      case 'auction':
        if (!config.auction) {
          throw new Error('Auction strategy requires auction configuration');
        }
        break;
    }

    return config;
  }
}

/**
 * Create a swarm with fluent configuration
 */
export class SwarmBuilder {
  private config: Partial<SwarmConfig> = {};

  constructor(name: string) {
    this.config.name = name;
  }

  strategy(strategy: SwarmConfig['strategy']): this {
    this.config.strategy = strategy;
    return this;
  }

  supervisor(agent: SwarmConfig['supervisor']): this {
    this.config.supervisor = agent;
    return this;
  }

  workers(agents: SwarmConfig['workers']): this {
    this.config.workers = agents;
    return this;
  }

  agents(agents: SwarmConfig['agents']): this {
    this.config.agents = agents;
    return this;
  }

  moderator(agent: SwarmConfig['moderator']): this {
    this.config.moderator = agent;
    return this;
  }

  router(agent: SwarmConfig['router']): this {
    this.config.router = agent;
    return this;
  }

  hierarchical(config: SwarmConfig['hierarchical']): this {
    this.config.hierarchical = config;
    return this;
  }

  roundRobin(config: SwarmConfig['roundRobin']): this {
    this.config.roundRobin = config;
    return this;
  }

  consensus(config: SwarmConfig['consensus']): this {
    this.config.consensus = config;
    return this;
  }

  auction(config: SwarmConfig['auction']): this {
    this.config.auction = config;
    return this;
  }

  pipeline(config: SwarmConfig['pipeline']): this {
    this.config.pipeline = config;
    return this;
  }

  debate(config: SwarmConfig['debate']): this {
    this.config.debate = config;
    return this;
  }

  messaging(config: SwarmConfig['messaging']): this {
    this.config.messaging = config;
    return this;
  }

  blackboardConfig(config: SwarmConfig['blackboard']): this {
    this.config.blackboard = config;
    return this;
  }

  resources(config: SwarmConfig['resources']): this {
    this.config.resources = config;
    return this;
  }

  errorHandling(config: SwarmConfig['errorHandling']): this {
    this.config.errorHandling = config;
    return this;
  }

  build(cogitator: Cogitator): Swarm {
    if (!this.config.name) {
      throw new Error('Swarm name is required');
    }
    if (!this.config.strategy) {
      throw new Error('Swarm strategy is required');
    }

    return new Swarm(cogitator, this.config as SwarmConfig);
  }
}

/**
 * Create a new swarm builder
 */
export function swarm(name: string): SwarmBuilder {
  return new SwarmBuilder(name);
}
