import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { A2AClient } from '@cogitator-ai/a2a';
import {
  createTestCogitator,
  createTestAgent,
  createTestTools,
  isOllamaRunning,
} from '../../helpers/setup';
import { startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';
import type { Cogitator } from '@cogitator-ai/core';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('A2A: Agent Card Discovery', () => {
  let cogitator: Cogitator;
  let testServer: TestA2AServer;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();

    const tools = createTestTools();
    const agent = createTestAgent({
      name: 'discoverable-agent',
      instructions: 'You are a helpful math assistant.',
      tools: [tools.multiply, tools.add],
    });

    testServer = await startTestA2AServer({
      agents: { 'discoverable-agent': agent },
      cogitator,
    });
  });

  afterAll(async () => {
    await testServer?.close();
    await cogitator?.close();
  });

  it('serves agent card at well-known URL', async () => {
    const response = await fetch(`${testServer.url}/.well-known/agent-card.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');

    const card = await response.json();
    expect(card.name).toBe('discoverable-agent');
    expect(card.protocolVersion).toBe('0.3.0');
    expect(card.preferredTransport).toBe('JSONRPC');
    expect(card.url).toBe(`${testServer.url}/a2a`);
    expect(card.version).toBeDefined();
    expect(card.description).toBeDefined();
    expect(card.capabilities).toBeDefined();
    expect(card.skills).toBeDefined();
  });

  it('still serves the card at the pre-v0.3 well-known URL', async () => {
    const response = await fetch(`${testServer.url}/.well-known/agent.json`);
    expect(response.status).toBe(200);

    const card = await response.json();
    expect(card.name).toBe('discoverable-agent');
  });

  it('card reflects agent tools as skills', async () => {
    const response = await fetch(`${testServer.url}/.well-known/agent-card.json`);
    const card = await response.json();

    expect(card.skills.length).toBeGreaterThanOrEqual(2);
    const skillNames = card.skills.map((s: { name: string }) => s.name);
    expect(skillNames).toContain('multiply');
    expect(skillNames).toContain('add');
    for (const skill of card.skills as { tags: unknown }[]) {
      expect(Array.isArray(skill.tags)).toBe(true);
    }
  });

  it('client fetches and caches agent card', async () => {
    const client = new A2AClient(testServer.url);

    const card1 = await client.agentCard();
    expect(card1.name).toBe('discoverable-agent');

    const card2 = await client.agentCard();
    expect(card2.name).toBe('discoverable-agent');
    expect(card2).toEqual(card1);
  });
});
