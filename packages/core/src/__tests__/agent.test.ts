import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { Tool } from '@cogitator-ai/types';
import { nanoid } from 'nanoid';
import { Agent } from '../agent';
import { tool } from '../tool';

vi.mock('nanoid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nanoid')>();
  return { ...actual, nanoid: vi.fn(actual.nanoid) };
});

describe('Agent', () => {
  it('generates its id on first read, not in the constructor', () => {
    vi.mocked(nanoid).mockClear();

    const agent = new Agent({ name: 'edge', instructions: 'x' });
    expect(nanoid).not.toHaveBeenCalled();

    expect(agent.id).toMatch(/^agent_/);
    expect(agent.id).toBe(agent.id);
    expect(nanoid).toHaveBeenCalledTimes(1);
    expect(new Agent({ name: 'edge', instructions: 'x', id: 'fixed' }).id).toBe('fixed');
  });

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

    it('applies default values for temperature and maxIterations', () => {
      const agent = new Agent(createBasicConfig());

      expect(agent.config.temperature).toBe(0.7);
      expect(agent.config.maxIterations).toBe(10);
    });

    it('leaves timeout unset so limits.defaultTimeout of the runtime can apply', () => {
      expect(new Agent(createBasicConfig()).config.timeout).toBeUndefined();
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
      expect(original.name).toBe('test-agent');
      expect(original.config.temperature).toBe(0.5);
    });
  });
});
