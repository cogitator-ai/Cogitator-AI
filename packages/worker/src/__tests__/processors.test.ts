import { describe, it, expect, vi } from 'vitest';
import type { ToolSchema } from '@cogitator-ai/types';

vi.mock('@cogitator-ai/core', () => ({
  Cogitator: vi.fn(),
  Agent: vi.fn(),
  tool: vi.fn((config) => ({
    name: config.name,
    description: config.description,
    execute: config.execute,
  })),
}));

describe('processors/shared', () => {
  describe('jsonSchemaToZod', () => {
    it('returns empty object schema for empty properties', async () => {
      const { jsonSchemaToZod } = await import('../processors/shared');
      const schema = jsonSchemaToZod({
        type: 'object',
        properties: {},
      });

      const result = schema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('creates schema with required and optional fields', async () => {
      const { jsonSchemaToZod } = await import('../processors/shared');
      const schema = jsonSchemaToZod({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
          optional: { type: 'string' },
        },
        required: ['name', 'age'],
      });

      const valid = schema.safeParse({ name: 'test', age: 25 });
      expect(valid.success).toBe(true);

      const withOptional = schema.safeParse({ name: 'test', age: 25, optional: 'yes' });
      expect(withOptional.success).toBe(true);
    });

    it('allows passthrough of extra fields', async () => {
      const { jsonSchemaToZod } = await import('../processors/shared');
      const schema = jsonSchemaToZod({
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
      });

      const result = schema.safeParse({ name: 'test', extraField: true });
      expect(result.success).toBe(true);
    });
  });

  describe('recreateTools', () => {
    it('creates tool stubs from schemas', async () => {
      const { recreateTools } = await import('../processors/shared');

      const schemas: ToolSchema[] = [
        {
          name: 'search',
          description: 'Search for stuff',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ];

      const tools = recreateTools(schemas);
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('search');
    });

    it('creates empty array for no schemas', async () => {
      const { recreateTools } = await import('../processors/shared');
      const tools = recreateTools([]);
      expect(tools).toEqual([]);
    });
  });
});

describe('processors/workflow', () => {
  it('throws error indicating not implemented', async () => {
    const { processWorkflowJob } = await import('../processors/workflow');

    await expect(
      processWorkflowJob({
        type: 'workflow',
        jobId: 'job_1',
        workflowConfig: { id: 'wf-1', name: 'test', nodes: [], edges: [] },
        input: {},
        runId: 'run_1',
      })
    ).rejects.toThrow('Workflow job processing is not yet implemented');
  });
});
