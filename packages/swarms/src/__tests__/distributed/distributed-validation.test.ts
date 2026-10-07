import { describe, it, expect } from 'vitest';
import type { Cogitator } from '@cogitator-ai/core';
import { Swarm } from '../../swarm';
import { createMockAgent } from '../strategies/__mocks__/mock-helpers';

const cogitator = { resolveModel: () => 'ollama/test' } as unknown as Cogitator;

describe('distributed swarm validation', () => {
  it('refuses a hierarchical swarm: the supervisor could not delegate', () => {
    expect(
      () =>
        new Swarm(cogitator, {
          name: 'remote-team',
          strategy: 'hierarchical',
          supervisor: createMockAgent('lead'),
          workers: [createMockAgent('a')],
          distributed: { enabled: true },
        })
    ).toThrow(/hierarchical.*distributed/i);
  });

  it('refuses a negotiation swarm: the negotiators could not make offers', () => {
    expect(
      () =>
        new Swarm(cogitator, {
          name: 'remote-deal',
          strategy: 'negotiation',
          agents: [createMockAgent('buyer'), createMockAgent('seller')],
          negotiation: { maxRounds: 3, onDeadlock: 'fail' },
          distributed: { enabled: true },
        })
    ).toThrow(/negotiation.*distributed/i);
  });

  it('accepts the strategies that work without in-process tools', () => {
    expect(
      () =>
        new Swarm(cogitator, {
          name: 'remote-pipeline',
          strategy: 'pipeline',
          stages: [{ name: 'one', agent: createMockAgent('one') }],
          distributed: { enabled: true },
        })
    ).not.toThrow();
  });
});
