import { describe, it, expect } from 'vitest';
import {
  cogitatorToMCP,
  mcpToCogitator,
  zodToJsonSchema,
  jsonSchemaToZod,
} from '@cogitator-ai/mcp';
import type { MCPToolDefinition } from '@cogitator-ai/mcp';
import type { MCPClient } from '@cogitator-ai/mcp';
import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

function createMockClient(handler: (name: string, args: Record<string, unknown>) => unknown) {
  return {
    callTool: async (name: string, args: Record<string, unknown>) => handler(name, args),
  } as unknown as MCPClient;
}

describe('MCP: Tool Adapter', () => {
  const calculatorTool = tool({
    name: 'calculator',
    description: 'Perform basic math operations',
    parameters: z.object({
      operation: z.enum(['add', 'subtract', 'multiply']),
      a: z.number(),
      b: z.number(),
    }),
    execute: async ({ operation, a, b }) => {
      switch (operation) {
        case 'add':
          return { result: a + b };
        case 'subtract':
          return { result: a - b };
        case 'multiply':
          return { result: a * b };
      }
    },
  });

  it('cogitatorToMCP converts tool schema correctly', () => {
    const mcpDef = cogitatorToMCP(calculatorTool);

    expect(mcpDef.name).toBe('calculator');
    expect(mcpDef.description).toBe('Perform basic math operations');
    expect(mcpDef.inputSchema.type).toBe('object');

    const props = mcpDef.inputSchema.properties;
    expect(props).toHaveProperty('operation');
    expect(props).toHaveProperty('a');
    expect(props).toHaveProperty('b');

    const opProp = props.operation as Record<string, unknown>;
    expect(opProp.enum).toEqual(['add', 'subtract', 'multiply']);

    const aProp = props.a as Record<string, unknown>;
    expect(aProp.type).toBe('number');

    expect(mcpDef.inputSchema.required).toContain('operation');
    expect(mcpDef.inputSchema.required).toContain('a');
    expect(mcpDef.inputSchema.required).toContain('b');
  });

  it('mcpToCogitator creates executable Cogitator tool', async () => {
    const mcpDef: MCPToolDefinition = {
      name: 'greet',
      description: 'Greet a person by name',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          excited: { type: 'boolean' },
        },
        required: ['name'],
      },
    };

    const client = createMockClient((_name, args) => {
      const suffix = args.excited ? '!' : '.';
      return `Hello, ${args.name}${suffix}`;
    });

    const converted = mcpToCogitator(mcpDef, client);

    expect(converted.name).toBe('greet');
    expect(converted.description).toBe('Greet a person by name');

    const result = await converted.execute({ name: 'Alice', excited: true } as never, {
      agentId: 'test',
      runId: 'test',
      signal: AbortSignal.timeout(5000),
    });
    expect(result).toBe('Hello, Alice!');
  });

  it('zodToJsonSchema handles complex schemas', () => {
    const schema = z.object({
      title: z.string(),
      count: z.number(),
      active: z.boolean(),
      tags: z.array(z.string()),
      priority: z.enum(['low', 'medium', 'high']),
      metadata: z.object({
        createdBy: z.string(),
        version: z.number(),
      }),
      note: z.string().optional(),
    });

    const jsonSchema = zodToJsonSchema(schema);

    expect(jsonSchema.type).toBe('object');
    expect(jsonSchema.properties).toBeDefined();

    const props = jsonSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.title.type).toBe('string');
    expect(props.count.type).toBe('number');
    expect(props.active.type).toBe('boolean');
    expect(props.tags.type).toBe('array');
    expect((props.tags.items as Record<string, unknown>).type).toBe('string');
    expect(props.priority.enum).toEqual(['low', 'medium', 'high']);

    const metaProps = (props.metadata as Record<string, unknown>).properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(metaProps.createdBy.type).toBe('string');
    expect(metaProps.version.type).toBe('number');

    expect(jsonSchema.required).toContain('title');
    expect(jsonSchema.required).toContain('count');
    expect(jsonSchema.required).toContain('tags');
    expect(jsonSchema.required).not.toContain('note');
  });

  it('round-trip conversion preserves tool identity', async () => {
    const mcpDef = cogitatorToMCP(calculatorTool);

    const client = createMockClient(async (_name, args) => {
      const { operation, a, b } = args as { operation: string; a: number; b: number };
      switch (operation) {
        case 'add':
          return { result: a + b };
        case 'subtract':
          return { result: a - b };
        case 'multiply':
          return { result: a * b };
        default:
          return { result: 0 };
      }
    });

    const roundTripped = mcpToCogitator(mcpDef, client);

    expect(roundTripped.name).toBe(calculatorTool.name);
    expect(roundTripped.description).toBe(calculatorTool.description);

    const schema = roundTripped.toJSON();
    expect(schema.parameters.type).toBe('object');
    expect(Object.keys(schema.parameters.properties)).toEqual(
      expect.arrayContaining(['operation', 'a', 'b'])
    );

    const args = { operation: 'multiply', a: 7, b: 6 };
    const originalResult = await calculatorTool.execute(args as never, {
      agentId: 'test',
      runId: 'test',
      signal: AbortSignal.timeout(5000),
    });
    const roundTrippedResult = await roundTripped.execute(args as never, {
      agentId: 'test',
      runId: 'test',
      signal: AbortSignal.timeout(5000),
    });

    expect(roundTrippedResult).toEqual(originalResult);
    expect(roundTrippedResult).toEqual({ result: 42 });
  });
});
