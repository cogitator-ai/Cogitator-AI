import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import type { Tool } from '@cogitator-ai/types';
import { ToolRegistry } from '../registry';
import { tool } from '../tool';
import { getLogger } from '../logger';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  const createMockTool = (name: string): Tool =>
    tool({
      name,
      description: `Test tool: ${name}`,
      parameters: z.object({ input: z.string() }),
      execute: () => Promise.resolve('result'),
    }) as Tool;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe('register()', () => {
    it('registers a single tool', () => {
      const myTool = createMockTool('test-tool');
      registry.register(myTool);

      expect(registry.has('test-tool')).toBe(true);
    });

    it('overwrites existing tool with same name', () => {
      const tool1 = createMockTool('same-name');
      const tool2 = tool({
        name: 'same-name',
        description: 'Updated description',
        parameters: z.object({ x: z.number() }),
        execute: () => Promise.resolve(42),
      }) as Tool;

      registry.register(tool1);
      registry.register(tool2);

      const retrieved = registry.get('same-name');
      expect(retrieved?.description).toBe('Updated description');
    });

    it('refuses a hand-built tool whose maxResultLength is not a positive integer', () => {
      const handBuilt = { ...createMockTool('dump'), maxResultLength: -1 } as Tool;
      expect(() => registry.register(handBuilt)).toThrow(
        /maxResultLength of tool "dump" must be a positive integer/
      );
      expect(registry.has('dump')).toBe(false);
    });

    describe('replacing a tool', () => {
      afterEach(() => vi.restoreAllMocks());

      const replacementWarnings = (warn: { mock: { calls: unknown[][] } }) =>
        warn.mock.calls.filter(([message]) => String(message).includes('replaces another tool'));

      it('warns when a different tool takes the name', () => {
        const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
        registry.register(createMockTool('search'));
        registry.register(createMockTool('search'));

        const warnings = replacementWarnings(warn);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]![0]).toContain('Tool "search"');
        expect(warnings[0]![1]).toEqual({ tool: 'search' });
      });

      it('stays quiet when the same tool is registered again', () => {
        const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
        const search = createMockTool('search');
        registry.register(search);
        registry.register(search);

        expect(replacementWarnings(warn)).toHaveLength(0);
      });

      it('stays quiet with replace: true, and the new tool wins', () => {
        const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
        const replacement = createMockTool('search');
        registry.register(createMockTool('search'));
        registry.register(replacement, { replace: true });

        expect(replacementWarnings(warn)).toHaveLength(0);
        expect(registry.get('search')).toBe(replacement);
      });

      it('warns for a clash inside one registerMany call and against earlier tools', () => {
        const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
        registry.register(createMockTool('a'));
        registry.registerMany([createMockTool('a'), createMockTool('b'), createMockTool('b')]);

        expect(replacementWarnings(warn).map(([, meta]) => meta)).toEqual([
          { tool: 'a' },
          { tool: 'b' },
        ]);
      });
    });
  });

  describe('registerMany()', () => {
    it('registers multiple tools at once', () => {
      const tools = [createMockTool('tool-1'), createMockTool('tool-2'), createMockTool('tool-3')];

      registry.registerMany(tools);

      expect(registry.has('tool-1')).toBe(true);
      expect(registry.has('tool-2')).toBe(true);
      expect(registry.has('tool-3')).toBe(true);
    });
  });

  describe('get()', () => {
    it('returns the tool if it exists', () => {
      const myTool = createMockTool('my-tool');
      registry.register(myTool);

      const retrieved = registry.get('my-tool');
      expect(retrieved).toBe(myTool);
    });

    it('returns undefined if tool does not exist', () => {
      const retrieved = registry.get('non-existent');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('has()', () => {
    it('returns true if tool exists', () => {
      registry.register(createMockTool('exists'));
      expect(registry.has('exists')).toBe(true);
    });

    it('returns false if tool does not exist', () => {
      expect(registry.has('does-not-exist')).toBe(false);
    });
  });

  describe('getAll()', () => {
    it('returns empty array when no tools registered', () => {
      expect(registry.getAll()).toEqual([]);
    });

    it('returns all registered tools', () => {
      registry.registerMany([createMockTool('a'), createMockTool('b')]);

      const all = registry.getAll();
      expect(all).toHaveLength(2);
      expect(all.map((t) => t.name).sort()).toEqual(['a', 'b']);
    });
  });

  describe('getSchemas()', () => {
    it('returns empty array when no tools registered', () => {
      expect(registry.getSchemas()).toEqual([]);
    });

    it('returns JSON schemas for all tools', () => {
      registry.registerMany([createMockTool('tool-a'), createMockTool('tool-b')]);

      const schemas = registry.getSchemas();
      expect(schemas).toHaveLength(2);

      for (const schema of schemas) {
        expect(schema).toHaveProperty('name');
        expect(schema).toHaveProperty('description');
        expect(schema).toHaveProperty('parameters');
        expect(schema.parameters.type).toBe('object');
      }
    });
  });

  describe('clear()', () => {
    it('removes all registered tools', () => {
      registry.registerMany([createMockTool('x'), createMockTool('y')]);
      expect(registry.getAll()).toHaveLength(2);

      registry.clear();
      expect(registry.getAll()).toHaveLength(0);
    });
  });
});
