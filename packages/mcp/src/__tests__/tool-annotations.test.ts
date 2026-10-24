import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Cogitator, tool, toolOutput } from '@cogitator-ai/core';
import type { Tool } from '@cogitator-ai/types';
import { MCPServer } from '../server/mcp-server';
import { MCPClient, MCPToolError } from '../client/mcp-client';
import { cogitatorToMCP, isDestructiveMCPTool, mcpToCogitator } from '../adapter/tool-adapter';
import type { MCPToolDefinition } from '../types';

const client = { callTool: vi.fn() } as unknown as MCPClient;

function definition(overrides: Partial<MCPToolDefinition> = {}): MCPToolDefinition {
  return {
    name: 'delete_repo',
    description: 'Delete a repository',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' } }, required: ['repo'] },
    ...overrides,
  };
}

describe('mcpToCogitator metadata', () => {
  it('keeps the title, preferring the tool title over the annotation title', () => {
    expect(mcpToCogitator(definition({ title: 'Delete repo' }), client).title).toBe('Delete repo');
    expect(
      mcpToCogitator(definition({ annotations: { title: 'Remove repository' } }), client).title
    ).toBe('Remove repository');
    expect(
      mcpToCogitator(
        definition({ title: 'Delete repo', annotations: { title: 'Remove repository' } }),
        client
      ).title
    ).toBe('Delete repo');
    expect(mcpToCogitator(definition(), client).title).toBeUndefined();
  });

  it('keeps the hints without the title as the tool annotations', () => {
    const imported = mcpToCogitator(
      definition({ annotations: { title: 'Delete', destructiveHint: true, openWorldHint: false } }),
      client
    );
    expect(imported.annotations).toEqual({ destructiveHint: true, openWorldHint: false });
    expect(
      mcpToCogitator(definition({ annotations: { title: 'Delete' } }), client).annotations
    ).toBeUndefined();
  });

  it('turns the output schema into a schema of the result', () => {
    const imported = mcpToCogitator(
      definition({
        outputSchema: {
          type: 'object',
          properties: { deleted: { type: 'boolean' }, at: { type: 'string' } },
          required: ['deleted'],
        },
      }),
      client
    );
    expect(imported.outputSchema?.safeParse({ deleted: true }).success).toBe(true);
    expect(imported.outputSchema?.safeParse({ at: 'now' }).success).toBe(false);
    expect(mcpToCogitator(definition(), client).outputSchema).toBeUndefined();
  });
});

describe('approval of imported MCP tools', () => {
  it('asks approval for tools the server marks destructive', () => {
    expect(
      mcpToCogitator(definition({ annotations: { destructiveHint: true } }), client)
        .requiresApproval
    ).toBe(true);
  });

  it('does not ask for read-only, additive or unmarked tools', () => {
    for (const annotations of [
      undefined,
      { destructiveHint: false },
      { readOnlyHint: true, destructiveHint: true },
      { idempotentHint: true },
    ]) {
      const imported = mcpToCogitator(definition({ annotations }), client);
      expect(imported.requiresApproval).toBeUndefined();
    }
  });

  it('follows the requiresApproval option', () => {
    const destructive = definition({ annotations: { destructiveHint: true } });
    expect(
      mcpToCogitator(destructive, client, { requiresApproval: false }).requiresApproval
    ).toBeUndefined();
    expect(mcpToCogitator(definition(), client, { requiresApproval: true }).requiresApproval).toBe(
      true
    );
    const byName = (def: MCPToolDefinition) => def.name.startsWith('delete_');
    expect(
      mcpToCogitator(definition(), client, { requiresApproval: byName }).requiresApproval
    ).toBe(true);
    expect(
      mcpToCogitator(definition({ name: 'list_repos' }), client, { requiresApproval: byName })
        .requiresApproval
    ).toBeUndefined();
  });

  it('isDestructiveMCPTool reads the hints the way the default does', () => {
    expect(isDestructiveMCPTool(definition({ annotations: { destructiveHint: true } }))).toBe(true);
    expect(
      isDestructiveMCPTool(
        definition({ annotations: { readOnlyHint: true, destructiveHint: true } })
      )
    ).toBe(false);
    expect(isDestructiveMCPTool(definition())).toBe(false);
  });

  it('keeps a destructive tool from running in a runtime until someone approves it', async () => {
    const callTool = vi.fn().mockResolvedValue({ deleted: true });
    const imported = mcpToCogitator(definition({ annotations: { destructiveHint: true } }), {
      callTool,
    } as unknown as MCPClient);
    const cogitator = new Cogitator();
    try {
      const refused = await cogitator.invokeTool(imported, { repo: 'cogitator' });
      expect(refused.pendingApproval?.toolName).toBe('delete_repo');
      expect(callTool).not.toHaveBeenCalled();

      const approved = await cogitator.invokeTool(
        imported,
        { repo: 'cogitator' },
        { onApproval: async () => ({ approved: true }) }
      );
      expect(approved.error).toBeUndefined();
      expect(approved.result).toEqual({ deleted: true });
      expect(callTool).toHaveBeenCalledTimes(1);
    } finally {
      await cogitator.close();
    }
  });
});

describe('cogitatorToMCP metadata', () => {
  it('exports the title, annotations and an object output schema', () => {
    const exported = cogitatorToMCP(
      tool({
        name: 'get_weather',
        title: 'Weather',
        description: 'Weather of a city',
        parameters: z.object({ city: z.string() }),
        outputSchema: z.object({ celsius: z.number() }),
        annotations: { readOnlyHint: true, openWorldHint: true },
        execute: async () => ({ celsius: 21 }),
      })
    );
    expect(exported.title).toBe('Weather');
    expect(exported.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
    expect(exported.outputSchema).toMatchObject({
      type: 'object',
      properties: { celsius: { type: 'number' } },
      required: ['celsius'],
    });
  });

  it('leaves out an output schema whose root is not an object', () => {
    const exported = cogitatorToMCP(
      tool({
        name: 'count',
        description: 'Count things',
        parameters: z.object({}),
        outputSchema: z.number(),
        execute: async () => 3,
      })
    );
    expect(exported.outputSchema).toBeUndefined();
    expect(exported.title).toBeUndefined();
    expect(exported.annotations).toBeUndefined();
  });
});

describe('output schemas MCP cannot carry', () => {
  const scores = tool({
    name: 'scores',
    description: 'Scores by player',
    parameters: z.object({}),
    outputSchema: z.record(z.string(), z.number()),
    execute: async (): Promise<Record<string, number>> => ({ ann: 3 }),
  });

  it('cogitatorToMCP leaves out a record output schema, as MCPServer does', () => {
    expect(cogitatorToMCP(scores).outputSchema).toBeUndefined();
  });

  it('MCPServer says it does not advertise it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const server = new MCPServer({ name: 's', version: '1.0.0', transport: 'stdio' });
      server.registerTool(scores as Tool);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('"scores" is not a z.object() schema')
      );

      warn.mockClear();
      server.registerTool(
        tool({
          name: 'plain',
          description: 'No output schema',
          parameters: z.object({}),
          execute: async () => 1,
        }) as Tool
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('MCPServer tool metadata over HTTP', () => {
  let server: MCPServer;
  let client: MCPClient;
  let url: string;
  const weather = vi.fn(async ({ city }: { city: string }): Promise<unknown> =>
    city === 'Nowhere' ? { celsius: 'cold' } : { celsius: 21, city }
  );

  const tools: Tool[] = [
    tool({
      name: 'get_weather',
      title: 'Weather',
      description: 'Weather of a city',
      parameters: z.object({ city: z.string() }),
      outputSchema: z.object({ celsius: z.number(), city: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      execute: weather,
    }) as Tool,
    tool({
      name: 'drop_table',
      description: 'Drop a table',
      parameters: z.object({ table: z.string() }),
      annotations: { destructiveHint: true },
      execute: async ({ table }) => `dropped ${table}`,
    }) as Tool,
    tool<unknown, unknown>({
      name: 'get_user',
      description: 'Get a user',
      parameters: z.object({}),
      outputSchema: z.object({ id: z.string(), role: z.string().default('member') }),
      execute: async () => ({ id: 'u1', password: 'secret' }),
    }) as Tool,
    tool<unknown, unknown>({
      name: 'to_number',
      description: 'Turn a string into a number',
      parameters: z.object({}),
      outputSchema: z.object({ n: z.string().transform(Number).pipe(z.number()) }),
      execute: async () => ({ n: '5' }),
    }) as Tool,
    tool({
      name: 'edit_notes',
      description: 'Edit the notes',
      parameters: z.object({}),
      outputSchema: z.object({ replacements: z.number() }),
      execute: async () =>
        toolOutput({ content: { replacements: 2 }, details: { diff: 'secret diff' } }),
    }) as Tool,
    tool({
      name: 'count',
      description: 'Count things',
      parameters: z.object({}),
      outputSchema: z.number(),
      execute: async () => 3,
    }) as Tool,
  ];

  beforeAll(async () => {
    server = new MCPServer({
      name: 'meta',
      version: '1.0.0',
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
    });
    server.registerTools(tools);
    await server.start();
    url = `http://127.0.0.1:${server.getPort()}/mcp`;
    client = await MCPClient.connect({ transport: 'http', url });
  });

  afterAll(async () => {
    await client?.close();
    await server?.stop();
  });

  it('advertises the title, annotations and output schema of each tool', async () => {
    const definitions = await client.listToolDefinitions();
    const byName = new Map(definitions.map((def) => [def.name, def]));

    expect(byName.get('get_weather')).toMatchObject({
      title: 'Weather',
      annotations: { readOnlyHint: true, openWorldHint: true },
      outputSchema: {
        type: 'object',
        properties: { celsius: { type: 'number' }, city: { type: 'string' } },
      },
    });
    expect(byName.get('drop_table')?.annotations).toEqual({ destructiveHint: true });
    expect(byName.get('drop_table')?.title).toBeUndefined();
    expect(byName.get('count')?.outputSchema).toBeUndefined();
  });

  it('returns structured content with its JSON as text', async () => {
    const raw = new Client({ name: 'raw', version: '1.0.0' });
    await raw.connect(new StreamableHTTPClientTransport(new URL(url)));
    try {
      const result = await raw.callTool({ name: 'get_weather', arguments: { city: 'Oslo' } });
      expect(result.structuredContent).toEqual({ celsius: 21, city: 'Oslo' });
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify({ celsius: 21, city: 'Oslo' }, null, 2) },
      ]);
    } finally {
      await raw.close();
    }

    await expect(client.callTool('get_weather', { city: 'Oslo' })).resolves.toEqual({
      celsius: 21,
      city: 'Oslo',
    });
  });

  it('checks and sends the content of a toolOutput result, never its details', async () => {
    const raw = new Client({ name: 'raw', version: '1.0.0' });
    await raw.connect(new StreamableHTTPClientTransport(new URL(url)));
    try {
      await raw.listTools();
      const result = await raw.callTool({ name: 'edit_notes', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ replacements: 2 });
      expect(JSON.stringify(result)).not.toContain('secret diff');
    } finally {
      await raw.close();
    }
  });

  it('sends the result as the output schema parses it, so SDK clients accept it', async () => {
    const raw = new Client({ name: 'raw', version: '1.0.0' });
    await raw.connect(new StreamableHTTPClientTransport(new URL(url)));
    try {
      await raw.listTools();
      const result = await raw.callTool({ name: 'get_user', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ id: 'u1', role: 'member' });
      expect(JSON.stringify(result.content)).not.toContain('secret');
    } finally {
      await raw.close();
    }
  });

  it('says so when the output schema cannot take its own output', async () => {
    const error = await client.callTool('to_number', {}).catch((e) => e);
    expect(error).toBeInstanceOf(MCPToolError);
    expect((error as Error).message).toContain('use an output schema without transforms');
  });

  it('reports a result that breaks the output schema as a tool error', async () => {
    const error = await client.callTool('get_weather', { city: 'Nowhere' }).catch((e) => e);
    expect(error).toBeInstanceOf(MCPToolError);
    expect((error as Error).message).toContain("does not match the tool's outputSchema");
  });

  it('round-trips into tools that keep the metadata and ask approval for destructive ones', async () => {
    const imported = new Map((await client.getTools()).map((t) => [t.name, t]));

    expect(imported.get('get_weather')).toMatchObject({
      title: 'Weather',
      annotations: { readOnlyHint: true, openWorldHint: true },
    });
    expect(imported.get('get_weather')?.requiresApproval).toBeUndefined();
    expect(imported.get('get_weather')?.outputSchema?.safeParse({ celsius: 1, city: 'x' })).toEqual(
      expect.objectContaining({ success: true })
    );
    expect(imported.get('drop_table')?.requiresApproval).toBe(true);
  });
});
