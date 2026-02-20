import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { A2AClient, signAgentCard, verifyAgentCardSignature } from '@cogitator-ai/a2a';
import type { AgentRunResult, ExtendedAgentCard } from '@cogitator-ai/a2a';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import { startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';

function createMockAgent(name: string): Agent {
  const config: AgentConfig = {
    name,
    model: 'mock',
    instructions: 'test',
    description: `${name} agent`,
  };
  return {
    id: `agent_${name}`,
    name,
    config,
    model: config.model,
    instructions: config.instructions,
    tools: [],
    clone: (() => {}) as Agent['clone'],
    serialize: (() => {}) as Agent['serialize'],
  };
}

function createMockCogitator() {
  return {
    run: async (_agent: unknown, options: { input: string }): Promise<AgentRunResult> => ({
      output: `Response to: ${options.input}`,
      runId: 'run_1',
      agentId: 'agent_1',
      threadId: 'thread_1',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, cost: 0, duration: 50 },
      toolCalls: [],
    }),
  };
}

describe('Agent Card Signing', () => {
  const secret = 'e2e-signing-secret';
  let testServer: TestA2AServer;
  let client: A2AClient;

  beforeAll(async () => {
    testServer = await startTestA2AServer({
      agents: { 'signed-agent': createMockAgent('signed-agent') },
      cogitator: createMockCogitator(),
      cardSigning: { secret },
    });
    client = new A2AClient(testServer.url);
  });

  afterAll(async () => {
    await testServer?.close();
  });

  it('signed card has signature field', async () => {
    const card = await client.agentCard();
    const signed = card as typeof card & { signature?: string };
    expect(signed.signature).toBeDefined();
    expect(typeof signed.signature).toBe('string');
    expect(signed.signature!.length).toBeGreaterThan(0);
    expect(signed.signature).toMatch(/^hmac-sha256:/);
  });

  it('client verifies card with correct secret', async () => {
    const valid = await client.verifyAgentCard(secret);
    expect(valid).toBe(true);
  });

  it('client verification fails with wrong secret', async () => {
    const valid = await client.verifyAgentCard('wrong-secret');
    expect(valid).toBe(false);
  });

  it('signAgentCard and verifyAgentCardSignature round-trip', () => {
    const card = {
      name: 'standalone-test',
      url: 'http://localhost:9999',
      version: '0.3' as const,
      capabilities: { streaming: true, pushNotifications: false },
      skills: [
        { id: 'ping', name: 'ping', inputModes: ['text/plain'], outputModes: ['text/plain'] },
      ],
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
    };

    const signed = signAgentCard(card, { secret: 'roundtrip-secret' });
    expect(signed.signature).toBeDefined();

    expect(verifyAgentCardSignature(signed, 'roundtrip-secret')).toBe(true);
    expect(verifyAgentCardSignature(signed, 'different-secret')).toBe(false);
  });
});

describe('Extended Agent Card', () => {
  let testServer: TestA2AServer;
  let client: A2AClient;

  const extendedGenerator = (agentName: string): ExtendedAgentCard => ({
    name: agentName,
    url: '/a2a',
    version: '0.3',
    capabilities: { streaming: true, pushNotifications: false },
    skills: [
      { id: 'search', name: 'search', inputModes: ['text/plain'], outputModes: ['text/plain'] },
    ],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    extendedSkills: [
      {
        id: 'deep-analysis',
        name: 'Deep Analysis',
        description: 'Performs deep analysis on data',
        inputModes: ['text/plain'],
        outputModes: ['application/json'],
      },
    ],
    rateLimit: { requestsPerMinute: 60 },
    pricing: { model: 'pay-per-use', details: '$0.01 per request' },
    metadata: { tier: 'premium', region: 'us-east-1' },
  });

  beforeAll(async () => {
    testServer = await startTestA2AServer({
      agents: { 'extended-agent': createMockAgent('extended-agent') },
      cogitator: createMockCogitator(),
      extendedCardGenerator: extendedGenerator,
    });
    client = new A2AClient(testServer.url);
  });

  afterAll(async () => {
    await testServer?.close();
  });

  it('extended card includes custom fields', async () => {
    const card = await client.extendedAgentCard();

    expect(card.extendedSkills).toHaveLength(1);
    expect(card.extendedSkills![0].id).toBe('deep-analysis');
    expect(card.extendedSkills![0].name).toBe('Deep Analysis');

    expect(card.rateLimit?.requestsPerMinute).toBe(60);

    expect(card.pricing?.model).toBe('pay-per-use');
    expect(card.pricing?.details).toBe('$0.01 per request');

    expect(card.metadata?.tier).toBe('premium');
    expect(card.metadata?.region).toBe('us-east-1');
  });

  it('extended card inherits base card fields', async () => {
    const card = await client.extendedAgentCard();

    expect(card.name).toBe('extended-agent');
    expect(card.version).toBe('0.3');
    expect(card.capabilities).toBeDefined();
    expect(card.capabilities.streaming).toBe(true);
    expect(card.skills).toBeDefined();
    expect(card.skills.length).toBeGreaterThanOrEqual(1);
    expect(card.defaultInputModes).toContain('text/plain');
    expect(card.defaultOutputModes).toContain('text/plain');
  });
});
