/**
 * @cogitator/swarms - Multi-agent swarm coordination
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
  createStrategy,
  getDefaultStrategyConfig,
} from './strategies/index';

export {
  SwarmEventEmitterImpl,
  InMemoryMessageBus,
  InMemoryBlackboard,
} from './communication/index';

export { ResourceTracker } from './resources/tracker';
export { CircuitBreaker, type CircuitState, type CircuitBreakerConfig } from './resources/circuit-breaker';

export {
  createSwarmTools,
  createStrategyTools,
  createMessagingTools,
  createBlackboardTools,
  createDelegationTools,
  createVotingTools,
  type SwarmToolContext,
  type MessagingTools,
  type BlackboardTools,
  type DelegationTools,
  type VotingTools,
} from './tools/index';

export {
  swarmNode,
  conditionalSwarmNode,
  parallelSwarmsNode,
  type SwarmNodeOptions,
  type SwarmNodeContext,
} from './workflow/swarm-node';

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
  StrategyResult,
  IStrategy,
  SwarmCoordinatorInterface,
  SwarmResourceConfig,
  SwarmErrorConfig,
} from '@cogitator/types';
