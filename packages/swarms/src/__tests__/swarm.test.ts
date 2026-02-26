import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Cogitator } from '@cogitator-ai/core';
import type { SwarmConfig, SwarmCoordinatorInterface, IStrategy } from '@cogitator-ai/types';
import { createMockAgent } from './strategies/__mocks__/mock-helpers';

const mockEvents = {
  emit: vi.fn(),
  on: vi.fn(() => () => {}),
  off: vi.fn(),
  once: vi.fn(() => () => {}),
  removeAllListeners: vi.fn(),
  listeners: vi.fn(() => []),
} as unknown as SwarmCoordinatorInterface['events'];

const mockCoordinatorFields: SwarmCoordinatorInterface = {
  messageBus: {} as SwarmCoordinatorInterface['messageBus'],
  blackboard: {} as SwarmCoordinatorInterface['blackboard'],
  events: mockEvents,
  runAgent: vi.fn(),
  getAgents: vi.fn(() => []),
  getAgent: vi.fn(),
  getSwarmId: vi.fn(() => 'swarm_test123'),
  pause: vi.fn(),
  resume: vi.fn(),
  abort: vi.fn(),
  isPaused: vi.fn(() => false),
  isAborted: vi.fn(() => false),
  reset: vi.fn(),
};

class MockSwarmCoordinator implements SwarmCoordinatorInterface {
  messageBus = mockCoordinatorFields.messageBus;
  blackboard = mockCoordinatorFields.blackboard;
  events = mockCoordinatorFields.events;
  runAgent = mockCoordinatorFields.runAgent;
  getAgents = mockCoordinatorFields.getAgents;
  getAgent = mockCoordinatorFields.getAgent;
  getSwarmId = mockCoordinatorFields.getSwarmId;
  pause = mockCoordinatorFields.pause;
  resume = mockCoordinatorFields.resume;
  abort = mockCoordinatorFields.abort;
  isPaused = mockCoordinatorFields.isPaused;
  isAborted = mockCoordinatorFields.isAborted;
  reset = mockCoordinatorFields.reset;

  setSaveHistory = vi.fn();
  getResourceUsage = vi.fn(() => ({
    totalTokens: 0,
    totalCost: 0,
    elapsedTime: 0,
    agentUsage: new Map(),
  }));
}

const mockStrategy: IStrategy = {
  execute: vi.fn(),
};

vi.mock('../coordinator.js', () => ({
  SwarmCoordinator: MockSwarmCoordinator,
}));

vi.mock('../strategies/index.js', () => ({
  createStrategy: vi.fn().mockReturnValue(mockStrategy),
}));

vi.mock('../distributed/index.js', () => ({
  DistributedSwarmCoordinator: vi.fn(),
}));

vi.mock('../assessor/index.js', () => ({
  createAssessor: vi.fn(),
}));

const mockCogitator = {} as Cogitator;

describe('Swarm', () => {
  let Swarm: typeof import('../swarm').Swarm;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../swarm');
    Swarm = mod.Swarm;
  });

  describe('validateConfig', () => {
    it('should accept "negotiation" as a valid strategy', () => {
      const config: SwarmConfig = {
        name: 'test-swarm',
        strategy: 'negotiation',
        agents: [
          createMockAgent('alice').config,
          createMockAgent('bob').config,
        ] as SwarmConfig['agents'],
        negotiation: {
          maxRounds: 5,
          onDeadlock: 'escalate',
        },
      };

      const swarm = new Swarm(mockCogitator, config);
      expect(swarm.strategyType).toBe('negotiation');
    });

    it('should accept all valid strategies', () => {
      const strategies = [
        'hierarchical',
        'round-robin',
        'consensus',
        'auction',
        'pipeline',
        'debate',
        'negotiation',
      ] as const;

      for (const strategy of strategies) {
        let config: SwarmConfig;

        switch (strategy) {
          case 'hierarchical':
            config = {
              name: 'test',
              strategy,
              supervisor: createMockAgent('supervisor'),
            };
            break;
          case 'round-robin':
            config = { name: 'test', strategy };
            break;
          case 'consensus':
            config = {
              name: 'test',
              strategy,
              agents: [createMockAgent('a'), createMockAgent('b')],
              consensus: {
                threshold: 0.5,
                maxRounds: 3,
                resolution: 'majority',
                onNoConsensus: 'fail',
              },
            };
            break;
          case 'auction':
            config = {
              name: 'test',
              strategy,
              auction: { bidding: 'capability-match', selection: 'highest-bid' },
            };
            break;
          case 'pipeline':
            config = {
              name: 'test',
              strategy,
              pipeline: { stages: [{ name: 's1', agent: createMockAgent('p1') }] },
            };
            break;
          case 'debate':
            config = {
              name: 'test',
              strategy,
              debate: { rounds: 3, format: 'structured' },
            };
            break;
          case 'negotiation':
            config = {
              name: 'test',
              strategy,
              agents: [createMockAgent('a'), createMockAgent('b')],
              negotiation: { maxRounds: 5, onDeadlock: 'escalate' },
            };
            break;
        }

        expect(() => new Swarm(mockCogitator, config)).not.toThrow();
      }
    });

    it('should throw on invalid strategy', () => {
      const config = {
        name: 'test',
        strategy: 'invalid-strategy' as SwarmConfig['strategy'],
      } as SwarmConfig;

      expect(() => new Swarm(mockCogitator, config)).toThrow(
        /Invalid swarm strategy: invalid-strategy/
      );
    });

    it('should throw when negotiation strategy is missing negotiation config', () => {
      const config: SwarmConfig = {
        name: 'test',
        strategy: 'negotiation',
        agents: [createMockAgent('a'), createMockAgent('b')],
      };

      expect(() => new Swarm(mockCogitator, config)).toThrow(
        'Negotiation strategy requires negotiation configuration'
      );
    });

    it('should throw when negotiation strategy has fewer than 2 agents', () => {
      const config: SwarmConfig = {
        name: 'test',
        strategy: 'negotiation',
        agents: [createMockAgent('solo')],
        negotiation: { maxRounds: 5, onDeadlock: 'escalate' },
      };

      expect(() => new Swarm(mockCogitator, config)).toThrow(
        'Negotiation strategy requires at least 2 agents'
      );
    });

    it('should throw when negotiation strategy has no agents', () => {
      const config: SwarmConfig = {
        name: 'test',
        strategy: 'negotiation',
        negotiation: { maxRounds: 5, onDeadlock: 'escalate' },
      };

      expect(() => new Swarm(mockCogitator, config)).toThrow(
        'Negotiation strategy requires at least 2 agents'
      );
    });

    it('should throw when hierarchical strategy is missing supervisor', () => {
      const config: SwarmConfig = {
        name: 'test',
        strategy: 'hierarchical',
      };

      expect(() => new Swarm(mockCogitator, config)).toThrow(
        'Hierarchical strategy requires a supervisor agent'
      );
    });

    it('should throw when pipeline strategy has no stages', () => {
      const config: SwarmConfig = {
        name: 'test',
        strategy: 'pipeline',
      };

      expect(() => new Swarm(mockCogitator, config)).toThrow(
        'Pipeline strategy requires at least one stage'
      );
    });

    it('should throw when consensus strategy is missing consensus config', () => {
      const config: SwarmConfig = {
        name: 'test',
        strategy: 'consensus',
        agents: [createMockAgent('a'), createMockAgent('b')],
      };

      expect(() => new Swarm(mockCogitator, config)).toThrow(
        'Consensus strategy requires consensus configuration'
      );
    });

    it('should throw when consensus strategy has fewer than 2 agents', () => {
      const config: SwarmConfig = {
        name: 'test',
        strategy: 'consensus',
        agents: [createMockAgent('solo')],
        consensus: { threshold: 0.5, maxRounds: 3, resolution: 'majority', onNoConsensus: 'fail' },
      };

      expect(() => new Swarm(mockCogitator, config)).toThrow(
        'Consensus strategy requires at least 2 agents'
      );
    });

    it('should throw when debate strategy is missing debate config', () => {
      const config: SwarmConfig = {
        name: 'test',
        strategy: 'debate',
      };

      expect(() => new Swarm(mockCogitator, config)).toThrow(
        'Debate strategy requires debate configuration'
      );
    });

    it('should throw when auction strategy is missing auction config', () => {
      const config: SwarmConfig = {
        name: 'test',
        strategy: 'auction',
      };

      expect(() => new Swarm(mockCogitator, config)).toThrow(
        'Auction strategy requires auction configuration'
      );
    });
  });

  describe('constructor', () => {
    it('should expose name from config', () => {
      const config: SwarmConfig = {
        name: 'my-swarm',
        strategy: 'round-robin',
      };

      const swarm = new Swarm(mockCogitator, config);
      expect(swarm.name).toBe('my-swarm');
    });

    it('should expose strategyType from config', () => {
      const config: SwarmConfig = {
        name: 'test',
        strategy: 'round-robin',
      };

      const swarm = new Swarm(mockCogitator, config);
      expect(swarm.strategyType).toBe('round-robin');
    });
  });
});

describe('SwarmBuilder', () => {
  let SwarmBuilder: typeof import('../swarm').SwarmBuilder;
  let swarmFn: typeof import('../swarm').swarm;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../swarm');
    SwarmBuilder = mod.SwarmBuilder;
    swarmFn = mod.swarm;
  });

  describe('build', () => {
    it('should throw when name is missing', () => {
      const builder = new SwarmBuilder('');
      builder.strategy('round-robin');

      expect(() => builder.build(mockCogitator)).toThrow('Swarm name is required');
    });

    it('should throw when strategy is missing', () => {
      const builder = new SwarmBuilder('test-swarm');

      expect(() => builder.build(mockCogitator)).toThrow('Swarm strategy is required');
    });

    it('should build a valid swarm', () => {
      const builder = new SwarmBuilder('test-swarm');
      builder.strategy('round-robin');

      const swarm = builder.build(mockCogitator);
      expect(swarm.name).toBe('test-swarm');
      expect(swarm.strategyType).toBe('round-robin');
    });

    it('should pass strategy-specific config through to Swarm', () => {
      const builder = new SwarmBuilder('nego-swarm');
      builder
        .strategy('negotiation')
        .agents([createMockAgent('alice'), createMockAgent('bob')])
        .negotiation({ maxRounds: 8, onDeadlock: 'split-difference' });

      const swarm = builder.build(mockCogitator);
      expect(swarm.strategyType).toBe('negotiation');
    });
  });

  describe('negotiation()', () => {
    it('should set negotiation config and return builder for chaining', () => {
      const builder = new SwarmBuilder('test');
      const result = builder.negotiation({ maxRounds: 5, onDeadlock: 'escalate' });

      expect(result).toBe(builder);
    });

    it('should work end-to-end via builder chain', () => {
      const swarm = new SwarmBuilder('deal-maker')
        .strategy('negotiation')
        .agents([createMockAgent('buyer'), createMockAgent('seller')])
        .negotiation({ maxRounds: 10, onDeadlock: 'mediator-decides' })
        .build(mockCogitator);

      expect(swarm.name).toBe('deal-maker');
      expect(swarm.strategyType).toBe('negotiation');
    });
  });

  describe('swarm() factory', () => {
    it('should create a SwarmBuilder with the given name', () => {
      const builder = swarmFn('factory-swarm');
      expect(builder).toBeInstanceOf(SwarmBuilder);

      builder.strategy('round-robin');
      const swarm = builder.build(mockCogitator);
      expect(swarm.name).toBe('factory-swarm');
    });
  });

  describe('fluent API', () => {
    it('should support chaining all builder methods', () => {
      const builder = new SwarmBuilder('chain-test');
      const result = builder
        .strategy('round-robin')
        .agents([createMockAgent('a')])
        .supervisor(createMockAgent('sup'))
        .workers([createMockAgent('w1')])
        .moderator(createMockAgent('mod'))
        .router(createMockAgent('rtr'))
        .hierarchical({ maxDelegationDepth: 5 })
        .roundRobin({ sticky: true })
        .consensus({
          threshold: 0.7,
          maxRounds: 5,
          resolution: 'unanimous',
          onNoConsensus: 'escalate',
        })
        .auction({ bidding: 'capability-match', selection: 'highest-bid' })
        .pipeline({ stages: [] })
        .debate({ rounds: 3, format: 'structured' })
        .negotiation({ maxRounds: 5, onDeadlock: 'escalate' })
        .messaging({ enabled: true, protocol: 'direct' })
        .blackboardConfig({ enabled: true })
        .resources({ maxTokens: 10000 })
        .errorHandling({ strategy: 'retry', maxRetries: 3 })
        .distributed({ enabled: false });

      expect(result).toBe(builder);
    });
  });
});
