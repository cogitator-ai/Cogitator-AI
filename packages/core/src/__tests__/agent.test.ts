import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { Tool } from '@cogitator/types';
import { Agent } from '../agent.js';
import { tool } from '../tool.js';

describe('Agent', () => {
  const createBasicConfig = () => ({
    name: 'test-agent',
    model: 'ollama/llama3.1:8b',
    instructions: 'You are a helpful assistant.',
  });

  describe('constructor', () => {
    it('creates an agent with required config', () => {
      const agent = new Agent(createBasicConfig());

      expect(agent.name).toBe('test-agent');
      expect(agent.model).toBe('ollama/llama3.1:8b');
      expect(agent.instructions).toBe('You are a helpful assistant.');
    });

    it('generates a unique id', () => {
      const agent1 = new Agent(createBasicConfig());
      const agent2 = new Agent(createBasicConfig());

      expect(agent1.id).toMatch(/^agent_/);
      expect(agent2.id).toMatch(/^agent_/);
      expect(agent1.id).not.toBe(agent2.id);
    });

    it('applies default values for temperature, maxIterations, timeout', () => {
      const agent = new Agent(createBasicConfig());

      expect(agent.config.temperature).toBe(0.7);
      expect(agent.config.maxIterations).toBe(10);
      expect(agent.config.timeout).toBe(120_000);
    });

    it('allows overriding default values', () => {
      const agent = new Agent({
        ...createBasicConfig(),
        temperature: 0.9,
        maxIterations: 5,
        timeout: 60_000,
      });

      expect(agent.config.temperature).toBe(0.9);
      expect(agent.config.maxIterations).toBe(5);
      expect(agent.config.timeout).toBe(60_000);
    });
  });

  describe('tools', () => {
    it('returns empty array when no tools configured', () => {
      const agent = new Agent(createBasicConfig());
      expect(agent.tools).toEqual([]);
    });

    it('returns configured tools', () => {
      const myTool = tool({
        name: 'my-tool',
        description: 'A test tool',
        parameters: z.object({ x: z.string() }),
        execute: () => Promise.resolve('result'),
      }) as Tool;

      const agent = new Agent({
        ...createBasicConfig(),
        tools: [myTool],
      });

      expect(agent.tools).toHaveLength(1);
      expect(agent.tools[0].name).toBe('my-tool');
    });
  });

  describe('clone()', () => {
    it('creates a new agent with the same config', () => {
      const original = new Agent({
        ...createBasicConfig(),
        temperature: 0.5,
      });

      const cloned = original.clone({});

      expect(cloned.id).not.toBe(original.id);
      expect(cloned.name).toBe(original.name);
      expect(cloned.model).toBe(original.model);
      expect(cloned.config.temperature).toBe(0.5);
    });

    it('applies overrides to the cloned agent', () => {
      const original = new Agent({
        ...createBasicConfig(),
        temperature: 0.5,
      });

      const cloned = original.clone({
        name: 'cloned-agent',
        temperature: 0.9,
      });

      expect(cloned.name).toBe('cloned-agent');
      expect(cloned.config.temperature).toBe(0.9);
      // Original unchanged
      expect(original.name).toBe('test-agent');
      expect(original.config.temperature).toBe(0.5);
    });
  });
});
