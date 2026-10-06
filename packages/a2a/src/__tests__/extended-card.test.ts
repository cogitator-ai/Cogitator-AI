import { describe, it, expect, vi } from 'vitest';
import { A2AServer } from '../server';
import type { AgentCard, CogitatorLike, AgentRunResult } from '../types';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import { expectResponse } from './helpers';

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

function cardOf(name: string, extra: Partial<AgentCard> = {}): AgentCard {
  return {
    protocolVersion: '0.3.0',
    name,
    description: `${name} with every skill`,
    url: 'https://agents.example.com/a2a',
    version: '1.0.0',
    capabilities: { streaming: true, pushNotifications: true },
    skills: [],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    ...extra,
  };
}

function extendedCardRequest(params?: unknown) {
  return {
    jsonrpc: '2.0',
    method: 'agent/getAuthenticatedExtendedCard',
    ...(params !== undefined && { params }),
    id: 1,
  };
}

describe('Authenticated extended Agent Card', () => {
  it('is returned by agent/getAuthenticatedExtendedCard', async () => {
    const extended = cardOf('researcher', {
      skills: [
        {
          id: 'deep-analysis',
          name: 'Deep Analysis',
          description: 'Performs deep analysis',
          tags: ['analysis'],
        },
      ],
    });
    const server = new A2AServer({
      agents: { researcher: createMockAgent('researcher') },
      cogitator: createMockCogitator(),
      extendedCardGenerator: (agentName) => {
        expect(agentName).toBe('researcher');
        return extended;
      },
    });

    const response = expectResponse(await server.handleJsonRpc(extendedCardRequest()));

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual(extended);
  });

  it('is the card of the agent the endpoint addresses, or of agentName', async () => {
    const generator = vi.fn((name: string) => cardOf(name));
    const server = new A2AServer({
      agents: { researcher: createMockAgent('researcher'), writer: createMockAgent('writer') },
      cogitator: createMockCogitator(),
      extendedCardGenerator: generator,
    });

    await server.handleJsonRpc(extendedCardRequest(), undefined, { agentName: 'writer' });
    expect(generator).toHaveBeenLastCalledWith('writer');

    await server.handleJsonRpc(extendedCardRequest({ agentName: 'writer' }));
    expect(generator).toHaveBeenLastCalledWith('writer');

    await server.handleJsonRpc(extendedCardRequest());
    expect(generator).toHaveBeenLastCalledWith('researcher');
  });

  it('is signed like the public card', async () => {
    const server = new A2AServer({
      agents: { researcher: createMockAgent('researcher') },
      cogitator: createMockCogitator(),
      extendedCardGenerator: (name) => cardOf(name),
      cardSigning: { secret: 's' },
    });
    const response = expectResponse(await server.handleJsonRpc(extendedCardRequest()));
    expect((response.result as AgentCard).signatures).toHaveLength(1);
  });

  it('reports AuthenticatedExtendedCardNotConfiguredError without a generator', async () => {
    const server = new A2AServer({
      agents: { researcher: createMockAgent('researcher') },
      cogitator: createMockCogitator(),
    });

    const response = expectResponse(await server.handleJsonRpc(extendedCardRequest()));

    expect(response.error?.code).toBe(-32007);
  });

  it('reports an unknown agent name as invalid params', async () => {
    const server = new A2AServer({
      agents: { researcher: createMockAgent('researcher') },
      cogitator: createMockCogitator(),
      extendedCardGenerator: (name) => cardOf(name),
    });

    const response = expectResponse(
      await server.handleJsonRpc(extendedCardRequest({ agentName: 'nonexistent' }))
    );

    expect(response.error?.code).toBe(-32602);
  });

  it('is announced by supportsAuthenticatedExtendedCard only with a generator', () => {
    const withGenerator = new A2AServer({
      agents: { researcher: createMockAgent('researcher') },
      cogitator: createMockCogitator(),
      extendedCardGenerator: (name) => cardOf(name),
    });
    expect(withGenerator.getAgentCard().supportsAuthenticatedExtendedCard).toBe(true);

    const without = new A2AServer({
      agents: { researcher: createMockAgent('researcher') },
      cogitator: createMockCogitator(),
    });
    expect(without.getAgentCard().supportsAuthenticatedExtendedCard).toBeUndefined();
  });
});
