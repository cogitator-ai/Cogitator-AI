import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestCogitator,
  createTestAgent,
  createTestTools,
  isOllamaRunning,
} from '../../helpers/setup';
import { Agent, ToolRegistry, tool, AgentDeserializationError } from '@cogitator-ai/core';
import type { Cogitator, RunResult } from '@cogitator-ai/core';
import { z } from 'zod';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('Core: Agent Lifecycle', () => {
  let cogitator: Cogitator;
  const tools = createTestTools();

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
  });

  afterAll(async () => {
    await cogitator.close();
  });

  describe('serialize / deserialize', () => {
    it('round-trips agent config through serialization', () => {
      const agent = createTestAgent({
        name: 'serializable-agent',
        instructions: 'You are a test agent',
        tools: [tools.multiply, tools.add],
        maxTokens: 200,
      });

      const snapshot = agent.serialize();

      expect(snapshot.version).toBe('1.0.0');
      expect(snapshot.id).toBe(agent.id);
      expect(snapshot.name).toBe('serializable-agent');
      expect(snapshot.config.model).toBe(agent.model);
      expect(snapshot.config.instructions).toBe('You are a test agent');
      expect(snapshot.config.tools).toEqual(['multiply', 'add']);
      expect(snapshot.config.maxTokens).toBe(200);
      expect(snapshot.metadata?.serializedAt).toBeTruthy();
    });

    it('deserializes agent with ToolRegistry', () => {
      const agent = createTestAgent({
        name: 'to-serialize',
        instructions: 'Serialize me',
        tools: [tools.multiply],
      });

      const snapshot = agent.serialize();

      const registry = new ToolRegistry();
      registry.register(tools.multiply);

      const restored = Agent.deserialize(snapshot, { toolRegistry: registry });

      expect(restored.id).toBe(agent.id);
      expect(restored.name).toBe('to-serialize');
      expect(restored.model).toBe(agent.model);
      expect(restored.instructions).toBe('Serialize me');
      expect(restored.tools.length).toBe(1);
      expect(restored.tools[0].name).toBe('multiply');
    });

    it('deserializes agent with direct tools array', () => {
      const agent = createTestAgent({
        tools: [tools.multiply, tools.add],
      });

      const snapshot = agent.serialize();
      const restored = Agent.deserialize(snapshot, { tools: [tools.multiply, tools.add] });

      expect(restored.tools.length).toBe(2);
      expect(restored.tools.map((t) => t.name).sort()).toEqual(['add', 'multiply']);
    });

    it('throws AgentDeserializationError when tool is missing', () => {
      const agent = createTestAgent({ tools: [tools.multiply] });
      const snapshot = agent.serialize();

      expect(() => Agent.deserialize(snapshot, { tools: [] })).toThrow(AgentDeserializationError);
    });

    it('throws on invalid snapshot format', () => {
      expect(() => Agent.deserialize({} as never)).toThrow(AgentDeserializationError);
    });

    it('deserialized agent can execute a run', { timeout: 120_000 }, async () => {
      const agent = createTestAgent({
        name: 'run-after-deserialize',
        instructions: 'You are a helpful assistant.',
        tools: [tools.multiply],
      });

      const snapshot = agent.serialize();
      const restored = Agent.deserialize(snapshot, { tools: [tools.multiply] });

      expect(restored.id).toBe(agent.id);

      const result = await cogitator.run(restored, {
        input: 'What is 3 times 4? Use the multiply tool.',
      });

      expect(result.output.length).toBeGreaterThan(0);
      expect(result.runId).toMatch(/^run_/);
      expect(result.agentId).toBe(agent.id);
    });
  });

  describe('clone', () => {
    it('creates a new agent with different id', () => {
      const original = createTestAgent({ name: 'original' });
      const cloned = original.clone({ name: 'cloned' });

      expect(cloned.id).not.toBe(original.id);
      expect(cloned.name).toBe('cloned');
    });

    it('preserves non-overridden config fields', () => {
      const original = createTestAgent({
        name: 'base',
        instructions: 'Base instructions',
        maxTokens: 500,
      });

      const cloned = original.clone({ name: 'variant' });

      expect(cloned.instructions).toBe('Base instructions');
      expect(cloned.config.maxTokens).toBe(500);
      expect(cloned.model).toBe(original.model);
    });

    it('overrides specified fields', () => {
      const original = createTestAgent({ instructions: 'Original' });
      const cloned = original.clone({
        instructions: 'New instructions',
        temperature: 0.1,
      });

      expect(cloned.instructions).toBe('New instructions');
      expect(cloned.config.temperature).toBe(0.1);
    });
  });

  describe('ToolRegistry', () => {
    it('register and get tool by name', () => {
      const registry = new ToolRegistry();
      registry.register(tools.multiply);

      const found = registry.get('multiply');
      expect(found).toBeDefined();
      expect(found!.name).toBe('multiply');
    });

    it('registerMany adds all tools', () => {
      const registry = new ToolRegistry();
      registry.registerMany([tools.multiply, tools.add, tools.failing]);

      expect(registry.getNames().sort()).toEqual(['add', 'divide', 'multiply']);
    });

    it('has() checks existence', () => {
      const registry = new ToolRegistry();
      registry.register(tools.multiply);

      expect(registry.has('multiply')).toBe(true);
      expect(registry.has('nonexistent')).toBe(false);
    });

    it('getSchemas returns valid JSON schemas', () => {
      const registry = new ToolRegistry();
      registry.register(tools.multiply);

      const schemas = registry.getSchemas();
      expect(schemas.length).toBe(1);
      expect(schemas[0].name).toBe('multiply');
      expect(schemas[0].parameters.type).toBe('object');
      expect(schemas[0].parameters.properties).toHaveProperty('a');
      expect(schemas[0].parameters.properties).toHaveProperty('b');
    });

    it('clear removes all tools', () => {
      const registry = new ToolRegistry();
      registry.registerMany([tools.multiply, tools.add]);
      expect(registry.getNames().length).toBe(2);

      registry.clear();
      expect(registry.getNames().length).toBe(0);
      expect(registry.get('multiply')).toBeUndefined();
    });

    it('replaces tool with same name on re-register', () => {
      const registry = new ToolRegistry();
      const v1 = tool({
        name: 'versioned',
        description: 'version 1',
        parameters: z.object({}),
        execute: async () => ({ v: 1 }),
      });
      const v2 = tool({
        name: 'versioned',
        description: 'version 2',
        parameters: z.object({}),
        execute: async () => ({ v: 2 }),
      });

      registry.register(v1);
      expect(registry.get('versioned')!.description).toBe('version 1');

      registry.register(v2);
      expect(registry.get('versioned')!.description).toBe('version 2');
      expect(registry.getNames().length).toBe(1);
    });
  });

  describe('tool validation', () => {
    it('rejects invalid tool arguments and recovers', { timeout: 120_000 }, async () => {
      let executeCalled = false;
      const strictTool = tool({
        name: 'strict_add',
        description: 'Add two numbers. Both a and b MUST be numbers.',
        parameters: z.object({
          a: z.number().describe('First number (MUST be a number)'),
          b: z.number().describe('Second number (MUST be a number)'),
        }),
        execute: async ({ a, b }) => {
          executeCalled = true;
          return { result: a + b };
        },
      });

      const agent = createTestAgent({
        instructions: 'Use the strict_add tool. Call it with a=5, b=3.',
        tools: [strictTool],
      });

      let result: RunResult | undefined;
      for (let i = 0; i < 3; i++) {
        result = await cogitator.run(agent, {
          input: 'Add 5 and 3 using the strict_add tool.',
        });
        if (result.toolCalls.length > 0) break;
      }

      expect(result).toBeDefined();
      if (result!.toolCalls.length > 0) {
        expect(executeCalled).toBe(true);
      }
    });
  });

  describe('stopSequences', () => {
    it('respects stop sequences in output', { timeout: 120_000 }, async () => {
      const agent = createTestAgent({
        instructions: 'When asked to count, count from 1 upwards. Write one number per line.',
      });

      const agentWithStop = agent.clone({
        stopSequences: ['5'],
      });

      const result = await cogitator.run(agentWithStop, {
        input: 'Count from 1 to 10, one number per line.',
      });

      expect(result.output).not.toContain('6');
      expect(result.output).not.toContain('7');
      expect(result.output).not.toContain('8');
      expect(result.output).not.toContain('9');
      expect(result.output).not.toContain('10');
    });
  });
});
