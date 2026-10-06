import { describe, it, expect, vi } from 'vitest';
import { toolContent, ToolRegistry } from '@cogitator-ai/core';
import type { ToolContext } from '@cogitator-ai/types';
import {
  jsonSchemaToZod,
  mcpToCogitator,
  normalizeMCPToolName,
  resultToMCPContent,
  mcpContentToResult,
  wrapMCPTools,
  toolSchemaToMCP,
} from '../adapter/tool-adapter';
import type { MCPClient } from '../client/mcp-client';
import type { MCPToolDefinition } from '../types';

const context: ToolContext = {
  agentId: 'agent',
  runId: 'run',
  signal: new AbortController().signal,
};

function clientWith(definitions: MCPToolDefinition[]) {
  const callTool = vi.fn(
    async (_name: string, _args: Record<string, unknown>, _options?: unknown) => 'ok'
  );
  const client = {
    callTool,
    listToolDefinitions: vi.fn(async () => definitions),
  } as unknown as MCPClient;
  return { client, callTool };
}

const PROVIDER_NAME = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;

describe('MCP tool names', () => {
  it('normalizes names providers reject and calls the server by the original name', async () => {
    const longName = `reports.${'quarterly_revenue_breakdown_'.repeat(4)}`;
    const { client, callTool } = clientWith([
      {
        name: 'admin.list_users',
        description: 'List users',
        inputSchema: { type: 'object', properties: {} },
      },
      { name: longName, description: 'Report', inputSchema: { type: 'object', properties: {} } },
    ]);

    const tools = await wrapMCPTools(client);

    expect(tools.map((tool) => tool.name)).toEqual([
      'admin_list_users',
      expect.stringMatching(/^reports_quarterly_revenue_breakdown_.*_[0-9a-f]{8}$/),
    ]);
    for (const tool of tools) {
      expect(tool.name).toMatch(PROVIDER_NAME);
      expect(tool.toJSON().name).toBe(tool.name);
    }

    await tools[0].execute({}, context);
    expect(callTool).toHaveBeenCalledWith('admin.list_users', {}, expect.anything());
  });

  it('keeps names that only differ before normalization apart', async () => {
    const { client } = clientWith([
      { name: 'files.read', description: 'a', inputSchema: { type: 'object', properties: {} } },
      { name: 'files_read', description: 'b', inputSchema: { type: 'object', properties: {} } },
    ]);

    const names = (await wrapMCPTools(client)).map((tool) => tool.name);

    expect(names[1]).toBe('files_read');
    expect(names[0]).toMatch(/^files_read_[0-9a-f]{8}$/);
  });

  it('normalizes deterministically and keeps valid names', () => {
    expect(normalizeMCPToolName('search')).toBe('search');
    expect(normalizeMCPToolName('9lives')).toBe('_9lives');
    expect(normalizeMCPToolName('a'.repeat(80))).toBe(normalizeMCPToolName('a'.repeat(80)));
    expect(normalizeMCPToolName('a'.repeat(80))).not.toBe(normalizeMCPToolName('a'.repeat(81)));
    expect(normalizeMCPToolName('a'.repeat(80))).toHaveLength(64);
  });

  it('applies the prefix before normalizing', () => {
    const { client } = clientWith([]);
    const tool = mcpToCogitator(
      { name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {} } },
      client,
      { namePrefix: 'mcp.github.' }
    );
    expect(tool.name).toBe('mcp_github_search');
  });
});

describe('MCP tool annotations', () => {
  it('lets only read-only or idempotent tools be retried', async () => {
    const { client, callTool } = clientWith([
      {
        name: 'read_file',
        description: 'Read',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      },
      {
        name: 'set_flag',
        description: 'Set',
        inputSchema: { type: 'object', properties: {} },
        annotations: { idempotentHint: true },
      },
      {
        name: 'deploy_service',
        description: 'Deploy',
        inputSchema: { type: 'object', properties: {} },
        annotations: { destructiveHint: true },
      },
    ]);

    for (const tool of await wrapMCPTools(client)) await tool.execute({}, context);

    expect(callTool.mock.calls.map((call) => [call[0], call[2]])).toEqual([
      ['read_file', { signal: context.signal, idempotent: true }],
      ['set_flag', { signal: context.signal, idempotent: true }],
      ['deploy_service', { signal: context.signal, idempotent: false }],
    ]);
  });
});

describe('MCP schemas with $ref', () => {
  const orderTool: MCPToolDefinition = {
    name: 'create_order',
    description: 'Create an order',
    inputSchema: {
      type: 'object',
      properties: {
        order: { $ref: '#/$defs/Order' },
        category: { $ref: '#/definitions/Category' },
      },
      required: ['order'],
      $defs: {
        Order: {
          type: 'object',
          properties: { id: { type: 'integer' }, sku: { type: 'string' } },
          required: ['id', 'sku'],
        },
      },
      definitions: {
        Category: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            parent: { anyOf: [{ $ref: '#/definitions/Category' }, { type: 'null' }] },
          },
          required: ['name'],
        },
      },
    },
  };

  it('validates arguments against the definitions refs point to, recursive ones included', () => {
    const { client } = clientWith([]);
    const tool = mcpToCogitator(orderTool, client);

    expect(tool.parameters.safeParse({ order: { id: 1, sku: 'A-1' } }).success).toBe(true);
    expect(tool.parameters.safeParse({ order: {} }).success).toBe(false);
    expect(
      tool.parameters.safeParse({
        order: { id: 1, sku: 'A-1' },
        category: { name: 'lamps', parent: { name: 'home', parent: null } },
      }).success
    ).toBe(true);
    expect(
      tool.parameters.safeParse({
        order: { id: 1, sku: 'A-1' },
        category: { name: 'lamps', parent: { name: 7 } },
      }).success
    ).toBe(false);
  });

  it('shows the model the definitions instead of an empty schema', () => {
    const { client } = clientWith([]);
    const registry = new ToolRegistry();
    registry.register(mcpToCogitator(orderTool, client));

    const [schema] = registry.getSchemas();

    expect(schema.parameters.properties.order).toEqual({
      type: 'object',
      properties: { id: { type: 'integer' }, sku: { type: 'string' } },
      required: ['id', 'sku'],
    });
    expect(schema.parameters.properties.category).toEqual({ $ref: '#/$defs/Category' });
    expect(schema.parameters.$defs?.Category).toBeDefined();
  });

  it('advertises Cogitator tool schemas with their definitions', () => {
    const definition = toolSchemaToMCP({
      name: 'tree',
      description: 'Tree',
      parameters: {
        type: 'object',
        properties: { root: { $ref: '#/$defs/Node' } },
        $defs: {
          Node: {
            type: 'object',
            properties: { children: { type: 'array', items: { $ref: '#/$defs/Node' } } },
          },
        },
      },
    });

    expect(definition.inputSchema.$defs).toBeDefined();
    expect(
      jsonSchemaToZod(definition.inputSchema as Parameters<typeof jsonSchemaToZod>[0]).safeParse({
        root: { children: [{ children: [] }] },
      }).success
    ).toBe(true);
  });
});

describe('MCP media content', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUg==';

  it('turns images and audio from a server into media parts', () => {
    expect(
      mcpContentToResult([
        { type: 'text', text: 'Page screenshot' },
        { type: 'image', data: PNG, mimeType: 'image/png' },
        { type: 'audio', data: 'SUQz', mimeType: 'audio/mpeg' },
      ])
    ).toEqual(
      toolContent(
        { type: 'text', text: 'Page screenshot' },
        { type: 'image', data: PNG, mediaType: 'image/png' },
        { type: 'file', data: 'SUQz', mediaType: 'audio/mpeg' }
      )
    );
  });

  it('serves media results as image, audio and resource blocks', () => {
    expect(
      resultToMCPContent(
        toolContent(
          { type: 'text', text: 'Here it is' },
          { type: 'image', data: PNG, mediaType: 'image/png' },
          { type: 'file', data: 'SUQz', mediaType: 'audio/mpeg' },
          { type: 'file', data: 'JVBERi0=', mediaType: 'application/pdf', filename: 'report.pdf' }
        )
      )
    ).toEqual([
      { type: 'text', text: 'Here it is' },
      { type: 'image', data: PNG, mimeType: 'image/png' },
      { type: 'audio', data: 'SUQz', mimeType: 'audio/mpeg' },
      {
        type: 'resource',
        resource: {
          uri: 'attachment:///report.pdf',
          mimeType: 'application/pdf',
          blob: 'JVBERi0=',
        },
      },
    ]);
  });

  it('serves a screenshot object as an image block', () => {
    expect(resultToMCPContent({ image: PNG, width: 800 })).toEqual([
      { type: 'text', text: '{"width":800,"image":"(image attached)"}' },
      { type: 'image', data: PNG, mimeType: 'image/png' },
    ]);
  });
});
