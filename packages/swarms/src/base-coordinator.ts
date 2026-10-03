import { nanoid } from 'nanoid';
import { getLogger } from '@cogitator-ai/core';
import type {
  Agent,
  AgentConfig,
  SwarmConfig,
  SwarmAgent,
  SwarmAgentMetadata,
  SwarmAgentRunOptions,
  SwarmAgentState,
  SwarmResourceUsage,
  RunResult,
  SwarmEventEmitter,
  SwarmCoordinatorInterface,
  SwarmMessage,
  NegotiationState,
  NegotiationOffer,
  Tool,
} from '@cogitator-ai/types';
import type { ReadTrackingMessageBus } from './communication/message-bus';
import type { ObservableBlackboard } from './communication/blackboard';
import { ResourceTracker } from './resources/tracker';
import { CircuitBreaker } from './resources/circuit-breaker';
import { buildSwarmAgents } from './agents';
import { runWithConcurrency } from './utils/concurrency';
import { createDelegationTools } from './tools/delegation';
import { createNegotiationTools } from './tools/negotiation';
import { createVotingTools } from './tools/voting';
import { createMessagingTools, createHierarchyMessageAuthorizer } from './tools/messaging';
import { createBlackboardTools } from './tools/blackboard';

type RetryConfig = NonNullable<NonNullable<SwarmConfig['errorHandling']>['retry']>;

export interface SwarmRunScope {
  /** Base thread id; each agent gets its own `${threadId}:${agentName}` thread */
  threadId?: string;
  /** User every agent run of the current swarm run acts for */
  userId?: string;
  /** Signal that cancels every agent run of the current swarm run */
  signal?: AbortSignal;
}

export interface SwarmCommunication<
  Bus extends ReadTrackingMessageBus = ReadTrackingMessageBus,
  Board extends ObservableBlackboard = ObservableBlackboard,
  Events extends SwarmEventEmitter = SwarmEventEmitter,
> {
  messageBus: Bus;
  blackboard: Board;
  events: Events;
}

/**
 * Everything an execution engine needs to run one agent turn.
 */
export interface AgentRunRequest {
  swarmAgent: SwarmAgent;
  /** Agent to execute, with `resources.perAgent` limits applied */
  agent: Agent;
  input: string;
  /** Full run context including swarm, message and negotiation context */
  context: Record<string, unknown>;
  signal: AbortSignal;
  threadId?: string;
  userId?: string;
  timeout?: number;
  saveHistory: boolean;
}

/**
 * Shared coordination logic for local and distributed swarms: agent registry, budgets,
 * circuit breaking, error recovery, pause/abort, parallel scheduling and observability.
 * Subclasses only decide how a single agent turn is executed.
 */
export abstract class BaseSwarmCoordinator<
  Bus extends ReadTrackingMessageBus = ReadTrackingMessageBus,
  Board extends ObservableBlackboard = ObservableBlackboard,
  Events extends SwarmEventEmitter = SwarmEventEmitter,
> implements SwarmCoordinatorInterface {
  protected readonly config: SwarmConfig;
  protected readonly swarmId: string;
  protected readonly agents: Map<string, SwarmAgent>;
  protected readonly communication: SwarmCommunication<Bus, Board, Events>;
  protected resourceTracker: ResourceTracker;
  protected saveHistory = true;
  private circuitBreaker?: CircuitBreaker;
  private limitedAgents = new Map<string, Agent>();
  private injectedTools = new Map<string, Tool[]>();
  private abortController = new AbortController();
  private runScope: SwarmRunScope = {};
  private paused = false;

  protected constructor(
    config: SwarmConfig,
    swarmId: string,
    communication: SwarmCommunication<Bus, Board, Events>
  ) {
    this.config = config;
    this.swarmId = swarmId;
    this.communication = communication;
    this.agents = buildSwarmAgents(config);
    this.resourceTracker = new ResourceTracker(config.resources ?? {});

    if (config.errorHandling?.circuitBreaker?.enabled) {
      this.circuitBreaker = new CircuitBreaker({
        threshold: config.errorHandling.circuitBreaker.threshold,
        resetTimeout: config.errorHandling.circuitBreaker.resetTimeout,
      });
    }

    this.wireObservability();
  }

  /**
   * Execute a single agent turn. Implementations must honour `request.signal`.
   */
  protected abstract executeRun(request: AgentRunRequest): Promise<RunResult>;

  /**
   * Hook for engines that need asynchronous setup before the first agent run.
   */
  protected async prepare(): Promise<void> {}

  get messageBus(): Bus {
    return this.communication.messageBus;
  }

  get blackboard(): Board {
    return this.communication.blackboard;
  }

  get events(): Events {
    return this.communication.events;
  }

  setSaveHistory(value: boolean): void {
    this.saveHistory = value;
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

  getResourceUsage(): SwarmResourceUsage {
    return this.resourceTracker.getUsage();
  }

  /**
   * Start a new swarm run: resource budgets are per run, so usage counters restart here.
   */
  beginRun(scope: SwarmRunScope = {}): void {
    this.runScope = scope;
    this.resourceTracker.reset();
  }

  endRun(): void {
    this.runScope = {};
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  /**
   * Abort the swarm: pending agent runs are rejected and in-flight runs are cancelled.
   */
  abort(): void {
    this.abortController.abort(new Error('Swarm execution aborted'));
  }

  isAborted(): boolean {
    return this.abortController.signal.aborted;
  }

  isPaused(): boolean {
    return this.paused;
  }

  reset(): void {
    this.abortController = new AbortController();
    this.paused = false;
    this.runScope = {};
    this.resourceTracker.reset();
    this.circuitBreaker?.reset();

    for (const agent of this.agents.values()) {
      agent.state = 'idle';
      agent.lastResult = undefined;
      agent.messageCount = 0;
      agent.tokenCount = 0;
    }

    this.messageBus.clear();
    this.blackboard.clear();
  }

  async runAgent(
    agentName: string,
    input: string,
    context?: Record<string, unknown>,
    options?: SwarmAgentRunOptions
  ): Promise<RunResult> {
    return this.runAgentWithRecovery(agentName, input, context, options ?? {}, new Set());
  }

  async runAgentsParallel(
    agents: { name: string; input: string; context?: Record<string, unknown> }[],
    maxConcurrency?: number
  ): Promise<Map<string, RunResult>> {
    const concurrency = Math.max(1, maxConcurrency ?? this.config.resources?.maxConcurrency ?? 4);
    const tolerateFailures =
      this.config.errorHandling?.onAgentFailure === 'skip' ||
      this.config.errorHandling?.partialResults === true;

    const outcomes = await runWithConcurrency(
      agents,
      concurrency,
      ({ name, input, context }) => this.runAgent(name, input, context),
      { stopOnFailure: !tolerateFailures }
    );

    const results = new Map<string, RunResult>();
    let firstError: unknown;
    let failures = 0;

    outcomes.forEach((outcome, index) => {
      if (!outcome) return;
      if (outcome.status === 'fulfilled') {
        results.set(agents[index].name, outcome.value);
      } else {
        failures++;
        firstError ??= outcome.reason;
      }
    });

    if (failures > 0 && (!tolerateFailures || results.size === 0)) {
      throw firstError;
    }

    return results;
  }

  private async runAgentWithRecovery(
    agentName: string,
    input: string,
    context: Record<string, unknown> | undefined,
    options: SwarmAgentRunOptions,
    failoverChain: Set<string>
  ): Promise<RunResult> {
    const swarmAgent = this.requireAgent(agentName);
    await this.ensureRunnable();

    try {
      return await this.executeAgent(swarmAgent, input, context, options);
    } catch (error) {
      if (!this.config.errorHandling || this.isCancelled()) {
        throw error;
      }
      return this.handleAgentError(
        swarmAgent,
        input,
        context,
        options,
        toError(error),
        failoverChain
      );
    }
  }

  private requireAgent(agentName: string): SwarmAgent {
    const swarmAgent = this.agents.get(agentName);
    if (!swarmAgent) {
      throw new Error(`Agent '${agentName}' not found in swarm`);
    }
    return swarmAgent;
  }

  private async ensureRunnable(): Promise<void> {
    await this.prepare();

    if (this.circuitBreaker && !this.circuitBreaker.canExecute()) {
      throw new Error(`Circuit breaker is open for swarm '${this.config.name}'`);
    }

    if (!this.resourceTracker.isWithinBudget()) {
      throw new Error('Swarm resource budget exceeded');
    }

    while (this.paused && !this.isCancelled()) {
      await new Promise((r) => setTimeout(r, 100));
    }

    if (this.isCancelled()) {
      throw new Error('Swarm execution aborted');
    }
  }

  protected isCancelled(): boolean {
    return this.abortController.signal.aborted || this.runScope.signal?.aborted === true;
  }

  private currentSignal(): AbortSignal {
    const runSignal = this.runScope.signal;
    return runSignal
      ? AbortSignal.any([this.abortController.signal, runSignal])
      : this.abortController.signal;
  }

  private async executeAgent(
    swarmAgent: SwarmAgent,
    input: string,
    context: Record<string, unknown> | undefined,
    options: SwarmAgentRunOptions
  ): Promise<RunResult> {
    const agentName = swarmAgent.agent.name;

    this.setAgentState(agentName, 'running');
    this.messageBus.resetTurnCounts(agentName);
    this.events.emit('agent:start', { agentName, input }, agentName);

    try {
      const incomingMessages = this.collectIncomingMessages(agentName);
      const negotiationContext = this.buildNegotiationContext(agentName);

      const result = await this.executeRun({
        swarmAgent,
        agent: this.getRunnableAgent(swarmAgent, options.maxTokens),
        input,
        signal: this.currentSignal(),
        saveHistory: this.saveHistory,
        threadId: this.runScope.threadId ? `${this.runScope.threadId}:${agentName}` : undefined,
        userId: this.runScope.userId,
        timeout: minDefined(this.config.resources?.perAgent?.timeout, options.timeout),
        context: {
          ...context,
          swarmContext: {
            swarmId: this.swarmId,
            swarmName: this.config.name,
            agentRole: swarmAgent.metadata.role,
            availableAgents: Array.from(this.agents.keys()).filter((n) => n !== agentName),
          },
          ...(incomingMessages && { _incomingMessages: incomingMessages }),
          ...(negotiationContext && { _negotiation: negotiationContext }),
        },
      });

      this.setAgentState(agentName, 'completed');
      this.logTrace(agentName, result);
      swarmAgent.lastResult = result;
      swarmAgent.tokenCount += result.usage.totalTokens;
      this.resourceTracker.trackAgentRun(agentName, result);
      this.circuitBreaker?.recordSuccess();

      this.events.emit('agent:complete', { agentName, result }, agentName);

      return result;
    } catch (error) {
      this.setAgentState(agentName, 'failed');
      this.circuitBreaker?.recordFailure();
      this.events.emit('agent:error', { agentName, error }, agentName);
      throw error;
    }
  }

  /**
   * Tools the swarm adds to an agent: the supervisor of a hierarchical swarm gets the
   * delegation tools, consensus voters the voting tools, negotiating agents the negotiation
   * tools, and every agent the built-in tools enabled with `agentTools`. Tools the agent
   * already defines (by name) are left untouched. Engines that cannot ship tool
   * implementations (e.g. remote workers) override this.
   */
  protected strategyTools(swarmAgent: SwarmAgent): Tool[] {
    return [...this.roleTools(swarmAgent), ...this.configuredAgentTools(swarmAgent.agent.name)];
  }

  private roleTools(swarmAgent: SwarmAgent): Tool[] {
    const name = swarmAgent.agent.name;
    const role = swarmAgent.metadata.role;

    switch (this.config.strategy) {
      case 'hierarchical':
        return role === 'supervisor'
          ? Object.values(createDelegationTools(this, this.blackboard, name))
          : [];
      case 'consensus':
        return role === 'supervisor'
          ? []
          : Object.values(
              createVotingTools(
                this.blackboard,
                this.events,
                name,
                this.config.consensus?.weights?.[name] ?? swarmAgent.metadata.weight ?? 1
              )
            );
      case 'negotiation':
        return role === 'supervisor' || role === 'moderator'
          ? []
          : Object.values(
              createNegotiationTools(
                this.blackboard,
                this.events,
                name,
                swarmAgent.metadata.weight ?? this.config.negotiation?.weights?.[name] ?? 1
              )
            );
      default:
        return [];
    }
  }

  private configuredAgentTools(agentName: string): Tool[] {
    const enabled = this.config.agentTools;
    const tools: Tool[] = [];

    if (enabled?.messaging) {
      tools.push(
        ...Object.values(
          createMessagingTools(this.messageBus, agentName, this.swarmId, {
            authorize: createHierarchyMessageAuthorizer(this, this.blackboard, agentName),
          })
        )
      );
    }
    if (enabled?.blackboard) {
      tools.push(...Object.values(createBlackboardTools(this.blackboard, agentName)));
    }

    return tools;
  }

  private missingStrategyTools(swarmAgent: SwarmAgent): Tool[] {
    let tools = this.injectedTools.get(swarmAgent.agent.name);
    if (!tools) {
      const existing = new Set(swarmAgent.agent.tools.map((t) => t.name));
      tools = this.strategyTools(swarmAgent).filter((t) => !existing.has(t.name));
      this.injectedTools.set(swarmAgent.agent.name, tools);
    }
    return tools;
  }

  /**
   * The agent actually executed for a turn: a cached clone when strategy tools,
   * `resources.perAgent` limits or per-turn token caps apply, otherwise the agent itself.
   */
  private getRunnableAgent(swarmAgent: SwarmAgent, turnMaxTokens?: number): Agent {
    const perAgent = this.config.resources?.perAgent;
    const { maxIterations, maxTokens } = swarmAgent.agent.config;

    const iterationLimit = minDefined(maxIterations, perAgent?.maxIterations);
    const tokenLimit = minDefined(maxTokens, perAgent?.maxTokens, turnMaxTokens);
    const extraTools = this.missingStrategyTools(swarmAgent);

    const overrides: Partial<AgentConfig> = {};
    if (iterationLimit !== maxIterations) overrides.maxIterations = iterationLimit;
    if (tokenLimit !== maxTokens) overrides.maxTokens = tokenLimit;
    if (extraTools.length > 0) overrides.tools = [...swarmAgent.agent.tools, ...extraTools];
    if (Object.keys(overrides).length === 0) return swarmAgent.agent;

    const cacheKey = `${swarmAgent.agent.name}|${iterationLimit ?? ''}|${tokenLimit ?? ''}`;
    let runnable = this.limitedAgents.get(cacheKey);
    if (!runnable) {
      runnable = swarmAgent.agent.clone(overrides);
      this.limitedAgents.set(cacheKey, runnable);
    }
    return runnable;
  }

  private async handleAgentError(
    swarmAgent: SwarmAgent,
    input: string,
    context: Record<string, unknown> | undefined,
    options: SwarmAgentRunOptions,
    error: Error,
    failoverChain: Set<string>
  ): Promise<RunResult> {
    const errorConfig = this.config.errorHandling!;
    const agentName = swarmAgent.agent.name;

    switch (errorConfig.onAgentFailure) {
      case 'retry':
        if (errorConfig.retry && errorConfig.retry.maxRetries > 0) {
          return this.retryAgentRun(swarmAgent, input, context, options, errorConfig.retry, error);
        }
        throw error;

      case 'failover': {
        failoverChain.add(agentName);
        const backupAgentName = errorConfig.failover?.[agentName];
        if (backupAgentName && !failoverChain.has(backupAgentName)) {
          return this.runAgentWithRecovery(backupAgentName, input, context, options, failoverChain);
        }
        throw error;
      }

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
    options: SwarmAgentRunOptions,
    retryConfig: RetryConfig,
    initialError: Error
  ): Promise<RunResult> {
    const { maxRetries, backoff, initialDelay = 1000, maxDelay = 30000 } = retryConfig;
    let lastError = initialError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await sleep(computeBackoffDelay(backoff, attempt, initialDelay, maxDelay));
      await this.ensureRunnable();

      try {
        return await this.executeAgent(swarmAgent, input, context, options);
      } catch (error) {
        lastError = toError(error);
        if (this.isCancelled()) throw lastError;
      }
    }

    throw new Error(
      `Agent '${swarmAgent.agent.name}' failed after ${maxRetries} retries: ${lastError.message}`,
      { cause: lastError }
    );
  }

  private setAgentState(agentName: string, state: SwarmAgentState): void {
    const agent = this.agents.get(agentName);
    if (agent) {
      agent.state = state;
    }
  }

  private logTrace(agentName: string, result: RunResult): void {
    if (!this.config.observability?.tracing) return;

    getLogger().info('[Swarm] agent trace', {
      swarm: this.config.name,
      swarmId: this.swarmId,
      agent: agentName,
      runId: result.runId,
      traceId: result.trace.traceId,
      spans: result.trace.spans.map((span) => ({
        id: span.id,
        parentId: span.parentId,
        name: span.name,
        status: span.status,
        duration: span.duration,
        attributes: span.attributes,
      })),
    });
  }

  private wireObservability(): void {
    const observability = this.config.observability;
    const logger = getLogger();

    this.messageBus.onMessage((message) => {
      const sender = this.agents.get(message.from);
      if (sender) sender.messageCount++;

      this.events.emit(
        'message:sent',
        {
          id: message.id,
          from: message.from,
          to: message.to,
          type: message.type,
          channel: message.channel,
          content: message.content,
        },
        message.from
      );

      if (observability?.messageLogging) {
        logger.info('[Swarm] message', {
          swarm: this.config.name,
          from: message.from,
          to: message.to,
          type: message.type,
          channel: message.channel,
          content: message.content,
        });
      }
    });

    this.blackboard.onWrite((write) => {
      this.events.emit(
        'blackboard:write',
        {
          section: write.section,
          version: write.version,
          writtenBy: write.agentName,
          deleted: write.deleted ?? false,
        },
        write.agentName
      );

      if (observability?.blackboardLogging) {
        logger.info('[Swarm] blackboard write', {
          swarm: this.config.name,
          section: write.section,
          version: write.version,
          writtenBy: write.agentName,
          deleted: write.deleted ?? false,
        });
      }
    });
  }

  private collectIncomingMessages(agentName: string): string | null {
    const unread = this.messageBus.getUnreadMessages(agentName);
    if (unread.length === 0) return null;

    const ids = unread.map((m) => m.id);
    this.messageBus.markAsRead(agentName, ids);
    this.events.emit(
      'message:received',
      { agentName, count: unread.length, messageIds: ids },
      agentName
    );

    const formatted = unread.map((m: SwarmMessage) => {
      const timestamp = new Date(m.timestamp).toISOString();
      return `[${timestamp}] ${m.from} → ${m.to}: ${m.content}`;
    });

    return `\n--- Incoming Messages ---\n${formatted.join('\n')}\n---`;
  }

  private buildNegotiationContext(agentName: string): Record<string, unknown> | null {
    if (!this.blackboard.has('negotiation')) return null;

    const state = this.blackboard.read<NegotiationState>('negotiation');

    const pendingOffers = state.offers.filter((o: NegotiationOffer) => o.status === 'pending');
    const offersToMe = pendingOffers.filter((o: NegotiationOffer) => {
      const recipients = Array.isArray(o.to) ? o.to : [o.to];
      return recipients.includes(agentName);
    });
    const myOffers = pendingOffers.filter((o: NegotiationOffer) => o.from === agentName);

    return {
      phase: state.phase,
      round: state.round,
      maxRounds: state.maxRounds,
      isMyTurn: state.currentTurn === agentName || state.currentTurn === null,
      currentTurn: state.currentTurn,
      offersAwaitingMyResponse: offersToMe.map((o: NegotiationOffer) => ({
        id: o.id,
        from: o.from,
        reasoning: o.reasoning,
        terms: o.terms,
      })),
      myPendingOffers: myOffers.map((o: NegotiationOffer) => ({
        id: o.id,
        to: o.to,
        status: o.status,
      })),
      myInterests: state.interests[agentName],
      coalitions: state.coalitions.filter(
        (c) => c.members.includes(agentName) || c.status === 'forming'
      ),
      hasAgreement: !!state.agreement,
    };
  }
}

export function computeBackoffDelay(
  backoff: RetryConfig['backoff'],
  attempt: number,
  initialDelay: number,
  maxDelay: number
): number {
  switch (backoff) {
    case 'exponential':
      return Math.min(initialDelay * Math.pow(2, attempt - 1), maxDelay);
    case 'linear':
      return Math.min(initialDelay * attempt, maxDelay);
    default:
      return Math.min(initialDelay, maxDelay);
  }
}

function minDefined(...values: (number | undefined)[]): number | undefined {
  const defined = values.filter((v): v is number => v !== undefined);
  return defined.length > 0 ? Math.min(...defined) : undefined;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
