/**
 * Tests for MCP Tool Adapter
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  zodToJsonSchema,
  jsonSchemaToZod,
  cogitatorToMCP,
  mcpToCogitator,
  resultToMCPContent,
  mcpContentToResult,
} from '../adapter/tool-adapter.js';
import type { Tool, ToolContext, ToolSchema } from '@cogitator/types';
import type { MCPClient } from '../client/mcp-client.js';

describe('zodToJsonSchema', () => {
  it('should convert simple string schema', () => {
    const schema = z.object({
      name: z.string(),
    });

    const result = zodToJsonSchema(schema);

    expect(result.type).toBe('object');
    expect(result.properties).toBeDefined();
    expect(result.properties!.name).toBeDefined();
  });

  it('should convert complex schema with required fields', () => {
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
      number: z.number(),
      boolean: z.boolean(),
    });

    const result = zodToJsonSchema(schema);

    expect(result.type).toBe('object');
    expect(result.required).toContain('required');
    expect(result.required).toContain('number');
    expect(result.required).toContain('boolean');
    expect(result.required).not.toContain('optional');
  });

  it('should convert nested objects', () => {
    const schema = z.object({
      nested: z.object({
        value: z.string(),
      }),
    });

    const result = zodToJsonSchema(schema);

    expect(result.properties!.nested).toBeDefined();
  });

  it('should convert arrays', () => {
    const schema = z.object({
      items: z.array(z.string()),
    });

    const result = zodToJsonSchema(schema);

    expect(result.properties!.items).toBeDefined();
  });

  it('should convert enums', () => {
    const schema = z.object({
      status: z.enum(['active', 'inactive']),
    });

    const result = zodToJsonSchema(schema);

    expect(result.properties!.status).toBeDefined();
  });
});

describe('jsonSchemaToZod', () => {
  it('should convert simple JSON Schema', () => {
    const jsonSchema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name'],
    };

    const zodSchema = jsonSchemaToZod(jsonSchema);

    const validResult = zodSchema.safeParse({ name: 'John', age: 30 });
    expect(validResult.success).toBe(true);

    const validWithoutAge = zodSchema.safeParse({ name: 'John' });
    expect(validWithoutAge.success).toBe(true);
  });

  it('should handle string constraints', () => {
    const jsonSchema = {
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email' },
        url: { type: 'string', format: 'uri' },
        limited: { type: 'string', minLength: 3, maxLength: 10 },
      },
    };

    const zodSchema = jsonSchemaToZod(jsonSchema);

    const validEmail = zodSchema.safeParse({ email: 'test@example.com' });
    expect(validEmail.success).toBe(true);

    const invalidEmail = zodSchema.safeParse({ email: 'not-an-email' });
    expect(invalidEmail.success).toBe(false);
  });

  it('should handle number constraints', () => {
    const jsonSchema = {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 0, maximum: 100 },
      },
    };

    const zodSchema = jsonSchemaToZod(jsonSchema);

    const valid = zodSchema.safeParse({ count: 50 });
    expect(valid.success).toBe(true);

    const tooLow = zodSchema.safeParse({ count: -1 });
    expect(tooLow.success).toBe(false);

    const tooHigh = zodSchema.safeParse({ count: 101 });
    expect(tooHigh.success).toBe(false);
  });

  it('should handle enums', () => {
    const jsonSchema = {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'inactive', 'pending'] },
      },
    };

    const zodSchema = jsonSchemaToZod(jsonSchema);

    const valid = zodSchema.safeParse({ status: 'active' });
    expect(valid.success).toBe(true);

    const invalid = zodSchema.safeParse({ status: 'unknown' });
    expect(invalid.success).toBe(false);
  });

  it('should handle arrays', () => {
    const jsonSchema = {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    };

    const zodSchema = jsonSchemaToZod(jsonSchema);

    const valid = zodSchema.safeParse({ tags: ['a', 'b', 'c'] });
    expect(valid.success).toBe(true);
  });

  it('should handle nested objects', () => {
    const jsonSchema = {
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: {
            street: { type: 'string' },
            city: { type: 'string' },
          },
          required: ['city'],
        },
      },
    };

    const zodSchema = jsonSchemaToZod(jsonSchema);

    const valid = zodSchema.safeParse({
      address: { street: '123 Main St', city: 'NYC' },
    });
    expect(valid.success).toBe(true);
  });
});

describe('cogitatorToMCP', () => {
  it('should convert Cogitator tool to MCP format', () => {
    const tool: Tool = {
      name: 'test_tool',
      description: 'A test tool',
      parameters: z.object({
        input: z.string(),
      }),
      execute: vi.fn(),
      toJSON: () => ({
        name: 'test_tool',
        description: 'A test tool',
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string' },
          },
          required: ['input'],
        },
      }),
    };

    const mcpTool = cogitatorToMCP(tool);

    expect(mcpTool.name).toBe('test_tool');
    expect(mcpTool.description).toBe('A test tool');
    expect(mcpTool.inputSchema.type).toBe('object');
    expect(mcpTool.inputSchema.properties).toBeDefined();
  });
});

describe('mcpToCogitator', () => {
  it('should convert MCP tool to Cogitator format', async () => {
    const mcpTool = {
      name: 'get_weather',
      description: 'Get weather for a city',
      inputSchema: {
        type: 'object' as const,
        properties: {
          city: { type: 'string', description: 'City name' },
        },
        required: ['city'],
      },
    };

    const mockClient = {
      callTool: vi.fn().mockResolvedValue({ temperature: 25 }),
    } as unknown as MCPClient;

    const tool = mcpToCogitator(mcpTool, mockClient);

    expect(tool.name).toBe('get_weather');
    expect(tool.description).toBe('Get weather for a city');

    const context: ToolContext = {
      agentId: 'test',
      runId: 'run_1',
      signal: new AbortController().signal,
    };

    const result = await tool.execute({ city: 'Tokyo' }, context);

    expect(mockClient.callTool).toHaveBeenCalledWith('get_weather', { city: 'Tokyo' });
    expect(result).toEqual({ temperature: 25 });
  });

  it('should apply name prefix when provided', () => {
    const mcpTool = {
      name: 'tool',
      description: 'A tool',
      inputSchema: { type: 'object' as const, properties: {} },
    };

    const mockClient = { callTool: vi.fn() } as unknown as MCPClient;

    const tool = mcpToCogitator(mcpTool, mockClient, { namePrefix: 'mcp_' });

    expect(tool.name).toBe('mcp_tool');
  });

  it('should apply description transform when provided', () => {
    const mcpTool = {
      name: 'tool',
      description: 'original',
      inputSchema: { type: 'object' as const, properties: {} },
    };

    const mockClient = { callTool: vi.fn() } as unknown as MCPClient;

    const tool = mcpToCogitator(mcpTool, mockClient, {
      descriptionTransform: (d) => `[MCP] ${d}`,
    });

    expect(tool.description).toBe('[MCP] original');
  });
});

describe('resultToMCPContent', () => {
  it('should convert string to text content', () => {
    const result = resultToMCPContent('Hello');

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'text', text: 'Hello' });
  });

  it('should convert object to JSON text content', () => {
    const result = resultToMCPContent({ key: 'value' });

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('text');
    expect(JSON.parse((result[0] as { text: string }).text)).toEqual({ key: 'value' });
  });

  it('should convert null to empty text', () => {
    const result = resultToMCPContent(null);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'text', text: '' });
  });

  it('should pass through MCP content arrays', () => {
    const content = [{ type: 'text' as const, text: 'test' }];
    const result = resultToMCPContent(content);

    expect(result).toEqual(content);
  });

  it('should convert primitives to string', () => {
    const numResult = resultToMCPContent(42);
    expect(numResult[0]).toEqual({ type: 'text', text: '42' });

    const boolResult = resultToMCPContent(true);
    expect(boolResult[0]).toEqual({ type: 'text', text: 'true' });
  });
});

describe('mcpContentToResult', () => {
  it('should parse JSON from text content', () => {
    const content = [{ type: 'text' as const, text: '{"key": "value"}' }];
    const result = mcpContentToResult(content);

    expect(result).toEqual({ key: 'value' });
  });

  it('should return plain text if not JSON', () => {
    const content = [{ type: 'text' as const, text: 'Hello world' }];
    const result = mcpContentToResult(content);

    expect(result).toBe('Hello world');
  });

  it('should return null for empty content', () => {
    expect(mcpContentToResult([])).toBeNull();
  });

  it('should handle multiple content items', () => {
    const content = [
      { type: 'text' as const, text: '{"a": 1}' },
      { type: 'text' as const, text: 'plain text' },
    ];
    const result = mcpContentToResult(content);

    expect(result).toEqual([{ a: 1 }, 'plain text']);
  });
});

