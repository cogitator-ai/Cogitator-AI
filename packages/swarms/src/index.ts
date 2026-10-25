/**
 * @cogitator-ai/swarms - Multi-agent swarm coordination
 */

export { Swarm, SwarmBuilder, SwarmTimeoutError, swarm } from './swarm';
export { SwarmCoordinator } from './coordinator';
export {
  BaseSwarmCoordinator,
  type AgentRunRequest,
  type SwarmRunScope,
  type SwarmCommunication,
} from './base-coordinator';

export {
  BaseStrategy,
  HierarchicalStrategy,
  RoundRobinStrategy,
  ConsensusStrategy,
  AuctionStrategy,
  PipelineStrategy,
  DebateStrategy,
  NegotiationStrategy,
  TeamStrategy,
  createStrategy,
  getDefaultStrategyConfig,
} from './strategies/index';

export {
  TEAM_DEFAULTS,
  renderBoard,
  renderResults,
  type TeamStrategyOptions,
} from './strategies/team';

export {
  TeamTaskBoard,
  TeamBoardError,
  TEAM_SECTION,
  DEFAULT_MAX_TASKS,
  type TeamBoardState,
  type TeamBoardOptions,
  type TeamTaskUpdate,
  type TeamTaskFilter,
} from './team/board';

export {
  TeamMailbox,
  TEAM_CHANNEL,
  TEAM_MESSAGE_NOTICE,
  renderTeamMessages,
  type TeamMessageView,
  type TeamMailboxOptions,
} from './team/mailbox';

export {
  TurnManager,
  ConvergenceCalculator,
  ApprovalIntegration,
} from './strategies/negotiation/index';

export {
  SwarmEventEmitterImpl,
  type QueryableSwarmEventEmitter,
  InMemoryMessageBus,
  InMemoryBlackboard,
  RedisMessageBus,
  RedisBlackboard,
  RedisSwarmEventEmitter,
  isReadTrackingMessageBus,
  isObservableBlackboard,
  type ReadTrackingMessageBus,
  type MessageListener,
  type ObservableBlackboard,
  type BlackboardWrite,
  type BlackboardWriteListener,
  type BlackboardSectionHandler,
  type RedisMessageBusOptions,
  type RedisBlackboardOptions,
  type RedisEventEmitterOptions,
} from './communication/index';

export {
  DistributedSwarmCoordinator,
  swarmJobQueueKey,
  swarmQueueKeys,
  deliverSwarmJobResult,
  DEFAULT_SWARM_RESULT_TTL,
  resolveRedisOptions,
  clusterNodeOptions,
  createSwarmRedis,
  duplicateSwarmRedis,
  scanSwarmKeys,
  closeSwarmRedis,
  type DistributedCoordinatorOptions,
  type SerializedSwarmAgentConfig,
  type SwarmAgentJobPayload,
  type SwarmAgentJobResult,
  type SwarmQueueKeys,
  type SwarmResultClient,
  type RedisConnectionOptions,
  type SwarmRedis,
} from './distributed/index';

export { ResourceTracker } from './resources/tracker';
export {
  CircuitBreaker,
  type CircuitState,
  type CircuitBreakerConfig,
} from './resources/circuit-breaker';

export {
  createSwarmTools,
  createStrategyTools,
  createMessagingTools,
  createBlackboardTools,
  createDelegationTools,
  createVotingTools,
  createNegotiationTools,
  createTeamTools,
  teamToolsFor,
  type SwarmToolContext,
  type TeamTools,
  type TeamToolContext,
  type MessagingTools,
  type BlackboardTools,
  type DelegationTools,
  type VotingTools,
  type NegotiationTools,
} from './tools/index';

export {
  swarmNode,
  conditionalSwarmNode,
  parallelSwarmsNode,
  type SwarmNodeOptions,
  type SwarmNodeContext,
} from './workflow/swarm-node';

export {
  SwarmAssessor,
  createAssessor,
  TaskAnalyzer,
  ModelDiscovery,
  ModelScorer,
  RoleMatcher,
  AiTaskAnalyzer,
  type ScoredModel,
  type AssessorRuntime,
} from './assessor/index';

export type {
  SwarmStrategy,
  SwarmConfig,
  SwarmRunOptions,
  SwarmAgent,
  SwarmAgentMetadata,
  SwarmAgentState,
  SwarmMessage,
  SwarmMessageType,
  MessageBus,
  MessageBusConfig,
  Blackboard,
  BlackboardConfig,
  BlackboardEntry,
  SwarmEventEmitter,
  SwarmEventType,
  SwarmEvent,
  SwarmEventHandler,
  HierarchicalConfig,
  RoundRobinConfig,
  ConsensusConfig,
  AuctionConfig,
  PipelineConfig,
  PipelineStage,
  PipelineContext,
  PipelineGateConfig,
  DebateConfig,
  NegotiationConfig,
  NegotiationPhase,
  NegotiationTerm,
  NegotiationOffer,
  NegotiationAgreement,
  NegotiationState,
  NegotiationResult,
  NegotiationApprovalGate,
  ConvergenceMetrics,
  Coalition,
  TeamConfig,
  TeamTask,
  TeamTaskInput,
  TeamTaskStatus,
  TeamRole,
  TeamMemberStatus,
  TeamMemberState,
  TeamTurnReason,
  TeamStopReason,
  TeamResult,
  TeamEventMap,
  TeamEventType,
  StrategyResult,
  IStrategy,
  SwarmCoordinatorInterface,
  SwarmResourceConfig,
  SwarmErrorConfig,
  SwarmAgentToolsConfig,
  TaskRequirements,
  RoleRequirements,
  ModelCandidate,
  ModelAssignment,
  AssessmentResult,
  AssessorConfig,
  Assessor,
  DiscoveredModel,
  ModelProvider,
  ModelCapabilitiesInfo,
} from '@cogitator-ai/types';
