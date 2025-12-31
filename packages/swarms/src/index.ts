/**
 * @cogitator-ai/swarms - Multi-agent swarm coordination
 */

export { Swarm, SwarmBuilder, swarm } from './swarm';
export { SwarmCoordinator } from './coordinator';

export {
  BaseStrategy,
  HierarchicalStrategy,
  RoundRobinStrategy,
  ConsensusStrategy,
  AuctionStrategy,
  PipelineStrategy,
  DebateStrategy,
  NegotiationStrategy,
  createStrategy,
  getDefaultStrategyConfig,
} from './strategies/index';

export {
  TurnManager,
  ConvergenceCalculator,
  ApprovalIntegration,
} from './strategies/negotiation/index';

export {
  SwarmEventEmitterImpl,
  InMemoryMessageBus,
  InMemoryBlackboard,
} from './communication/index';

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
  type SwarmToolContext,
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
  type ScoredModel,
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
  StrategyResult,
  IStrategy,
  SwarmCoordinatorInterface,
  SwarmResourceConfig,
  SwarmErrorConfig,
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
