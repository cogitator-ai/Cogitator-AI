import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { generateAgentCard } from '../agent-card';
import type { Agent, Tool, AgentConfig } from '@cogitator-ai/types';

function createMockTool(name: string, description: string): Tool {
  return {
    name,
    description,
    parameters: z.object({ input: z.string() }),
    execute: vi.fn(),
    toJSON: () => ({ name, description, parameters: { type: 'object' as const, properties: {} } }),
  };
}

function createMockAgent(overrides: Partial<AgentConfig> & { name: string }): Agent {
  const config: AgentConfig = {
    name: overrides.name,
    model: overrides.model ?? 'test-model',
    instructions: overrides.instructions ?? 'test instructions',
    description: overrides.description,
    tools: overrides.tools,
  };
  return {
    id: `agent_${overrides.name}`,
    name: overrides.name,
    config,
    model: config.model,
    instructions: config.instructions,
    tools: config.tools ?? [],
    clone: vi.fn() as Agent['clone'],
    serialize: vi.fn() as Agent['serialize'],
  };
}

describe('generateAgentCard', () => {
  it('should generate card with correct name and description', () => {
    const agent = createMockAgent({ name: 'researcher', description: 'Research agent' });
    const card = generateAgentCard(agent, { url: 'https://example.com/a2a' });
    expect(card.name).toBe('researcher');
    expect(card.description).toBe('Research agent');
    expect(card.url).toBe('https://example.com/a2a');
  });

  it('should set version to 0.3', () => {
    const agent = createMockAgent({ name: 'test' });
    const card = generateAgentCard(agent, { url: 'https://example.com' });
    expect(card.version).toBe('0.3');
  });

  it('should have default capabilities', () => {
    const agent = createMockAgent({ name: 'test' });
    const card = generateAgentCard(agent, { url: 'https://example.com' });
    expect(card.capabilities).toEqual({ streaming: true, pushNotifications: false });
  });

  it('should override capabilities', () => {
    const agent = createMockAgent({ name: 'test' });
    const card = generateAgentCard(agent, {
      url: 'https://example.com',
      capabilities: { streaming: false },
    });
    expect(card.capabilities.streaming).toBe(false);
    expect(card.capabilities.pushNotifications).toBe(false);
  });

  it('should convert tools to skills', () => {
    const tools = [
      createMockTool('web_search', 'Search the web'),
      createMockTool('calculator', 'Do math'),
    ];
    const agent = createMockAgent({ name: 'test', tools });
    const card = generateAgentCard(agent, { url: 'https://example.com' });
    expect(card.skills).toHaveLength(2);
    expect(card.skills[0].id).toBe('web_search');
    expect(card.skills[0].name).toBe('web_search');
    expect(card.skills[0].description).toBe('Search the web');
    expect(card.skills[1].id).toBe('calculator');
  });

  it('should handle agent with no tools', () => {
    const agent = createMockAgent({ name: 'test' });
    const card = generateAgentCard(agent, { url: 'https://example.com' });
    expect(card.skills).toEqual([]);
  });

  it('should include provider when specified', () => {
    const agent = createMockAgent({ name: 'test' });
    const card = generateAgentCard(agent, {
      url: 'https://example.com',
      provider: { name: 'Cogitator', url: 'https://cogitator.ai' },
    });
    expect(card.provider).toEqual({ name: 'Cogitator', url: 'https://cogitator.ai' });
  });

  it('should not include provider when not specified', () => {
    const agent = createMockAgent({ name: 'test' });
    const card = generateAgentCard(agent, { url: 'https://example.com' });
    expect(card.provider).toBeUndefined();
  });

  it('should set default input/output modes', () => {
    const agent = createMockAgent({ name: 'test' });
    const card = generateAgentCard(agent, { url: 'https://example.com' });
    expect(card.defaultInputModes).toEqual(['text/plain']);
    expect(card.defaultOutputModes).toEqual(['text/plain', 'application/json']);
  });

  it('should set skill input/output modes', () => {
    const tools = [createMockTool('search', 'Search things')];
    const agent = createMockAgent({ name: 'test', tools });
    const card = generateAgentCard(agent, { url: 'https://example.com' });
    expect(card.skills[0].inputModes).toEqual(['text/plain', 'application/json']);
    expect(card.skills[0].outputModes).toEqual(['text/plain', 'application/json']);
  });
});
