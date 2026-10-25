/**
 * Swarm types for multi-agent coordination
 */

import type { Agent } from './agent';
import type { RunResult, Span } from './runtime';
import type { NegotiationConfig, NegotiationResult } from './negotiation';
import type { TodoStatus } from './todos';

export type SwarmStrategy =
  | 'hierarchical'
  | 'round-robin'
  | 'consensus'
  | 'auction'
  | 'pipeline'
  | 'debate'
  | 'negotiation'
  | 'team';

export interface SwarmAgentMetadata {
  /** Agent's areas of expertise */
  expertise?: string[];
  /** Priority in task assignment (higher = preferred) */
  priority?: number;
  /** Role in the swarm */
  role?: 'supervisor' | 'worker' | 'moderator' | 'router' | 'advocate' | 'critic';
  /** Weight for weighted voting */
  weight?: number;
  /** Lock model - prevent assessor from changing it */
  locked?: boolean;
  /** Custom metadata */
  custom?: Record<string, unknown>;
}

export type SwarmAgentState = 'idle' | 'running' | 'completed' | 'failed';

export interface SwarmAgent {
  agent: Agent;
  metadata: SwarmAgentMetadata;
  state: SwarmAgentState;
  lastResult?: RunResult;
  messageCount: number;
  tokenCount: number;
}

export interface HierarchicalConfig {
  /** Maximum delegation depth (default: 3) */
  maxDelegationDepth?: number;
  /** Allow workers to communicate with each other */
  workerCommunication?: boolean;
  /** Route all messages through supervisor */
  routeThrough?: 'supervisor' | 'direct';
  /** Visibility of worker outputs to supervisor */
  visibility?: 'full' | 'summary' | 'none';
}

export interface RoundRobinConfig {
  /**
   * Enable sticky sessions: runs with the same `stickyKey` go to the agent that handled the
   * key first, while new keys keep rotating. Without `stickyKey` every run rotates.
   */
  sticky?: boolean;
  /** Key function for sticky routing */
  stickyKey?: (input: unknown) => string;
  /** Rotation strategy */
  rotation?: 'sequential' | 'random';
}

export interface ConsensusConfig {
  /** Voting threshold (0-1), default: 0.5 for majority */
  threshold: number;
  /** Maximum discussion rounds */
  maxRounds: number;
  /** Resolution strategy */
  resolution: 'majority' | 'unanimous' | 'weighted';
  /** Action on no consensus */
  onNoConsensus: 'escalate' | 'supervisor-decides' | 'fail';
  /** Weights for weighted voting (agentName -> weight) */
  weights?: Record<string, number>;
}

export interface AuctionConfig {
  /** Bidding strategy */
  bidding: 'capability-match' | 'custom';
  /** Custom bid function (agent, task) -> bid score */
  bidFunction?: (agent: SwarmAgent, task: string) => Promise<number> | number;
  /** Winner selection */
  selection: 'highest-bid' | 'weighted-random';
  /** Minimum bid to participate (0-1) */
  minBid?: number;
}

export interface PipelineStage {
  name: string;
  agent: Agent;
  /** If true, acts as a quality gate */
  gate?: boolean;
}

export interface PipelineGateConfig {
  /** Condition to pass gate */
  condition: (output: unknown) => boolean;
  /** Action on gate failure */
  onFail: 'retry-previous' | 'abort' | 'skip' | `goto:${string}`;
  /** Maximum retries */
  maxRetries: number;
}

export interface PipelineContext {
  input: unknown;
  stageIndex: number;
  stageName: string;
  previousOutputs: Map<string, unknown>;
}

export interface PipelineConfig {
  /** Pipeline stages in order */
  stages: PipelineStage[];
  /** Stage input transformer */
  stageInput?: (prevOutput: unknown, stage: PipelineStage, ctx: PipelineContext) => unknown;
  /** Gate configurations */
  gates?: Record<string, PipelineGateConfig>;
}

export interface DebateConfig {
  /** Number of debate rounds */
  rounds: number;
  /**
   * How long a turn's answer may be, in tokens: the output limit of a model that does not
   * reason, and a length debaters are asked to keep to. A reasoning model spends its reasoning
   * from the same limit, so a turn it spent thinking (cut off or empty with little visible text)
   * is run once more with room for its reasoning on top: `reasoningTokensPerTurn`, or 4096, or
   * twice what it reasoned when that is more. A turn that called tools is never run again
   */
  maxTokensPerTurn?: number;
  /**
   * Output room on top of `maxTokensPerTurn` from the first try, for reasoning models: sparing
   * them the retry. Providers cannot cap the answer apart from the reasoning, so a model that
   * reasons little may answer at more length within this room; the instructions keep it to
   * `maxTokensPerTurn`
   */
  reasoningTokensPerTurn?: number;
  /** Debate format */
  format?: 'structured' | 'freeform';
  /**
   * The moderator's task after the last round, replacing the default "summarise both sides and
   * recommend". `{topic}` and `{transcript}` are replaced with the debate's input and its
   * transcript, each turn labelled with the speaker's name and role
   */
  synthesisPrompt?: string;
}

/**
 * Where a task of a team's task list stands: the statuses of a `write_todos` item. A pending
 * task waits to be claimed, an in-progress one is worked on by its owner, a completed one is final
 */
export type TeamTaskStatus = TodoStatus;

/** A task of the shared task list of a team swarm */
export interface TeamTask {
  /** `task-1`, `task-2` and so on, unless the creator named it */
  id: string;
  title: string;
  description?: string;
  status: TeamTaskStatus;
  /** The member the task is assigned to, or that claimed it */
  owner?: string;
  /** Tasks that must be completed before this one can be claimed */
  dependsOn: string[];
  /** The lead, or `system` for a task of `team.tasks` */
  createdBy: string;
  /** What the member reported when it completed the task */
  result?: string;
  /** The latest progress note of the owner or the lead */
  note?: string;
  createdAt: number;
  updatedAt: number;
}

/** A task to put on the task list, with `create_task` or in `team.tasks` */
export interface TeamTaskInput {
  /** Its id on the list, `task-<n>` when left out */
  id?: string;
  title: string;
  description?: string;
  /** Ids of tasks already on the list that must be completed first */
  dependsOn?: string[];
  /** The member to assign it to */
  assignee?: string;
}

/** The lead plans and coordinates, members work through the tasks */
export type TeamRole = 'lead' | 'member';

/**
 * Where a member of a team stands: `working` during a turn, `idle` between turns, `stopped` once
 * it used all its turns, `failed` when its turn failed
 */
export type TeamMemberStatus = 'idle' | 'working' | 'stopped' | 'failed';

/**
 * Why an agent of a team takes a turn: the lead's first turn (`start`), a task to work on
 * (`task`), messages in its inbox (`message`), a team that cannot go on without the lead
 * (`stalled`), or the lead's final answer (`synthesis`)
 */
export type TeamTurnReason = 'start' | 'task' | 'message' | 'stalled' | 'synthesis';

export interface TeamMemberState {
  name: string;
  role: TeamRole;
  status: TeamMemberStatus;
  /** Turns taken in the run */
  turns: number;
  /** The task the member works on */
  currentTask?: string;
  error?: string;
}

/**
 * How a team run ended: every task completed, the lead answered without creating tasks, nobody
 * could go on with the tasks left, or the agents used up their turns
 */
export type TeamStopReason = 'completed' | 'no-tasks' | 'stalled' | 'turn-limit';

/**
 * Agent teams: a lead plans the work as a shared task list, members claim or are assigned tasks
 * and work through them, everyone talks through mailboxes, and the lead writes the final answer.
 * The lead is the swarm's `supervisor`, the members are its `workers`. Every bound keeps a run
 * finite: a run ends once no agent has a reason or a turn left to go on
 */
export interface TeamConfig {
  /** Tasks on the list before the lead's first turn */
  tasks?: TeamTaskInput[];
  /**
   * Members take unassigned tasks on their own: an idle member is given the next one that is not
   * blocked (default: true). Without it only the tasks the lead assigns are worked on
   */
  selfClaim?: boolean;
  /** Members working at the same time (default: `resources.maxConcurrency`, or 4) */
  maxConcurrentMembers?: number;
  /** Turns the lead takes besides the final answer (default: 6) */
  maxLeadTurns?: number;
  /** Turns each member takes (default: 8) */
  maxTurnsPerMember?: number;
  /** Tasks the list holds (default: 50) */
  maxTasks?: number;
  /**
   * The lead writes the final answer from the results of the tasks (default: true). Without it the
   * output is the list of tasks with their results
   */
  synthesize?: boolean;
}

/** What a team run did: its task list, its agents and why it ended */
export interface TeamResult {
  tasks: TeamTask[];
  members: TeamMemberState[];
  stopReason: TeamStopReason;
  /** Turns of the lead, the final answer included */
  leadTurns: number;
  memberTurns: number;
}

export type SwarmMessageType = 'request' | 'response' | 'notification' | 'error';

export interface SwarmMessage {
  id: string;
  swarmId: string;
  from: string;
  to: string | 'broadcast';
  type: SwarmMessageType;
  channel?: string;
  content: string;
  payload?: unknown;
  replyTo?: string;
  correlationId?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface MessageBusConfig {
  enabled: boolean;
  /**
   * @deprecated Has no effect: the message bus always delivers direct messages, broadcasts
   * and channel-tagged messages. Kept so existing configurations still type-check.
   */
  protocol?: 'direct' | 'broadcast' | 'pub-sub';
  /** Max message length in characters */
  maxMessageLength?: number;
  /** Max messages per turn per agent */
  maxMessagesPerTurn?: number;
  /** Max total messages in swarm run */
  maxTotalMessages?: number;
}

export interface MessageBus {
  send(message: Omit<SwarmMessage, 'id' | 'timestamp'>): Promise<SwarmMessage>;
  broadcast(from: string, content: string, channel?: string): Promise<void>;
  subscribe(agentName: string, handler: (msg: SwarmMessage) => void): () => void;
  getMessages(agentName: string, limit?: number): SwarmMessage[];
  getConversation(agent1: string, agent2: string): SwarmMessage[];
  getAllMessages(): SwarmMessage[];
  getUnreadMessages(agentName: string): SwarmMessage[];
  clear(): void;
}

export interface BlackboardSection<T = unknown> {
  name: string;
  data: T;
  lastModified: number;
  modifiedBy: string;
  version: number;
}

export interface BlackboardConfig {
  enabled: boolean;
  /** Initial sections with their data */
  sections: Record<string, unknown>;
  /**
   * @deprecated Has no effect: every write is already atomic (in memory it runs synchronously,
   * on Redis it runs as a single Lua script), so there is no lock to enable.
   */
  locking?: boolean;
  /** Track history of changes */
  trackHistory?: boolean;
}

export interface BlackboardHistoryEntry {
  value: unknown;
  writtenBy: string;
  timestamp: number;
  version: number;
}

export interface BlackboardEntry<T = unknown> {
  section: string;
  key?: string;
  value: T;
  version: number;
  writtenBy: string;
  timestamp: number;
}

export interface Blackboard {
  read<T = unknown>(section: string): T;
  write<T>(section: string, data: T, agentName: string): void;
  append<T>(section: string, item: T, agentName: string): void;
  has(section: string): boolean;
  delete(section: string): void;
  subscribe(section: string, handler: (data: unknown, agentName: string) => void): () => void;
  getSections(): string[];
  getSection<T = unknown>(section: string): BlackboardSection<T> | undefined;
  getHistory(section: string): BlackboardHistoryEntry[];
  clear(): void;
}

/**
 * The data of each event of a team swarm, by event type. Task events carry the task as it is
 * after the change, so a client can draw the task list and who works on what from the events alone.
 * `team:task-claimed` and `team:task-completed` report those changes, `team:task-updated` every
 * other change of a task
 */
export interface TeamEventMap {
  /** Before anything else of the run, the tasks of `team.tasks` included */
  'team:start': { lead: string; members: string[] };
  'team:member-started': {
    member: string;
    role: TeamRole;
    turn: number;
    reason: TeamTurnReason;
    taskId?: string;
  };
  'team:member-finished': {
    member: string;
    role: TeamRole;
    turn: number;
    reason: TeamTurnReason;
    status: TeamMemberStatus;
    /** The start of what the agent answered */
    output?: string;
    error?: string;
  };
  'team:task-created': { task: TeamTask; by: string };
  'team:task-assigned': { task: TeamTask; assignee: string; by: string; previousOwner?: string };
  'team:task-claimed': { task: TeamTask; member: string };
  'team:task-updated': {
    task: TeamTask;
    by: string;
    from: TeamTaskStatus;
    to: TeamTaskStatus;
  };
  'team:task-completed': {
    task: TeamTask;
    by: string;
    /** Tasks this one was the last unfinished dependency of */
    unblocked: string[];
  };
  'team:message-sent': {
    id: string;
    from: string;
    /** The agents whose mailbox got the message */
    to: string[];
    broadcast: boolean;
    content: string;
  };
  'team:complete': {
    stopReason: TeamStopReason;
    tasks: { total: number; completed: number; inProgress: number; pending: number };
    leadTurns: number;
    memberTurns: number;
  };
}

export type TeamEventType = keyof TeamEventMap;

export type SwarmEventType =
  | 'swarm:start'
  | 'swarm:complete'
  | 'swarm:error'
  | 'swarm:paused'
  | 'swarm:resumed'
  | 'swarm:aborted'
  | 'swarm:reset'
  | 'agent:start'
  | 'agent:complete'
  | 'agent:error'
  | 'message:sent'
  | 'message:received'
  | 'blackboard:write'
  | 'consensus:vote'
  | 'consensus:vote:changed'
  | 'consensus:round'
  | 'consensus:turn'
  | 'consensus:reached'
  | 'auction:start'
  | 'auction:bid'
  | 'auction:winner'
  | 'auction:complete'
  | 'debate:turn'
  | 'debate:round'
  | 'pipeline:stage'
  | 'pipeline:stage:complete'
  | 'pipeline:gate'
  | 'pipeline:gate:pass'
  | 'pipeline:gate:fail'
  | 'round-robin:assigned'
  | 'assessor:complete'
  | 'negotiation:start'
  | 'negotiation:phase-change'
  | 'negotiation:round'
  | 'negotiation:turn'
  | 'negotiation:interests-declared'
  | 'negotiation:offer-made'
  | 'negotiation:offer-accepted'
  | 'negotiation:offer-rejected'
  | 'negotiation:offer-countered'
  | 'negotiation:offer-expired'
  | 'negotiation:coalition-proposed'
  | 'negotiation:coalition-formed'
  | 'negotiation:coalition-dissolved'
  | 'negotiation:convergence-update'
  | 'negotiation:stagnation-detected'
  | 'negotiation:mediation-suggested'
  | 'negotiation:approval-required'
  | 'negotiation:approval-received'
  | 'negotiation:agreement-reached'
  | 'negotiation:deadlock'
  | 'negotiation:escalation'
  | 'negotiation:arbitration'
  | 'negotiation:terminated'
  | TeamEventType;

export interface SwarmEvent {
  type: SwarmEventType;
  timestamp: number;
  agentName?: string;
  data?: unknown;
}

export type SwarmEventHandler = (event: SwarmEvent) => void | Promise<void>;

export interface SwarmEventEmitter {
  on(event: SwarmEventType | '*', handler: SwarmEventHandler): () => void;
  once(event: SwarmEventType | '*', handler: SwarmEventHandler): () => void;
  emit(event: SwarmEventType, data?: unknown, agentName?: string): void;
  off(event: SwarmEventType | '*', handler: SwarmEventHandler): void;
  removeAllListeners(event?: SwarmEventType): void;
  getEvents(): SwarmEvent[];
}

export interface SwarmResourceConfig {
  /** Max concurrent agent runs (default: 4) */
  maxConcurrency?: number;
  /** Total token budget for the swarm run */
  tokenBudget?: number;
  /** Cost limit in dollars */
  costLimit?: number;
  /** Time limit in ms */
  timeout?: number;
  /** Per-agent limits */
  perAgent?: {
    maxIterations?: number;
    maxTokens?: number;
    timeout?: number;
  };
}

export interface SwarmResourceUsage {
  totalTokens: number;
  totalCost: number;
  elapsedTime: number;
  agentUsage: Map<string, { tokens: number; cost: number; runs: number; duration: number }>;
}

export type SwarmErrorAction = 'retry' | 'skip' | 'failover' | 'abort';

export interface SwarmErrorConfig {
  /** Action on agent failure */
  onAgentFailure: SwarmErrorAction;
  /** Retry configuration */
  retry?: {
    maxRetries: number;
    backoff: 'constant' | 'linear' | 'exponential';
    initialDelay?: number;
    maxDelay?: number;
  };
  /** Failover agent mapping (primaryAgent -> backupAgent) */
  failover?: Record<string, string>;
  /** Circuit breaker configuration */
  circuitBreaker?: {
    enabled: boolean;
    /** Open circuit after N failures */
    threshold: number;
    /** Reset timeout in ms */
    resetTimeout: number;
  };
  /** Allow returning partial results on failure */
  partialResults?: boolean;
}

/**
 * A Redis to connect to: `url` (`redis://user:password@host:port/db`, or `rediss://` for TLS) is
 * read first, and the explicit fields override what it says. With `cluster` the client connects
 * to the cluster through its nodes, and the url and fields give the credentials and TLS only
 */
export interface RedisConnectionConfig {
  url?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  db?: number;
  /** Connect over TLS, implied by a `rediss://` url */
  tls?: boolean;
  /** Connect to a Redis Cluster through these nodes */
  cluster?: {
    nodes: { host: string; port: number }[];
  };
}

export interface DistributedSwarmConfig {
  enabled: boolean;
  /** Queue name for agent jobs (default: 'swarm-agent-jobs') */
  queue?: string;
  /**
   * @deprecated Has no effect: workers pull jobs from the queue, so their concurrency is set
   * where they run, with the `concurrency` option of `DistributedSwarmWorker`
   * (`@cogitator-ai/worker`).
   */
  workerConcurrency?: number;
  /** Job timeout in ms (default: 300000) */
  timeout?: number;
  /**
   * Redis holding the job queue and the swarm's shared state, the same one the workers use.
   * Default: localhost:6379
   */
  redis?: RedisConnectionConfig & {
    /** Prefix of every key of the swarm and its queue (default: 'swarm') */
    keyPrefix?: string;
  };
  /**
   * Re-dispatch a job that failed on a worker or timed out, before the failure reaches the
   * swarm's `errorHandling`. A timed-out job may still be running on its worker, so its
   * agent turn can run twice. Without this option a failed job is not retried.
   */
  retry?: {
    /** Re-dispatches after the first attempt (default: 3) */
    maxRetries?: number;
    /** Delay growth between attempts (default: 'exponential') */
    backoff?: 'constant' | 'linear' | 'exponential';
    /** Delay before the first re-dispatch in ms (default: 1000) */
    initialDelay?: number;
    /** Upper bound for a single delay in ms (default: 30000) */
    maxDelay?: number;
  };
  /**
   * How long the swarm's shared state in Redis (blackboard, messages, events) is kept after
   * `swarm.close()`, in ms (default: 3600000 = 1 hour). `0` deletes it at once.
   */
  cleanupAfter?: number;
}

/**
 * Built-in tools the swarm adds to its agents. They act on the swarm's own message bus and
 * blackboard, so they are only available in local (non-distributed) swarms.
 */
export interface SwarmAgentToolsConfig {
  /** `send_message`, `read_messages`, `broadcast_message`, `reply_to_message` */
  messaging?: boolean;
  /**
   * `read_blackboard`, `write_blackboard`, `append_blackboard`, `list_blackboard_sections`,
   * `get_blackboard_history`
   */
  blackboard?: boolean;
}

export interface SwarmConfig {
  name: string;
  strategy: SwarmStrategy;

  /** Supervisor agent for hierarchical strategy, the lead of a team */
  supervisor?: Agent;
  /** Worker agents for hierarchical strategy, the members of a team */
  workers?: Agent[];
  /** General agents for round-robin, consensus, auction */
  agents?: Agent[];
  /** Pipeline stages for pipeline strategy (alternative to `pipeline.stages`) */
  stages?: PipelineStage[];
  /** Moderator agent for debate strategy */
  moderator?: Agent;
  /** Router agent for specialist routing */
  router?: Agent;
  /** Per-agent swarm metadata (role, expertise, weight, locked), keyed by agent name */
  agentMetadata?: Record<string, SwarmAgentMetadata>;

  hierarchical?: HierarchicalConfig;
  roundRobin?: RoundRobinConfig;
  consensus?: ConsensusConfig;
  auction?: AuctionConfig;
  pipeline?: PipelineConfig;
  debate?: DebateConfig;
  negotiation?: NegotiationConfig;
  team?: TeamConfig;

  messaging?: MessageBusConfig;
  blackboard?: BlackboardConfig;

  resources?: SwarmResourceConfig;
  errorHandling?: SwarmErrorConfig;

  /** Distributed execution configuration */
  distributed?: DistributedSwarmConfig;

  /** Built-in swarm tools every agent gets in addition to the tools of the strategy */
  agentTools?: SwarmAgentToolsConfig;

  observability?: {
    /** Log the trace (spans) of every agent run, tagged with the swarm and agent */
    tracing?: boolean;
    /** Log all messages */
    messageLogging?: boolean;
    /** Log blackboard changes */
    blackboardLogging?: boolean;
  };
}

export interface SwarmRunOptions {
  /** Input to the swarm */
  input: string;
  /** Additional context passed to all agents */
  context?: Record<string, unknown>;
  /** Thread ID for memory persistence */
  threadId?: string;
  /**
   * The user the swarm acts for: every agent run carries it, so the swarm's
   * threads belong to this user and another user cannot continue them.
   */
  userId?: string;
  /** Override timeout */
  timeout?: number;
  /** Whether to save run history to memory (default: true) */
  saveHistory?: boolean;
  /**
   * Cancels the run: the swarm rejects with the signal's reason, its agent turns in flight are
   * aborted and no further turn starts. `swarmNode` passes the workflow run's signal, so a node
   * timeout, pause or cancel stops the swarm
   */
  signal?: AbortSignal;

  onAgentStart?: (agentName: string) => void;
  onAgentComplete?: (agentName: string, result: RunResult) => void;
  onAgentError?: (agentName: string, error: Error) => void;
  onMessage?: (message: SwarmMessage) => void;
  onEvent?: (event: SwarmEvent) => void;
}

export interface SwarmResult {
  swarmId: string;
  swarmName: string;
  strategy: SwarmStrategy;
  output: unknown;
  structured?: unknown;

  agentResults: Map<string, RunResult>;

  /** Votes from consensus strategy */
  votes?: Map<string, unknown>;
  /** Bids from auction strategy */
  bids?: Map<string, number>;
  /** Winner from auction strategy */
  auctionWinner?: string;
  /** Debate transcript from debate strategy */
  debateTranscript?: SwarmMessage[];
  /** Pipeline outputs per stage */
  pipelineOutputs?: Map<string, unknown>;
  /** Negotiation result from negotiation strategy */
  negotiationResult?: NegotiationResult;
  /** Task list, agents and stop reason of a team run */
  teamResult?: TeamResult;

  usage: SwarmResourceUsage;

  trace: {
    traceId: string;
    spans: Span[];
    events: SwarmEvent[];
    messages: SwarmMessage[];
  };

  error?: Error;
}

export interface ISwarm {
  readonly name: string;
  readonly config: SwarmConfig;
  readonly messageBus: MessageBus;
  readonly blackboard: Blackboard;
  readonly events: SwarmEventEmitter;

  run(options: SwarmRunOptions): Promise<SwarmResult>;

  getAgent(name: string): SwarmAgent | undefined;
  getAgents(): SwarmAgent[];

  pause(): void;
  resume(): void;
  abort(): void;
}

export interface StrategyResult {
  output: unknown;
  structured?: unknown;
  agentResults: Map<string, RunResult>;
  votes?: Map<string, unknown>;
  bids?: Map<string, number>;
  auctionWinner?: string;
  debateTranscript?: SwarmMessage[];
  pipelineOutputs?: Map<string, unknown>;
  negotiationResult?: NegotiationResult;
  teamResult?: TeamResult;
}

/** Per-turn limits a strategy can apply to a single agent run */
export interface SwarmAgentRunOptions {
  /** Cap the response length of this turn (tokens) */
  maxTokens?: number;
  /** Cancel this turn after the given time (ms) */
  timeout?: number;
  /**
   * Throw the turn's error even when `errorHandling.onAgentFailure` is `skip`, for a strategy that
   * handles a failed turn itself (the team strategy hands the member's tasks back)
   */
  rethrow?: boolean;
}

export interface SwarmCoordinatorInterface {
  runAgent(
    agentName: string,
    input: string,
    context?: Record<string, unknown>,
    options?: SwarmAgentRunOptions
  ): Promise<RunResult>;
  runAgentsParallel(
    agents: { name: string; input: string; context?: Record<string, unknown> }[],
    maxConcurrency?: number
  ): Promise<Map<string, RunResult>>;
  getAgent(name: string): SwarmAgent | undefined;
  getAgents(): SwarmAgent[];
  getAgentsByRole(role: SwarmAgentMetadata['role']): SwarmAgent[];
  readonly messageBus: MessageBus;
  readonly blackboard: Blackboard;
  readonly events: SwarmEventEmitter;
}

export interface IStrategy {
  execute(options: SwarmRunOptions): Promise<StrategyResult>;
}

export type ReasoningLevel = 'basic' | 'moderate' | 'advanced';
export type SpeedPreference = 'fast' | 'balanced' | 'slow-ok';
export type CostSensitivity = 'low' | 'medium' | 'high';
export type TaskComplexity = 'simple' | 'moderate' | 'complex';
export type AssessorMode = 'ai' | 'rules' | 'hybrid';
export type ModelProvider = 'ollama' | 'openai' | 'anthropic' | 'google' | 'azure' | 'mistral';

export interface TaskRequirements {
  needsVision: boolean;
  needsToolCalling: boolean;
  needsLongContext: boolean;
  needsReasoning: ReasoningLevel;
  needsSpeed: SpeedPreference;
  costSensitivity: CostSensitivity;
  complexity: TaskComplexity;
  domains?: string[];
}

export interface RoleRequirements extends TaskRequirements {
  role: SwarmAgentMetadata['role'];
  agentName: string;
  customHints?: string[];
}

export interface ModelCapabilitiesInfo {
  supportsVision?: boolean;
  supportsTools?: boolean;
  supportsStreaming?: boolean;
  supportsJson?: boolean;
}

export interface DiscoveredModel {
  id: string;
  provider: ModelProvider;
  displayName: string;
  capabilities: ModelCapabilitiesInfo;
  pricing: { input: number; output: number };
  contextWindow: number;
  isLocal: boolean;
  isAvailable: boolean;
}

export interface ModelCandidate {
  modelId: string;
  provider: ModelProvider;
  score: number;
  reasons: string[];
  isLocal: boolean;
  estimatedCost: number;
  capabilities: ModelCapabilitiesInfo;
}

export interface ModelAssignment {
  agentName: string;
  originalModel: string;
  assignedModel: string;
  provider: ModelProvider;
  score: number;
  reasons: string[];
  fallbackModels: string[];
  locked: boolean;
}

export interface AssessmentResult {
  taskAnalysis: TaskRequirements;
  roleAnalyses: Map<string, RoleRequirements>;
  assignments: ModelAssignment[];
  totalEstimatedCost: number;
  warnings: string[];
  discoveredModels: DiscoveredModel[];
}

export interface AssessorConfig {
  /**
   * How the task is analyzed: 'rules' (keyword heuristics, default), 'ai' (the assessor model
   * judges the task), 'hybrid' (the model's judgement plus every hard requirement the rules
   * detect). 'ai' and 'hybrid' need a Cogitator to run the model; when the model cannot be
   * run, the assessment falls back to the rules and says so in `warnings`.
   */
  mode?: AssessorMode;
  /** Model for 'ai' and 'hybrid' analysis (default: the Cogitator's `llm.defaultModel`) */
  assessorModel?: string;
  /** Prefer local Ollama models when capable */
  preferLocal?: boolean;
  /** Maximum cost budget per run in dollars */
  maxCostPerRun?: number;
  /** Minimum capability match score (0-1) to accept a model */
  minCapabilityMatch?: number;
  /** Ollama server URL */
  ollamaUrl?: string;
  /**
   * Providers whose models may be assigned. When the assessor runs with a Cogitator (as in a
   * Swarm), cloud models are only offered when the Cogitator can run them, i.e. their
   * provider's backend is configured (for example its API key is set).
   */
  enabledProviders?: ModelProvider[];
  /** Cache assessment results */
  cacheAssessments?: boolean;
  /** Cache TTL in milliseconds */
  cacheTTL?: number;
}

export interface Assessor {
  /**
   * @param resolveModel - the model an agent runs on when it sets none of its own
   */
  analyze(
    task: string,
    config: SwarmConfig,
    resolveModel?: (agent: Agent) => string
  ): Promise<AssessmentResult>;
  assignModels(config: SwarmConfig, result: AssessmentResult): SwarmConfig;
  suggestModels(requirements: TaskRequirements): Promise<ModelCandidate[]>;
}
