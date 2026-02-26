/**
 * Swarm types for multi-agent coordination
 */

import type { Agent } from './agent';
import type { RunResult, Span } from './runtime';
import type { NegotiationConfig, NegotiationResult } from './negotiation';

export type SwarmStrategy =
  | 'hierarchical'
  | 'round-robin'
  | 'consensus'
  | 'auction'
  | 'pipeline'
  | 'debate'
  | 'negotiation';

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
  /** Enable sticky sessions (same agent handles follow-ups) */
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
  /** Max tokens per turn */
  maxTokensPerTurn?: number;
  /** Debate format */
  format?: 'structured' | 'freeform';
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
  protocol: 'direct' | 'broadcast' | 'pub-sub';
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
  /** Lock sections during write (optimistic locking) */
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
  | 'negotiation:terminated';

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

export interface DistributedSwarmConfig {
  enabled: boolean;
  /** Queue name for agent jobs (default: 'swarm-agent-jobs') */
  queue?: string;
  /** Worker concurrency per pool (default: 4) */
  workerConcurrency?: number;
  /** Job timeout in ms (default: 300000) */
  timeout?: number;
  /** Redis connection config */
  redis?: {
    host?: string;
    port?: number;
    password?: string;
    keyPrefix?: string;
    db?: number;
  };
  /** Retry configuration for failed jobs */
  retry?: {
    maxRetries?: number;
    backoff?: 'constant' | 'linear' | 'exponential';
    initialDelay?: number;
    maxDelay?: number;
  };
  /** Cleanup completed job data after ms (default: 3600000 = 1 hour) */
  cleanupAfter?: number;
}

export interface SwarmConfig {
  name: string;
  strategy: SwarmStrategy;

  /** Supervisor agent for hierarchical strategy */
  supervisor?: Agent;
  /** Worker agents for hierarchical strategy */
  workers?: Agent[];
  /** General agents for round-robin, consensus, auction */
  agents?: Agent[];
  /** Pipeline stages for pipeline strategy */
  stages?: PipelineStage[];
  /** Moderator agent for debate strategy */
  moderator?: Agent;
  /** Router agent for specialist routing */
  router?: Agent;

  hierarchical?: HierarchicalConfig;
  roundRobin?: RoundRobinConfig;
  consensus?: ConsensusConfig;
  auction?: AuctionConfig;
  pipeline?: PipelineConfig;
  debate?: DebateConfig;
  negotiation?: NegotiationConfig;

  messaging?: MessageBusConfig;
  blackboard?: BlackboardConfig;

  resources?: SwarmResourceConfig;
  errorHandling?: SwarmErrorConfig;

  /** Distributed execution configuration */
  distributed?: DistributedSwarmConfig;

  observability?: {
    /** Enable tracing */
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
  /** Override timeout */
  timeout?: number;
  /** Whether to save run history to memory (default: true) */
  saveHistory?: boolean;

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
}

export interface SwarmCoordinatorInterface {
  runAgent(agentName: string, input: string, context?: Record<string, unknown>): Promise<RunResult>;
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
  /** Assessment mode: 'rules' (fast), 'ai' (smart), 'hybrid' (balanced) */
  mode?: AssessorMode;
  /** Model to use for AI-based assessment */
  assessorModel?: string;
  /** Prefer local Ollama models when capable */
  preferLocal?: boolean;
  /** Maximum cost budget per run in dollars */
  maxCostPerRun?: number;
  /** Minimum capability match score (0-1) to accept a model */
  minCapabilityMatch?: number;
  /** Ollama server URL */
  ollamaUrl?: string;
  /** Enabled model providers */
  enabledProviders?: ModelProvider[];
  /** Cache assessment results */
  cacheAssessments?: boolean;
  /** Cache TTL in milliseconds */
  cacheTTL?: number;
}

export interface Assessor {
  analyze(task: string, config: SwarmConfig): Promise<AssessmentResult>;
  assignModels(config: SwarmConfig, result: AssessmentResult): SwarmConfig;
  suggestModels(requirements: TaskRequirements): Promise<ModelCandidate[]>;
}
