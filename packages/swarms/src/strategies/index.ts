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
} from '@cogitator/types';
import type { SwarmCoordinator } from '../coordinator.js';

export { BaseStrategy } from './base';
export { HierarchicalStrategy } from './hierarchical';
export { RoundRobinStrategy } from './round-robin';
export { ConsensusStrategy } from './consensus';
export { AuctionStrategy } from './auction';
export { PipelineStrategy } from './pipeline';
export { DebateStrategy } from './debate';

import { HierarchicalStrategy } from './hierarchical';
import { RoundRobinStrategy } from './round-robin';
import { ConsensusStrategy } from './consensus';
import { AuctionStrategy } from './auction';
import { PipelineStrategy } from './pipeline';
import { DebateStrategy } from './debate';

/**
 * Create a strategy instance based on configuration
 */
export function createStrategy(
  coordinator: SwarmCoordinator,
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
      if (!config.pipeline) {
        throw new Error('Pipeline strategy requires pipeline configuration');
      }
      return new PipelineStrategy(coordinator, config.pipeline);

    case 'debate':
      if (!config.debate) {
        throw new Error('Debate strategy requires debate configuration');
      }
      return new DebateStrategy(coordinator, config.debate);

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

    default:
      return {};
  }
}
