import { describe, it, expect } from 'vitest';
import { Agent, AgentDeserializationError } from '../agent';
import { ToolRegistry } from '../registry';
import { tool } from '../tool';
import { z } from 'zod';

const createTestTool = (name: string) =>
  tool({
    name,
    description: `Test tool: ${name}`,
    parameters: z.object({ input: z.string() }),
    execute: async ({ input }) => `Result: ${input}`,
  });

describe('Agent Serialization', () => {
  describe('serialize()', () => {
    it('serializes basic agent config', () => {
      const agent = new Agent({
        name: 'test-agent',
        model: 'openai/gpt-4o',
        instructions: 'You are a helpful assistant.',
      });

      const snapshot = agent.serialize();

      expect(snapshot.version).toBe('1.0.0');
      expect(snapshot.id).toBe(agent.id);
      expect(snapshot.name).toBe('test-agent');
      expect(snapshot.config.model).toBe('openai/gpt-4o');
      expect(snapshot.config.instructions).toBe('You are a helpful assistant.');
      expect(snapshot.config.tools).toEqual([]);
      expect(snapshot.metadata?.serializedAt).toBeDefined();
    });

    it('serializes agent with tools (names only)', () => {
      const calc = createTestTool('calculator');
      const search = createTestTool('search');

      const agent = new Agent({
        name: 'tool-agent',
        model: 'openai/gpt-4o',
        instructions: 'Use tools.',
        tools: [calc, search],
      });

      const snapshot = agent.serialize();

      expect(snapshot.config.tools).toEqual(['calculator', 'search']);
    });

    it('serializes all config options', () => {
      const agent = new Agent({
        id: 'custom-id',
        name: 'full-config-agent',
        description: 'Test description',
        model: 'anthropic/claude-3-opus',
        provider: 'anthropic',
        instructions: 'Be precise.',
        temperature: 0.5,
        topP: 0.9,
        maxTokens: 2000,
        stopSequences: ['END', 'STOP'],
        maxIterations: 5,
        timeout: 60000,
      });

      const snapshot = agent.serialize();

      expect(snapshot.id).toBe('custom-id');
      expect(snapshot.config.description).toBe('Test description');
      expect(snapshot.config.provider).toBe('anthropic');
      expect(snapshot.config.temperature).toBe(0.5);
      expect(snapshot.config.topP).toBe(0.9);
      expect(snapshot.config.maxTokens).toBe(2000);
      expect(snapshot.config.stopSequences).toEqual(['END', 'STOP']);
      expect(snapshot.config.maxIterations).toBe(5);
      expect(snapshot.config.timeout).toBe(60000);
    });

    it('produces JSON-serializable output', () => {
      const agent = new Agent({
        name: 'json-agent',
        model: 'openai/gpt-4o',
        instructions: 'Test',
        tools: [createTestTool('test')],
      });

      const snapshot = agent.serialize();
      const json = JSON.stringify(snapshot);
      const parsed = JSON.parse(json);

      expect(parsed.name).toBe('json-agent');
      expect(parsed.config.tools).toEqual(['test']);
    });
  });

  describe('deserialize()', () => {
    it('restores agent from snapshot with toolRegistry', () => {
      const calc = createTestTool('calculator');
      const registry = new ToolRegistry();
      registry.register(calc);

      const original = new Agent({
        name: 'original',
        model: 'openai/gpt-4o',
        instructions: 'Use calculator.',
        tools: [calc],
      });

      const snapshot = original.serialize();
      const restored = Agent.deserialize(snapshot, { toolRegistry: registry });

      expect(restored.id).toBe(original.id);
      expect(restored.name).toBe('original');
      expect(restored.model).toBe('openai/gpt-4o');
      expect(restored.instructions).toBe('Use calculator.');
      expect(restored.tools).toHaveLength(1);
      expect(restored.tools[0].name).toBe('calculator');
    });

    it('restores agent from snapshot with tools array', () => {
      const calc = createTestTool('calculator');

      const original = new Agent({
        name: 'original',
        model: 'openai/gpt-4o',
        instructions: 'Test',
        tools: [calc],
      });

      const snapshot = original.serialize();
      const restored = Agent.deserialize(snapshot, { tools: [calc] });

      expect(restored.tools).toHaveLength(1);
      expect(restored.tools[0].name).toBe('calculator');
    });

    it('restores agent without tools', () => {
      const original = new Agent({
        name: 'no-tools',
        model: 'openai/gpt-4o',
        instructions: 'No tools needed.',
      });

      const snapshot = original.serialize();
      const restored = Agent.deserialize(snapshot);

      expect(restored.name).toBe('no-tools');
      expect(restored.tools).toHaveLength(0);
    });

    it('applies overrides during deserialization', () => {
      const original = new Agent({
        name: 'original',
        model: 'openai/gpt-4o',
        instructions: 'Test',
        temperature: 0.5,
      });

      const snapshot = original.serialize();
      const restored = Agent.deserialize(snapshot, {
        overrides: {
          model: 'anthropic/claude-3-opus',
          temperature: 0.9,
        },
      });

      expect(restored.model).toBe('anthropic/claude-3-opus');
      expect(restored.config.temperature).toBe(0.9);
      expect(restored.name).toBe('original');
    });

    it('throws when tool not found in registry', () => {
      const calc = createTestTool('calculator');
      const registry = new ToolRegistry();

      const original = new Agent({
        name: 'test',
        model: 'openai/gpt-4o',
        instructions: 'Test',
        tools: [calc],
      });

      const snapshot = original.serialize();

      expect(() => Agent.deserialize(snapshot, { toolRegistry: registry })).toThrow(
        AgentDeserializationError
      );
      expect(() => Agent.deserialize(snapshot, { toolRegistry: registry })).toThrow(
        'Tool "calculator" not found'
      );
    });

    it('throws when tool not found in tools array', () => {
      const calc = createTestTool('calculator');
      const otherTool = createTestTool('other');

      const original = new Agent({
        name: 'test',
        model: 'openai/gpt-4o',
        instructions: 'Test',
        tools: [calc],
      });

      const snapshot = original.serialize();

      expect(() => Agent.deserialize(snapshot, { tools: [otherTool] })).toThrow(
        AgentDeserializationError
      );
    });

    it('throws on invalid snapshot', () => {
      expect(() => Agent.deserialize({} as never)).toThrow(AgentDeserializationError);
      expect(() => Agent.deserialize({} as never)).toThrow('Invalid snapshot format');
    });

    it('preserves custom id', () => {
      const original = new Agent({
        id: 'my-custom-id',
        name: 'test',
        model: 'openai/gpt-4o',
        instructions: 'Test',
      });

      const snapshot = original.serialize();
      const restored = Agent.deserialize(snapshot);

      expect(restored.id).toBe('my-custom-id');
    });
  });

  describe('validateSnapshot()', () => {
    it('returns true for valid snapshot', () => {
      const agent = new Agent({
        name: 'test',
        model: 'openai/gpt-4o',
        instructions: 'Test',
      });

      const snapshot = agent.serialize();
      expect(Agent.validateSnapshot(snapshot)).toBe(true);
    });

    it('returns false for null/undefined', () => {
      expect(Agent.validateSnapshot(null)).toBe(false);
      expect(Agent.validateSnapshot(undefined)).toBe(false);
    });

    it('returns false for non-object', () => {
      expect(Agent.validateSnapshot('string')).toBe(false);
      expect(Agent.validateSnapshot(123)).toBe(false);
    });

    it('returns false when missing required fields', () => {
      expect(Agent.validateSnapshot({})).toBe(false);
      expect(Agent.validateSnapshot({ version: '1.0.0' })).toBe(false);
      expect(Agent.validateSnapshot({ version: '1.0.0', id: 'x' })).toBe(false);
      expect(Agent.validateSnapshot({ version: '1.0.0', id: 'x', name: 'y' })).toBe(false);
    });

    it('returns false when config is invalid', () => {
      expect(
        Agent.validateSnapshot({
          version: '1.0.0',
          id: 'x',
          name: 'y',
          config: {},
        })
      ).toBe(false);

      expect(
        Agent.validateSnapshot({
          version: '1.0.0',
          id: 'x',
          name: 'y',
          config: { model: 'test' },
        })
      ).toBe(false);

      expect(
        Agent.validateSnapshot({
          version: '1.0.0',
          id: 'x',
          name: 'y',
          config: { model: 'test', instructions: 'test' },
        })
      ).toBe(false);
    });

    it('returns true for minimal valid snapshot', () => {
      expect(
        Agent.validateSnapshot({
          version: '1.0.0',
          id: 'x',
          name: 'y',
          config: {
            model: 'test',
            instructions: 'test',
            tools: [],
          },
        })
      ).toBe(true);
    });
  });

  describe('round-trip', () => {
    it('preserves agent state through serialize/deserialize cycle', () => {
      const tools = [createTestTool('calc'), createTestTool('search')];
      const registry = new ToolRegistry();
      tools.forEach((t) => registry.register(t));

      const original = new Agent({
        id: 'round-trip-id',
        name: 'round-trip-agent',
        description: 'Test description',
        model: 'anthropic/claude-3-opus',
        provider: 'anthropic',
        instructions: 'Be helpful and use tools.',
        tools,
        temperature: 0.8,
        topP: 0.95,
        maxTokens: 4000,
        stopSequences: ['###'],
        maxIterations: 8,
        timeout: 90000,
      });

      const snapshot = original.serialize();
      const json = JSON.stringify(snapshot);
      const parsed = JSON.parse(json);
      const restored = Agent.deserialize(parsed, { toolRegistry: registry });

      expect(restored.id).toBe(original.id);
      expect(restored.name).toBe(original.name);
      expect(restored.model).toBe(original.model);
      expect(restored.instructions).toBe(original.instructions);
      expect(restored.tools.map((t) => t.name)).toEqual(original.tools.map((t) => t.name));
      expect(restored.config.description).toBe(original.config.description);
      expect(restored.config.provider).toBe(original.config.provider);
      expect(restored.config.temperature).toBe(original.config.temperature);
      expect(restored.config.topP).toBe(original.config.topP);
      expect(restored.config.maxTokens).toBe(original.config.maxTokens);
      expect(restored.config.stopSequences).toEqual(original.config.stopSequences);
      expect(restored.config.maxIterations).toBe(original.config.maxIterations);
      expect(restored.config.timeout).toBe(original.config.timeout);
    });
  });
});
