import { describe, it, expect, vi } from 'vitest';
import { signAgentCard, verifyAgentCardSignature } from '../agent-card';
import { A2AServer } from '../server';
import type { AgentCard } from '../types';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import type { CogitatorLike, AgentRunResult } from '../task-manager';

function createTestCard(): AgentCard {
  return {
    name: 'test-agent',
    description: 'A test agent',
    url: 'https://example.com/a2a',
    version: '0.3',
    capabilities: { streaming: true, pushNotifications: false },
    skills: [
      {
        id: 'search',
        name: 'search',
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
      },
    ],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
  };
}

function createMockAgent(name: string): Agent {
  const config: AgentConfig = {
    name,
    model: 'test-model',
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
    clone: vi.fn() as Agent['clone'],
    serialize: vi.fn() as Agent['serialize'],
  };
}

function createMockCogitator(): CogitatorLike {
  const result: AgentRunResult = {
    output: 'test',
    runId: 'run_1',
    agentId: 'agent_1',
    threadId: 'thread_1',
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, cost: 0.001, duration: 100 },
    toolCalls: [],
  };
  return { run: vi.fn().mockResolvedValue(result) };
}

describe('Agent Card Signing', () => {
  const secret = 'my-signing-secret';

  describe('signAgentCard', () => {
    it('should produce a card with signature field', () => {
      const card = createTestCard();
      const signed = signAgentCard(card, { secret });
      expect(signed.signature).toBeDefined();
      expect(signed.signature).toMatch(/^hmac-sha256:/);
    });

    it('should preserve all original card fields', () => {
      const card = createTestCard();
      const signed = signAgentCard(card, { secret });
      expect(signed.name).toBe(card.name);
      expect(signed.url).toBe(card.url);
      expect(signed.version).toBe(card.version);
      expect(signed.skills).toEqual(card.skills);
    });

    it('should produce deterministic signatures', () => {
      const card = createTestCard();
      const signed1 = signAgentCard(card, { secret });
      const signed2 = signAgentCard(card, { secret });
      expect(signed1.signature).toBe(signed2.signature);
    });

    it('should produce different signatures for different secrets', () => {
      const card = createTestCard();
      const signed1 = signAgentCard(card, { secret: 'secret-a' });
      const signed2 = signAgentCard(card, { secret: 'secret-b' });
      expect(signed1.signature).not.toBe(signed2.signature);
    });

    it('should produce different signatures for different cards', () => {
      const card1 = createTestCard();
      const card2 = { ...createTestCard(), name: 'different-agent' };
      const signed1 = signAgentCard(card1, { secret });
      const signed2 = signAgentCard(card2, { secret });
      expect(signed1.signature).not.toBe(signed2.signature);
    });
  });

  describe('verifyAgentCardSignature', () => {
    it('should return true for valid signature', () => {
      const card = createTestCard();
      const signed = signAgentCard(card, { secret });
      expect(verifyAgentCardSignature(signed, secret)).toBe(true);
    });

    it('should return false for tampered card', () => {
      const card = createTestCard();
      const signed = signAgentCard(card, { secret });
      const tampered = { ...signed, name: 'tampered-agent' };
      expect(verifyAgentCardSignature(tampered, secret)).toBe(false);
    });

    it('should return false for wrong secret', () => {
      const card = createTestCard();
      const signed = signAgentCard(card, { secret });
      expect(verifyAgentCardSignature(signed, 'wrong-secret')).toBe(false);
    });

    it('should return false for unsigned card', () => {
      const card = createTestCard();
      expect(verifyAgentCardSignature(card, secret)).toBe(false);
    });

    it('should return false for unknown algorithm prefix', () => {
      const card = createTestCard();
      const withBadSig = { ...card, signature: 'unknown-algo:abc123' };
      expect(verifyAgentCardSignature(withBadSig, secret)).toBe(false);
    });
  });

  describe('Server integration', () => {
    it('should sign agent cards when cardSigning is configured', () => {
      const server = new A2AServer({
        agents: { test: createMockAgent('test') },
        cogitator: createMockCogitator(),
        cardSigning: { secret },
      });

      const card = server.getAgentCard() as AgentCard & { signature?: string };
      expect(card.signature).toBeDefined();
      expect(card.signature).toMatch(/^hmac-sha256:/);
      expect(verifyAgentCardSignature(card, secret)).toBe(true);
    });

    it('should sign all agent cards from getAgentCards', () => {
      const server = new A2AServer({
        agents: {
          agent1: createMockAgent('agent1'),
          agent2: createMockAgent('agent2'),
        },
        cogitator: createMockCogitator(),
        cardSigning: { secret },
      });

      const cards = server.getAgentCards() as (AgentCard & { signature?: string })[];
      expect(cards).toHaveLength(2);
      for (const card of cards) {
        expect(card.signature).toBeDefined();
        expect(verifyAgentCardSignature(card, secret)).toBe(true);
      }
    });

    it('should not sign cards when cardSigning is not configured', () => {
      const server = new A2AServer({
        agents: { test: createMockAgent('test') },
        cogitator: createMockCogitator(),
      });

      const card = server.getAgentCard() as AgentCard & { signature?: string };
      expect(card.signature).toBeUndefined();
    });
  });
});
