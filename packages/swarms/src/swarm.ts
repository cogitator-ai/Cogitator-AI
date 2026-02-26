/**
 * Swarm - Main facade for multi-agent swarm coordination
 */

import type { Cogitator } from '@cogitator-ai/core';
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
  AssessorConfig,
  AssessmentResult,
  SwarmCoordinatorInterface,
} from '@cogitator-ai/types';
import { SwarmCoordinator } from './coordinator.js';
import { createStrategy } from './strategies/index.js';
import { createAssessor } from './assessor/index.js';
import { DistributedSwarmCoordinator } from './distributed/index.js';

export class Swarm {
  private config: SwarmConfig;
  private cogitator: Cogitator;
  private coordinator: SwarmCoordinatorInterface;
  private localCoordinator?: SwarmCoordinator;
  private distributedCoordinator?: DistributedSwarmCoordinator;
  private strategy: IStrategy;
  private assessorConfig?: AssessorConfig;
  private assessed = false;
  private lastAssessment?: AssessmentResult;
  private isDistributed: boolean;

  constructor(cogitator: Cogitator, config: SwarmConfig, assessorConfig?: AssessorConfig) {
    this.config = this.validateConfig(config);
    this.cogitator = cogitator;
    this.assessorConfig = assessorConfig;
    this.isDistributed = config.distributed?.enabled ?? false;

    if (this.isDistributed) {
      this.distributedCoordinator = new DistributedSwarmCoordinator({
        config,
        distributed: config.distributed!,
      });
      this.coordinator = this.distributedCoordinator;
    } else {
      this.localCoordinator = new SwarmCoordinator(cogitator, config);
      this.coordinator = this.localCoordinator;
    }

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
    if (this.localCoordinator) {
      return this.localCoordinator.getSwarmId();
    }
    if (this.distributedCoordinator) {
      return this.distributedCoordinator.getSwarmId();
    }
    return 'unknown';
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
    if (this.isDistributed && this.distributedCoordinator) {
      await this.distributedCoordinator.initialize();
    }

    if (this.assessorConfig && !this.assessed) {
      await this.runAssessment(options.input);
    }

    if (options.saveHistory !== undefined && this.localCoordinator) {
      this.localCoordinator.setSaveHistory(options.saveHistory);
    }

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
   * Dry run - analyze and preview model assignments without executing
   */
  async dryRun(options: { input: string }): Promise<AssessmentResult> {
    if (!this.assessorConfig) {
      throw new Error('Assessor not configured. Use SwarmBuilder.withAssessor() to enable.');
    }

    const assessor = createAssessor(this.assessorConfig);
    return assessor.analyze(options.input, this.config);
  }

  /**
   * Get the last assessment result (after run or dryRun)
   */
  getLastAssessment(): AssessmentResult | undefined {
    return this.lastAssessment;
  }

  private async runAssessment(task: string): Promise<void> {
    const assessor = createAssessor(this.assessorConfig!);
    this.lastAssessment = await assessor.analyze(task, this.config);

    this.coordinator.events.emit('assessor:complete', {
      swarmId: this.id,
      assignments: this.lastAssessment.assignments.map((a) => ({
        agent: a.agentName,
        model: a.assignedModel,
        score: a.score,
      })),
      estimatedCost: this.lastAssessment.totalEstimatedCost,
    });

    this.config = assessor.assignModels(this.config, this.lastAssessment);

    if (this.isDistributed) {
      this.distributedCoordinator = new DistributedSwarmCoordinator({
        config: this.config,
        distributed: this.config.distributed!,
      });
      this.coordinator = this.distributedCoordinator;
    } else {
      this.localCoordinator = new SwarmCoordinator(this.cogitator, this.config);
      this.coordinator = this.localCoordinator;
    }
    this.strategy = createStrategy(this.coordinator, this.config);

    this.assessed = true;
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
    if (this.localCoordinator) {
      return this.localCoordinator.getResourceUsage();
    }
    return {
      totalTokens: 0,
      totalCost: 0,
      elapsedTime: 0,
      agentUsage: new Map(),
    };
  }

  /**
   * Pause swarm execution
   */
  pause(): void {
    if (this.localCoordinator) {
      this.localCoordinator.pause();
    }
    if (this.distributedCoordinator) {
      this.distributedCoordinator.pause();
    }
    this.coordinator.events.emit('swarm:paused', { swarmId: this.id });
  }

  /**
   * Resume swarm execution
   */
  resume(): void {
    if (this.localCoordinator) {
      this.localCoordinator.resume();
    }
    if (this.distributedCoordinator) {
      this.distributedCoordinator.resume();
    }
    this.coordinator.events.emit('swarm:resumed', { swarmId: this.id });
  }

  /**
   * Abort swarm execution
   */
  abort(): void {
    if (this.localCoordinator) {
      this.localCoordinator.abort();
    }
    if (this.distributedCoordinator) {
      this.distributedCoordinator.abort();
    }
    this.coordinator.events.emit('swarm:aborted', { swarmId: this.id });
  }

  /**
   * Check if swarm is paused
   */
  isPaused(): boolean {
    if (this.localCoordinator) {
      return this.localCoordinator.isPaused();
    }
    if (this.distributedCoordinator) {
      return this.distributedCoordinator.isPaused();
    }
    return false;
  }

  /**
   * Check if swarm is aborted
   */
  isAborted(): boolean {
    if (this.localCoordinator) {
      return this.localCoordinator.isAborted();
    }
    if (this.distributedCoordinator) {
      return this.distributedCoordinator.isAborted();
    }
    return false;
  }

  /**
   * Reset swarm state for a new run
   */
  reset(): void {
    if (this.localCoordinator) {
      this.localCoordinator.reset();
    }
    if (this.distributedCoordinator) {
      void this.distributedCoordinator.reset();
    }
    this.coordinator.events.emit('swarm:reset', { swarmId: this.id });
  }

  /**
   * Close distributed coordinator connections (for distributed mode)
   */
  async close(): Promise<void> {
    if (this.distributedCoordinator) {
      await this.distributedCoordinator.close();
    }
  }

  private validateConfig(config: SwarmConfig): SwarmConfig {
    const validStrategies = [
      'hierarchical',
      'round-robin',
      'consensus',
      'auction',
      'pipeline',
      'debate',
      'negotiation',
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

      case 'negotiation':
        if (!config.negotiation) {
          throw new Error('Negotiation strategy requires negotiation configuration');
        }
        if (!config.agents || config.agents.length < 2) {
          throw new Error('Negotiation strategy requires at least 2 agents');
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
  private assessorConfig?: AssessorConfig;

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

  negotiation(config: SwarmConfig['negotiation']): this {
    this.config.negotiation = config;
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

  distributed(config: SwarmConfig['distributed']): this {
    this.config.distributed = config;
    return this;
  }

  withAssessor(config: AssessorConfig = {}): this {
    this.assessorConfig = config;
    return this;
  }

  build(cogitator: Cogitator): Swarm {
    if (!this.config.name) {
      throw new Error('Swarm name is required');
    }
    if (!this.config.strategy) {
      throw new Error('Swarm strategy is required');
    }

    return new Swarm(cogitator, this.config as SwarmConfig, this.assessorConfig);
  }
}

/**
 * Create a new swarm builder
 */
export function swarm(name: string): SwarmBuilder {
  return new SwarmBuilder(name);
}
