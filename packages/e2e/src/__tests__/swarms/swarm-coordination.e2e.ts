import { describe, it, expect, beforeAll } from 'vitest';
import { createTestCogitator, createTestAgent, isOllamaRunning } from '../../helpers/setup';
import type { Cogitator } from '@cogitator-ai/core';
import { Swarm } from '@cogitator-ai/swarms';
import type { SwarmEvent } from '@cogitator-ai/swarms';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('Swarms: Multi-Agent Coordination', () => {
  let cogitator: Cogitator;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
  });

  it('round-robin distributes task across agents', { timeout: 60_000 }, async () => {
    const agentA = createTestAgent({ name: 'agent-alpha', instructions: 'Reply briefly.' });
    const agentB = createTestAgent({ name: 'agent-beta', instructions: 'Reply briefly.' });

    const swarm = new Swarm(cogitator, {
      name: 'rr-test',
      strategy: 'round-robin',
      agents: [agentA, agentB],
    });

    const result = await swarm.run({ input: 'Say hello', saveHistory: false });

    expect(typeof result.output).toBe('string');
    expect(String(result.output).length).toBeGreaterThan(0);
    expect(result.agentResults.size).toBeGreaterThanOrEqual(1);
  });

  it('pipeline processes through agent chain', { timeout: 120_000 }, async () => {
    const analyzer = createTestAgent({
      name: 'analyzer',
      instructions: 'Repeat the input back briefly.',
    });
    const summarizer = createTestAgent({
      name: 'summarizer',
      instructions: 'Summarize what you receive in one sentence.',
    });

    const swarm = new Swarm(cogitator, {
      name: 'pipeline-test',
      strategy: 'pipeline',
      pipeline: {
        stages: [
          { name: 'analyze', agent: analyzer },
          { name: 'summarize', agent: summarizer },
        ],
      },
    });

    const result = await swarm.run({ input: 'The sky is blue.', saveHistory: false });

    expect(typeof result.output).toBe('string');
    expect(String(result.output).length).toBeGreaterThan(0);
    expect(result.agentResults.size).toBe(2);
  });

  it('swarm handles agent failure gracefully with skip strategy', { timeout: 60_000 }, async () => {
    const badAgent = createTestAgent({
      name: 'bad-agent',
      model: 'ollama/nonexistent-model-xyz',
      instructions: 'You will never run.',
    });
    const goodAgent = createTestAgent({
      name: 'good-agent',
      instructions: 'Reply briefly.',
    });

    const swarm = new Swarm(cogitator, {
      name: 'error-test',
      strategy: 'round-robin',
      agents: [badAgent, goodAgent],
      errorHandling: {
        onAgentFailure: 'skip',
      },
    });

    const result = await swarm.run({ input: 'Say hello', saveHistory: false });

    expect(result).toBeDefined();
    expect(result.agentResults.size).toBeGreaterThanOrEqual(1);
  });

  it('swarm events emit correctly', { timeout: 60_000 }, async () => {
    const agentA = createTestAgent({ name: 'ev-agent-a', instructions: 'Reply briefly.' });
    const agentB = createTestAgent({ name: 'ev-agent-b', instructions: 'Reply briefly.' });

    const swarm = new Swarm(cogitator, {
      name: 'events-test',
      strategy: 'round-robin',
      agents: [agentA, agentB],
    });

    const receivedEvents: string[] = [];

    swarm.on('swarm:start', (event: SwarmEvent) => {
      receivedEvents.push(event.type);
    });
    swarm.on('swarm:complete', (event: SwarmEvent) => {
      receivedEvents.push(event.type);
    });

    await swarm.run({ input: 'Say hello', saveHistory: false });

    expect(receivedEvents).toContain('swarm:start');
    expect(receivedEvents).toContain('swarm:complete');
  });
});
