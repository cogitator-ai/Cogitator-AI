import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { canonicalJson, signAgentCard, verifyAgentCardSignature } from '../agent-card';
import { A2AServer } from '../server';
import type { AgentCard, CogitatorLike, AgentRunResult } from '../types';
import type { Agent, AgentConfig } from '@cogitator-ai/types';

function createTestCard(): AgentCard {
  return {
    protocolVersion: '0.3.0',
    name: 'test-agent',
    description: 'A test agent',
    url: 'https://example.com/a2a',
    version: '1.0.0',
    capabilities: { streaming: true, pushNotifications: false },
    skills: [
      {
        id: 'search',
        name: 'search',
        description: 'Search',
        tags: ['search'],
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
    it('should add a JWS signature (HS256, detached payload) to signatures', () => {
      const card = createTestCard();
      const signed = signAgentCard(card, { secret });
      expect(signed.signatures).toHaveLength(1);
      const [jws] = signed.signatures!;
      expect(JSON.parse(Buffer.from(jws.protected, 'base64url').toString('utf8'))).toEqual({
        alg: 'HS256',
        typ: 'JOSE',
      });
      expect(jws.signature).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('should sign the RFC 8785 canonical JSON of the card without its signatures', () => {
      const card = createTestCard();
      const signed = signAgentCard(card, { secret });
      const [jws] = signed.signatures!;
      const payload = Buffer.from(canonicalJson(card)).toString('base64url');
      const expected = createHmac('sha256', secret)
        .update(`${jws.protected}.${payload}`)
        .digest('base64url');
      expect(jws.signature).toBe(expected);
      expect(signAgentCard(signed, { secret }).signatures).toEqual(signed.signatures);
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
      expect(signed1.signatures).toEqual(signed2.signatures);
    });

    it('should produce different signatures for different secrets', () => {
      const card = createTestCard();
      const signed1 = signAgentCard(card, { secret: 'secret-a' });
      const signed2 = signAgentCard(card, { secret: 'secret-b' });
      expect(signed1.signatures).not.toEqual(signed2.signatures);
    });

    it('should produce same signature regardless of key order', () => {
      const base = createTestCard();
      const card1 = {
        protocolVersion: base.protocolVersion,
        name: base.name,
        url: base.url,
        version: base.version,
        description: base.description,
        capabilities: base.capabilities,
        skills: base.skills,
        defaultInputModes: base.defaultInputModes,
        defaultOutputModes: base.defaultOutputModes,
      } as AgentCard;
      const card2 = {
        defaultOutputModes: base.defaultOutputModes,
        defaultInputModes: base.defaultInputModes,
        skills: base.skills,
        capabilities: base.capabilities,
        description: base.description,
        version: base.version,
        url: base.url,
        name: base.name,
        protocolVersion: base.protocolVersion,
      } as AgentCard;
      const signed1 = signAgentCard(card1, { secret });
      const signed2 = signAgentCard(card2, { secret });
      expect(signed1.signatures).toEqual(signed2.signatures);
    });

    it('should produce different signatures for different cards', () => {
      const card1 = createTestCard();
      const card2 = { ...createTestCard(), name: 'different-agent' };
      const signed1 = signAgentCard(card1, { secret });
      const signed2 = signAgentCard(card2, { secret });
      expect(signed1.signatures).not.toEqual(signed2.signatures);
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

    it('should return false for a signature with another algorithm', () => {
      const card = createTestCard();
      const signed = signAgentCard(card, { secret });
      const [jws] = signed.signatures!;
      const none = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
      const withBadSig = { ...card, signatures: [{ ...jws, protected: none }] };
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

      const card = server.getAgentCard();
      expect(card.signatures).toHaveLength(1);
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

      const cards = server.getAgentCards();
      expect(cards).toHaveLength(2);
      for (const card of cards) {
        expect(card.signatures).toHaveLength(1);
        expect(verifyAgentCardSignature(card, secret)).toBe(true);
      }
    });

    it('should not sign cards when cardSigning is not configured', () => {
      const server = new A2AServer({
        agents: { test: createMockAgent('test') },
        cogitator: createMockCogitator(),
      });

      const card = server.getAgentCard();
      expect(card.signatures).toBeUndefined();
    });
  });
});
