import { describe, it, expect, vi } from 'vitest';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import { A2AClient } from '../client';
import { A2AServer } from '../server';
import { trimTrailingSlashes } from '../url';

const SLASHES = '/'.repeat(50_000);

function helper(): Agent {
  const config: AgentConfig = { name: 'helper', model: 'test', instructions: 'test' };
  return {
    id: 'agent_helper',
    name: 'helper',
    config,
    model: config.model,
    instructions: config.instructions,
    tools: [],
    clone: vi.fn() as Agent['clone'],
    serialize: vi.fn() as Agent['serialize'],
  };
}

describe('trimTrailingSlashes', () => {
  it.each([
    ['/a2a/', '/a2a'],
    ['/a2a///', '/a2a'],
    ['https://agent.example.com//', 'https://agent.example.com'],
    ['/a2a', '/a2a'],
    ['///', ''],
    ['', ''],
  ])('trims %j to %j', (value, expected) => {
    expect(trimTrailingSlashes(value)).toBe(expected);
  });

  it('takes linear time on a long run of slashes that does not end the string', () => {
    const started = performance.now();
    expect(trimTrailingSlashes(`${SLASHES}a`)).toBe(`${SLASHES}a`);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe('URLs from untrusted input', () => {
  it('builds a client for a base URL with a long run of slashes without stalling', () => {
    const started = performance.now();
    new A2AClient(`https://agent.example.com${SLASHES}a`);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('builds a server for a card URL with a long run of slashes without stalling', () => {
    const started = performance.now();
    new A2AServer({
      agents: { helper: helper() },
      cogitator: { run: vi.fn() },
      cardUrl: `https://agent.example.com${SLASHES}a`,
    });
    expect(performance.now() - started).toBeLessThan(100);
  });
});
