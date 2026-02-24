import { describe, it, expect, vi } from 'vitest';
import { A2AServer } from '../server';
import type { ExtendedAgentCard, CogitatorLike, AgentRunResult } from '../types';
import type { Agent, AgentConfig } from '@cogitator-ai/types';

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

describe('Extended Agent Card', () => {
  describe('server returns extended card', () => {
    it('should return extended card via agent/extendedCard method', async () => {
      const extendedCard: ExtendedAgentCard = {
        name: 'researcher',
        url: '/a2a',
        version: '0.3',
        capabilities: { streaming: true, pushNotifications: false },
        skills: [],
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        extendedSkills: [
          {
            id: 'deep-analysis',
            name: 'Deep Analysis',
            description: 'Performs deep analysis',
            inputModes: ['text/plain'],
            outputModes: ['application/json'],
          },
        ],
        rateLimit: { requestsPerMinute: 100 },
        pricing: { model: 'pay-per-use', details: '$0.01 per request' },
        metadata: { tier: 'premium' },
      };

      const server = new A2AServer({
        agents: { researcher: createMockAgent('researcher') },
        cogitator: createMockCogitator(),
        extendedCardGenerator: (agentName) => {
          expect(agentName).toBe('researcher');
          return extendedCard;
        },
      });

      const response = await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'agent/extendedCard',
        params: {},
        id: 1,
      });

      expect(response.error).toBeUndefined();
      const result = response.result as ExtendedAgentCard;
      expect(result.name).toBe('researcher');
      expect(result.extendedSkills).toHaveLength(1);
      expect(result.rateLimit?.requestsPerMinute).toBe(100);
      expect(result.pricing?.model).toBe('pay-per-use');
      expect(result.metadata?.tier).toBe('premium');
    });

    it('should use specified agentName parameter', async () => {
      const generatorSpy = vi.fn().mockReturnValue({
        name: 'writer',
        url: '/a2a',
        version: '0.3',
        capabilities: { streaming: true, pushNotifications: false },
        skills: [],
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
      });

      const server = new A2AServer({
        agents: {
          researcher: createMockAgent('researcher'),
          writer: createMockAgent('writer'),
        },
        cogitator: createMockCogitator(),
        extendedCardGenerator: generatorSpy,
      });

      await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'agent/extendedCard',
        params: { agentName: 'writer' },
        id: 1,
      });

      expect(generatorSpy).toHaveBeenCalledWith('writer');
    });

    it('should default to first agent when agentName not provided', async () => {
      const generatorSpy = vi.fn().mockReturnValue({
        name: 'researcher',
        url: '/a2a',
        version: '0.3',
        capabilities: { streaming: true, pushNotifications: false },
        skills: [],
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
      });

      const server = new A2AServer({
        agents: { researcher: createMockAgent('researcher') },
        cogitator: createMockCogitator(),
        extendedCardGenerator: generatorSpy,
      });

      await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'agent/extendedCard',
        params: {},
        id: 1,
      });

      expect(generatorSpy).toHaveBeenCalledWith('researcher');
    });
  });

  describe('server rejects extended card when not configured', () => {
    it('should return error when extendedCardGenerator is not set', async () => {
      const server = new A2AServer({
        agents: { researcher: createMockAgent('researcher') },
        cogitator: createMockCogitator(),
      });

      const response = await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'agent/extendedCard',
        params: {},
        id: 1,
      });

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32004);
    });

    it('should return error for unknown agent name', async () => {
      const server = new A2AServer({
        agents: { researcher: createMockAgent('researcher') },
        cogitator: createMockCogitator(),
        extendedCardGenerator: () => ({
          name: 'test',
          url: '/a2a',
          version: '0.3',
          capabilities: { streaming: true, pushNotifications: false },
          skills: [],
          defaultInputModes: ['text/plain'],
          defaultOutputModes: ['text/plain'],
        }),
      });

      const response = await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'agent/extendedCard',
        params: { agentName: 'nonexistent' },
        id: 1,
      });

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32007);
    });
  });

  describe('extendedAgentCard capability flag', () => {
    it('should set extendedAgentCard capability when generator is provided', () => {
      const server = new A2AServer({
        agents: { researcher: createMockAgent('researcher') },
        cogitator: createMockCogitator(),
        extendedCardGenerator: () => ({
          name: 'test',
          url: '/a2a',
          version: '0.3',
          capabilities: { streaming: true, pushNotifications: false },
          skills: [],
          defaultInputModes: ['text/plain'],
          defaultOutputModes: ['text/plain'],
        }),
      });

      const card = server.getAgentCard();
      expect(card.capabilities.extendedAgentCard).toBe(true);
    });

    it('should not set extendedAgentCard capability when generator is absent', () => {
      const server = new A2AServer({
        agents: { researcher: createMockAgent('researcher') },
        cogitator: createMockCogitator(),
      });

      const card = server.getAgentCard();
      expect(card.capabilities.extendedAgentCard).toBe(false);
    });
  });
});
