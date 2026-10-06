/**
 * Swarm - Main facade for multi-agent swarm coordination
 */

import type { Cogitator } from '@cogitator-ai/core';
import type {
  SwarmConfig,
  SwarmRunOptions,
  StrategyResult,
  SwarmAgent,
  SwarmEventType,
  SwarmEventHandler,
  SwarmResourceUsage,
  IStrategy,
  AssessorConfig,
  AssessmentResult,
  SwarmCoordinatorInterface,
  RunResult,
  NegotiationApprovalResponse,
} from '@cogitator-ai/types';
import { SwarmCoordinator, type SwarmRunScope } from './coordinator.js';
import { createStrategy } from './strategies/index.js';
import { resolvePipelineConfig } from './strategies/pipeline.js';
import { createAssessor } from './assessor/index.js';
import { DistributedSwarmCoordinator } from './distributed/index.js';
import type { ReadTrackingMessageBus } from './communication/message-bus.js';
import type { ObservableBlackboard } from './communication/blackboard.js';
import type { QueryableSwarmEventEmitter } from './communication/event-emitter.js';
import { NegotiationStrategy } from './strategies/negotiation-strategy.js';

/** The largest delay a timer can hold. Node fires a longer one at once, so a run never arms a deadline past it. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const VALID_STRATEGIES: readonly SwarmConfig['strategy'][] = [
  'hierarchical',
  'round-robin',
  'consensus',
  'auction',
  'pipeline',
  'debate',
  'negotiation',
];

/**
 * Coordinator contract the Swarm facade relies on, shared by the local and distributed engines.
 */
interface ManagedCoordinator extends SwarmCoordinatorInterface {
  readonly messageBus: ReadTrackingMessageBus;
  readonly blackboard: ObservableBlackboard;
  readonly events: QueryableSwarmEventEmitter;
  getSwarmId(): string;
  beginRun(scope: SwarmRunScope): void;
  endRun(): void;
  runInScope<T>(scope: SwarmRunScope, work: () => Promise<T>): Promise<T>;
  pause(): void;
  resume(): void;
  abort(): void;
  isPaused(): boolean;
  isAborted(): boolean;
  reset(): void | Promise<void>;
  getResourceUsage(): SwarmResourceUsage;
  setSaveHistory(value: boolean): void;
}

interface EventSubscription {
  event: SwarmEventType | '*';
  handler: SwarmEventHandler;
  once: boolean;
  unsubscribe: () => void;
}

export class SwarmTimeoutError extends Error {
  constructor(
    readonly swarmName: string,
    readonly timeoutMs: number
  ) {
    super(`Swarm '${swarmName}' timed out after ${timeoutMs}ms`);
    this.name = 'SwarmTimeoutError';
  }
}

export class Swarm {
  private config: SwarmConfig;
  private cogitator: Cogitator;
  private coordinator: ManagedCoordinator;
  private strategy: IStrategy;
  private assessorConfig?: AssessorConfig;
  private assessed = false;
  private lastAssessment?: AssessmentResult;
  private running = false;
  private subscriptions = new Set<EventSubscription>();

  constructor(cogitator: Cogitator, config: SwarmConfig, assessorConfig?: AssessorConfig) {
    this.config = this.validateConfig(config);
    this.cogitator = cogitator;
    this.assessorConfig = assessorConfig;
    this.coordinator = this.createCoordinator(this.config);
    this.strategy = createStrategy(this.coordinator, this.config);
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
   * Whether this swarm coordinates agents through Redis-backed workers
   */
  get isDistributed(): boolean {
    return this.config.distributed?.enabled ?? false;
  }

  /**
   * Message bus for agent communication
   */
  get messageBus(): ReadTrackingMessageBus {
    return this.coordinator.messageBus;
  }

  /**
   * Shared blackboard
   */
  get blackboard(): ObservableBlackboard {
    return this.coordinator.blackboard;
  }

  /**
   * Event emitter for swarm events, including the history queries
   * (`getEventsByType`, `getEventsByAgent`)
   */
  get events(): QueryableSwarmEventEmitter {
    return this.coordinator.events;
  }

  /**
   * Run the swarm with the configured strategy
   */
  async run(options: SwarmRunOptions): Promise<StrategyResult> {
    if (this.running) {
      throw new Error(
        `Swarm '${this.config.name}' is already running; create a separate Swarm instance for concurrent runs`
      );
    }
    const callerSignal = options.signal;
    if (callerSignal?.aborted) throw abortReason(callerSignal);
    this.running = true;

    const runController = new AbortController();
    const forwardCallerAbort = () => runController.abort(abortReason(callerSignal!));
    callerSignal?.addEventListener('abort', forwardCallerAbort, { once: true });
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let detachCallbacks: (() => void) | undefined;

    try {
      if (this.assessorConfig && !this.assessed) {
        await this.runAssessment(options.input);
      }

      if (this.coordinator instanceof DistributedSwarmCoordinator) {
        await this.coordinator.initialize();
      }

      if (options.saveHistory !== undefined) {
        this.coordinator.setSaveHistory(options.saveHistory);
      }

      if (
        options.timeout !== undefined &&
        options.timeout > 0 &&
        options.timeout <= MAX_TIMER_DELAY_MS
      ) {
        const timeoutMs = options.timeout;
        timeoutHandle = setTimeout(() => {
          runController.abort(new SwarmTimeoutError(this.config.name, timeoutMs));
        }, timeoutMs);
      }

      const scope: SwarmRunScope = {
        threadId: options.threadId,
        userId: options.userId,
        signal: runController.signal,
      };
      this.coordinator.beginRun(scope);
      detachCallbacks = this.attachRunCallbacks(options);

      this.coordinator.events.emit('swarm:start', {
        swarmId: this.id,
        strategy: this.config.strategy,
        input: options.input.slice(0, 100),
      });

      const result = await raceWithAbort(
        this.coordinator.runInScope(scope, () => this.strategy.execute(options)),
        runController.signal
      );

      this.coordinator.events.emit('swarm:complete', {
        swarmId: this.id,
        outputLength: typeof result.output === 'string' ? result.output.length : 0,
        agentCount: result.agentResults.size,
      });

      return result;
    } catch (error) {
      const aborted = runController.signal.aborted ? abortReason(runController.signal) : undefined;
      if (aborted) this.abortPendingApprovals(aborted);
      const failure = aborted ?? error;
      if (!aborted) runController.abort(failure);

      this.coordinator.events.emit('swarm:error', {
        swarmId: this.id,
        error: failure instanceof Error ? failure.message : String(failure),
      });

      throw failure;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      callerSignal?.removeEventListener('abort', forwardCallerAbort);
      detachCallbacks?.();
      this.coordinator.endRun();
      this.running = false;
    }
  }

  /**
   * Dry run - analyze and preview model assignments without executing
   */
  async dryRun(options: { input: string }): Promise<AssessmentResult> {
    if (!this.assessorConfig) {
      throw new Error('Assessor not configured. Use SwarmBuilder.withAssessor() to enable.');
    }

    const assessor = createAssessor(this.assessorConfig, this.cogitator);
    return assessor.analyze(options.input, this.config, (agent) =>
      this.cogitator.resolveModel(agent)
    );
  }

  /**
   * Get the last assessment result (after run or dryRun)
   */
  getLastAssessment(): AssessmentResult | undefined {
    return this.lastAssessment;
  }

  private async runAssessment(task: string): Promise<void> {
    const assessor = createAssessor(this.assessorConfig, this.cogitator);
    this.lastAssessment = await assessor.analyze(task, this.config, (agent) =>
      this.cogitator.resolveModel(agent)
    );

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

    const previous = this.coordinator;
    this.coordinator = this.createCoordinator(this.config);
    this.strategy = createStrategy(this.coordinator, this.config);

    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
      this.register(subscription);
    }

    if (previous instanceof DistributedSwarmCoordinator) {
      await previous.close();
    }

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
   * Subscribe to swarm events. Subscriptions survive coordinator re-creation after assessment.
   */
  on(event: SwarmEventType | '*', handler: SwarmEventHandler): () => void {
    return this.addSubscription(event, handler, false);
  }

  once(event: SwarmEventType | '*', handler: SwarmEventHandler): () => void {
    return this.addSubscription(event, handler, true);
  }

  private addSubscription(
    event: SwarmEventType | '*',
    handler: SwarmEventHandler,
    once: boolean
  ): () => void {
    const subscription: EventSubscription = { event, handler, once, unsubscribe: () => {} };
    this.subscriptions.add(subscription);
    this.register(subscription);

    return () => {
      subscription.unsubscribe();
      this.subscriptions.delete(subscription);
    };
  }

  private register(subscription: EventSubscription): void {
    if (subscription.once) {
      subscription.unsubscribe = this.coordinator.events.once(subscription.event, (event) => {
        this.subscriptions.delete(subscription);
        return subscription.handler(event);
      });
    } else {
      subscription.unsubscribe = this.coordinator.events.on(
        subscription.event,
        subscription.handler
      );
    }
  }

  private attachRunCallbacks(options: SwarmRunOptions): () => void {
    const events = this.coordinator.events;
    const detachers: (() => void)[] = [];

    if (options.onAgentStart) {
      const callback = options.onAgentStart;
      detachers.push(
        events.on('agent:start', (event) => {
          if (event.agentName) callback(event.agentName);
        })
      );
    }

    if (options.onAgentComplete) {
      const callback = options.onAgentComplete;
      detachers.push(
        events.on('agent:complete', (event) => {
          const data = event.data as { result?: RunResult } | undefined;
          if (event.agentName && data?.result) callback(event.agentName, data.result);
        })
      );
    }

    if (options.onAgentError) {
      const callback = options.onAgentError;
      detachers.push(
        events.on('agent:error', (event) => {
          const data = event.data as { error?: unknown } | undefined;
          if (!event.agentName) return;
          const error = data?.error;
          callback(event.agentName, error instanceof Error ? error : new Error(String(error)));
        })
      );
    }

    if (options.onEvent) {
      detachers.push(events.on('*', options.onEvent));
    }

    if (options.onMessage) {
      detachers.push(this.coordinator.messageBus.onMessage(options.onMessage));
    }

    return () => {
      for (const detach of detachers) detach();
    };
  }

  /**
   * Get resource usage
   */
  getResourceUsage(): SwarmResourceUsage {
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
    this.abortPendingApprovals(new Error('Swarm execution aborted'));
    this.coordinator.events.emit('swarm:aborted', { swarmId: this.id });
  }

  /**
   * Answer a pending approval request of a negotiation swarm. Requests are announced by the
   * `negotiation:approval-required` event; its `request.id` is the `requestId`.
   */
  respondToApproval(requestId: string, response: NegotiationApprovalResponse): void {
    if (!(this.strategy instanceof NegotiationStrategy)) {
      throw new Error(
        `Swarm '${this.config.name}' uses the ${this.config.strategy} strategy, which has no approvals`
      );
    }
    this.strategy.respondToApproval(requestId, response);
  }

  private abortPendingApprovals(reason: Error): void {
    if (this.strategy instanceof NegotiationStrategy) {
      this.strategy.abortPendingApprovals(reason);
    }
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
  async reset(): Promise<void> {
    await this.coordinator.reset();
    this.coordinator.events.emit('swarm:reset', { swarmId: this.id });
  }

  /**
   * Close distributed coordinator connections (for distributed mode)
   */
  async close(): Promise<void> {
    if (this.coordinator instanceof DistributedSwarmCoordinator) {
      await this.coordinator.close();
    }
  }

  private createCoordinator(config: SwarmConfig): ManagedCoordinator {
    if (config.distributed?.enabled) {
      return new DistributedSwarmCoordinator({
        config,
        distributed: config.distributed,
        resolveModel: (agent) => this.cogitator.resolveModel(agent),
      });
    }
    return new SwarmCoordinator(this.cogitator, config);
  }

  private validateConfig(config: SwarmConfig): SwarmConfig {
    if (!VALID_STRATEGIES.includes(config.strategy)) {
      throw new Error(
        `Invalid swarm strategy: ${config.strategy}. Valid strategies: ${VALID_STRATEGIES.join(', ')}`
      );
    }

    this.validateAgentTools(config);
    this.validateDistributedStrategy(config);

    switch (config.strategy) {
      case 'hierarchical':
        if (!config.supervisor) {
          throw new Error('Hierarchical strategy requires a supervisor agent');
        }
        break;

      case 'pipeline':
        if (resolvePipelineConfig(config).stages.length === 0) {
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

  /**
   * Strategies whose agents act through tools bound to this process cannot run on remote
   * workers: those tools do not exist there, and the agents would answer without them.
   */
  private validateDistributedStrategy(config: SwarmConfig): void {
    if (!config.distributed?.enabled) return;
    const reason = DISTRIBUTED_UNSUPPORTED[config.strategy];
    if (!reason) return;
    throw new Error(
      `The ${config.strategy} strategy cannot run distributed: ${reason}, which only exist ` +
        'in the process that runs the swarm. Run it without distributed, or use pipeline, ' +
        'round-robin, consensus, debate or auction.'
    );
  }

  private validateAgentTools(config: SwarmConfig): void {
    const tools = config.agentTools;
    if (!tools?.messaging && !tools?.blackboard) return;

    if (config.distributed?.enabled) {
      throw new Error(
        'agentTools are not available in distributed swarms: register the tools on the workers instead'
      );
    }
    if (tools.messaging && config.messaging?.enabled === false) {
      throw new Error('agentTools.messaging needs the message bus: messaging.enabled is false');
    }
    if (tools.blackboard && config.blackboard?.enabled === false) {
      throw new Error('agentTools.blackboard needs the blackboard: blackboard.enabled is false');
    }
  }
}

const DISTRIBUTED_UNSUPPORTED: Partial<Record<SwarmConfig['strategy'], string>> = {
  hierarchical: 'the supervisor delegates through the delegate_task tool',
  negotiation: 'negotiators make and answer offers through the negotiation tools',
};

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('Swarm run aborted');
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortReason(signal));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
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

  /**
   * Attach swarm metadata (role, expertise, weight, locked) to agents by name
   */
  agentMetadata(metadata: NonNullable<SwarmConfig['agentMetadata']>): this {
    this.config.agentMetadata = { ...this.config.agentMetadata, ...metadata };
    return this;
  }

  observability(config: SwarmConfig['observability']): this {
    this.config.observability = config;
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

  /**
   * Give every agent built-in swarm tools (messaging, blackboard)
   */
  agentTools(config: SwarmConfig['agentTools']): this {
    this.config.agentTools = config;
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
