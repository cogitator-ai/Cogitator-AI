import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { A2AClient, signAgentCard, verifyAgentCardSignature } from '@cogitator-ai/a2a';
import type { AgentCard, AgentRunResult, ExtendedAgentCard } from '@cogitator-ai/a2a';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import { createStubAgent, startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';

function createMockAgent(name: string): Agent {
  const config: AgentConfig = {
    name,
    model: 'mock',
    instructions: 'test',
    description: `${name} agent`,
  };
  return createStubAgent(config);
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

  it('signed card carries a JWS signature', async () => {
    const card = await client.agentCard();
    expect(card.signatures).toHaveLength(1);

    const [signature] = card.signatures!;
    expect(signature.signature.length).toBeGreaterThan(0);
    const header = JSON.parse(Buffer.from(signature.protected, 'base64url').toString('utf8'));
    expect(header.alg).toBe('HS256');
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
    const card: AgentCard = {
      protocolVersion: '0.3.0',
      name: 'standalone-test',
      description: 'Standalone signing test',
      url: 'http://localhost:9999/a2a',
      preferredTransport: 'JSONRPC',
      version: '1.0.0',
      capabilities: { streaming: true, pushNotifications: false },
      skills: [
        {
          id: 'ping',
          name: 'ping',
          description: 'Answers with pong',
          tags: ['tool'],
          inputModes: ['text/plain'],
          outputModes: ['text/plain'],
        },
      ],
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
    };

    const signed = signAgentCard(card, { secret: 'roundtrip-secret' });
    expect(signed.signatures).toHaveLength(1);

    expect(verifyAgentCardSignature(signed, 'roundtrip-secret')).toBe(true);
    expect(verifyAgentCardSignature(signed, 'different-secret')).toBe(false);
    expect(
      verifyAgentCardSignature({ ...signed, description: 'tampered' }, 'roundtrip-secret')
    ).toBe(false);
  });
});

describe('Extended Agent Card', () => {
  let testServer: TestA2AServer;
  let client: A2AClient;

  const extendedGenerator = (agentName: string): ExtendedAgentCard => ({
    protocolVersion: '0.3.0',
    name: agentName,
    description: `${agentName} with premium skills`,
    url: 'http://localhost/a2a',
    preferredTransport: 'JSONRPC',
    version: '2.1.0',
    provider: { organization: 'Cogitator E2E', url: 'https://example.com' },
    documentationUrl: 'https://example.com/docs',
    capabilities: { streaming: true, pushNotifications: false },
    skills: [
      {
        id: 'search',
        name: 'search',
        description: 'Searches the web',
        tags: ['search'],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
      },
      {
        id: 'deep-analysis',
        name: 'Deep Analysis',
        description: 'Performs deep analysis on data',
        tags: ['analysis', 'premium'],
        inputModes: ['text/plain'],
        outputModes: ['application/json'],
      },
    ],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
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

  it('public card advertises the authenticated extended card', async () => {
    const card = await client.agentCard();
    expect(card.supportsAuthenticatedExtendedCard).toBe(true);
    expect(card.skills.some((skill) => skill.id === 'deep-analysis')).toBe(false);
  });

  it('extended card includes the extra skills and details', async () => {
    const card = await client.extendedAgentCard();

    const deep = card.skills.find((skill) => skill.id === 'deep-analysis');
    expect(deep).toBeDefined();
    expect(deep!.name).toBe('Deep Analysis');
    expect(deep!.tags).toContain('premium');
    expect(deep!.outputModes).toEqual(['application/json']);

    expect(card.provider?.organization).toBe('Cogitator E2E');
    expect(card.documentationUrl).toBe('https://example.com/docs');
  });

  it('extended card carries the base card fields', async () => {
    const card = await client.extendedAgentCard();

    expect(card.name).toBe('extended-agent');
    expect(card.protocolVersion).toBe('0.3.0');
    expect(card.version).toBe('2.1.0');
    expect(card.capabilities).toBeDefined();
    expect(card.capabilities.streaming).toBe(true);
    expect(card.skills.length).toBeGreaterThanOrEqual(1);
    expect(card.defaultInputModes).toContain('text/plain');
    expect(card.defaultOutputModes).toContain('text/plain');
  });
});
