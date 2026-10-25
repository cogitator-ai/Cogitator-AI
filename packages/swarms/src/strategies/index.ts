/**
 * Strategy exports and factory
 */

import type {
  SwarmConfig,
  SwarmStrategy,
  IStrategy,
  HierarchicalConfig,
  RoundRobinConfig,
  ConsensusConfig,
  AuctionConfig,
  PipelineConfig,
  DebateConfig,
  NegotiationConfig,
  TeamConfig,
  SwarmCoordinatorInterface,
} from '@cogitator-ai/types';
import { DEFAULT_NEGOTIATION_CONFIG } from '@cogitator-ai/types';

export { BaseStrategy } from './base';
import { HierarchicalStrategy } from './hierarchical';
import { RoundRobinStrategy } from './round-robin';
import { ConsensusStrategy } from './consensus';
import { AuctionStrategy } from './auction';
import { PipelineStrategy, resolvePipelineConfig } from './pipeline';
import { DebateStrategy } from './debate';
import { NegotiationStrategy } from './negotiation-strategy';
import { TeamStrategy, TEAM_DEFAULTS } from './team';
export {
  HierarchicalStrategy,
  RoundRobinStrategy,
  ConsensusStrategy,
  AuctionStrategy,
  PipelineStrategy,
  DebateStrategy,
  NegotiationStrategy,
  TeamStrategy,
};

/**
 * Create a strategy instance based on configuration
 */
export function createStrategy(
  coordinator: SwarmCoordinatorInterface,
  config: SwarmConfig
): IStrategy {
  const strategy = config.strategy;

  switch (strategy) {
    case 'hierarchical':
      return new HierarchicalStrategy(coordinator, config.hierarchical);

    case 'round-robin':
      return new RoundRobinStrategy(coordinator, config.roundRobin);

    case 'consensus':
      if (!config.consensus) {
        throw new Error('Consensus strategy requires consensus configuration');
      }
      return new ConsensusStrategy(coordinator, config.consensus);

    case 'auction':
      if (!config.auction) {
        throw new Error('Auction strategy requires auction configuration');
      }
      return new AuctionStrategy(coordinator, config.auction);

    case 'pipeline':
      return new PipelineStrategy(coordinator, resolvePipelineConfig(config));

    case 'debate':
      if (!config.debate) {
        throw new Error('Debate strategy requires debate configuration');
      }
      return new DebateStrategy(coordinator, config.debate);

    case 'negotiation':
      return new NegotiationStrategy(coordinator, config.negotiation);

    case 'team':
      return new TeamStrategy(coordinator, config.team, {
        maxConcurrency: config.resources?.maxConcurrency,
        tolerateFailures:
          config.errorHandling?.onAgentFailure === 'skip' ||
          config.errorHandling?.partialResults === true,
      });

    default:
      throw new Error(`Unknown swarm strategy: ${strategy}`);
  }
}

/**
 * Get default configuration for a strategy
 */
export function getDefaultStrategyConfig(strategy: SwarmStrategy): {
  hierarchical?: HierarchicalConfig;
  roundRobin?: RoundRobinConfig;
  consensus?: ConsensusConfig;
  auction?: AuctionConfig;
  pipeline?: PipelineConfig;
  debate?: DebateConfig;
  negotiation?: NegotiationConfig;
  team?: TeamConfig;
} {
  switch (strategy) {
    case 'hierarchical':
      return {
        hierarchical: {
          maxDelegationDepth: 3,
          workerCommunication: false,
          routeThrough: 'supervisor',
          visibility: 'full',
        },
      };

    case 'round-robin':
      return {
        roundRobin: {
          sticky: false,
          rotation: 'sequential',
        },
      };

    case 'consensus':
      return {
        consensus: {
          threshold: 0.5,
          maxRounds: 3,
          resolution: 'majority',
          onNoConsensus: 'fail',
        },
      };

    case 'auction':
      return {
        auction: {
          bidding: 'capability-match',
          selection: 'highest-bid',
          minBid: 0,
        },
      };

    case 'pipeline':
      return {
        pipeline: {
          stages: [],
        },
      };

    case 'debate':
      return {
        debate: {
          rounds: 3,
          format: 'structured',
        },
      };

    case 'negotiation':
      return {
        negotiation: DEFAULT_NEGOTIATION_CONFIG,
      };

    case 'team':
      return {
        team: { ...TEAM_DEFAULTS },
      };

    default:
      return {};
  }
}
