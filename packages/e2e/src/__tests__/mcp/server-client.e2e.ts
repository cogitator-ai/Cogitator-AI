import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Cogitator, tool } from '@cogitator-ai/core';
import { MCPClient, MCPServer, MCPToolError, connectMCPServer } from '@cogitator-ai/mcp';
import type { Tool } from '@cogitator-ai/types';
import { createTestCogitator, createTestAgent, isOllamaRunning } from '../../helpers/setup';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;
const describeHeavy = process.env.OLLAMA_API_KEY ? describe : describe.skip;

const HEAVY_MODEL = 'gpt-oss:20b';
const OLLAMA_CLOUD_URL = process.env.OLLAMA_URL || 'https://ollama.com';

const STDIO_FIXTURE = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url));

function createInventoryTools() {
  const calls: Array<{ tool: string; args: unknown }> = [];

  const lookupStock = tool({
    name: 'lookup_stock',
    description: 'Look up how many units of a product SKU are in stock.',
    parameters: z.object({
      sku: z.string().describe('Product SKU, e.g. "SKU-42"'),
    }),
    execute: async ({ sku }) => {
      calls.push({ tool: 'lookup_stock', args: { sku } });
      return { sku, units: sku === 'SKU-42' ? 137 : 0 };
    },
  });

  const reserve = tool({
    name: 'reserve_units',
    description: 'Reserve units of a product.',
    parameters: z.object({
      sku: z.string(),
      units: z.number().int().positive(),
    }),
    execute: async ({ sku, units }) => {
      calls.push({ tool: 'reserve_units', args: { sku, units } });
      if (units > 137) {
        throw new Error(`Only 137 units of ${sku} available`);
      }
      return { reserved: units };
    },
  });

  return { tools: [lookupStock, reserve] as Tool[], calls };
}

async function startHttpServer(tools: Tool[]): Promise<{ server: MCPServer; url: string }> {
  const server = new MCPServer({
    name: 'e2e-inventory',
    version: '1.0.0',
    transport: 'http',
    host: '127.0.0.1',
    port: 0,
  });
  server.registerTools(tools);
  server.registerResource({
    uri: 'inventory://warehouses/{region}',
    name: 'warehouse',
    mimeType: 'application/json',
    read: async ({ region }) => ({
      uri: `inventory://warehouses/${region}`,
      text: JSON.stringify({ region, warehouses: region === 'eu' ? 3 : 1 }),
    }),
  });
  server.registerPrompt({
    name: 'restock_plan',
    description: 'Plan a restock for a SKU',
    arguments: [{ name: 'sku', required: true }],
    get: async ({ sku }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `Plan a restock for ${sku}.` } }],
    }),
  });
  await server.start();
  return { server, url: `http://127.0.0.1:${server.getPort()}/mcp` };
}

describe('MCP: Server <-> Client over HTTP', () => {
  let server: MCPServer;
  let client: MCPClient;
  const inventory = createInventoryTools();

  beforeAll(async () => {
    const started = await startHttpServer(inventory.tools);
    server = started.server;
    client = await MCPClient.connect({
      transport: 'http',
      url: started.url,
      retry: { maxRetries: 2, initialDelay: 50 },
    });
  });

  afterAll(async () => {
    await client?.close();
    await server?.stop();
  });

  it('advertises Cogitator tool schemas to MCP clients', async () => {
    const definitions = await client.listToolDefinitions();
    const reserve = definitions.find((d) => d.name === 'reserve_units');

    expect(definitions.map((d) => d.name).sort()).toEqual(['lookup_stock', 'reserve_units']);
    expect(reserve?.inputSchema.properties).toHaveProperty('sku');
    expect(reserve?.inputSchema.properties).toHaveProperty('units');
    expect(reserve?.inputSchema.required).toEqual(expect.arrayContaining(['sku', 'units']));
  });

  it('executes remote tools through the wrapped Cogitator tool', async () => {
    const tools = await client.getTools();
    const lookup = tools.find((t) => t.name === 'lookup_stock');

    const result = await lookup!.execute(
      { sku: 'SKU-42' },
      { agentId: 'e2e', runId: 'run', signal: new AbortController().signal }
    );

    expect(result).toEqual({ sku: 'SKU-42', units: 137 });
  });

  it('rejects arguments that violate the tool schema before execution', async () => {
    const before = inventory.calls.length;

    await expect(client.callTool('reserve_units', { sku: 'SKU-42', units: -1 })).rejects.toThrow(
      MCPToolError
    );
    expect(inventory.calls.length).toBe(before);
  });

  it('propagates tool failures as MCPToolError without re-executing', async () => {
    const before = inventory.calls.length;

    const error = await client
      .callTool('reserve_units', { sku: 'SKU-42', units: 500 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MCPToolError);
    expect((error as Error).message).toContain('Only 137 units');
    expect(inventory.calls.length).toBe(before + 1);
  });

  it('reads templated resources', async () => {
    const content = await client.readResource('inventory://warehouses/eu');
    expect(JSON.parse(content.text ?? '{}')).toEqual({ region: 'eu', warehouses: 3 });
  });

  it('renders prompts with arguments', async () => {
    const messages = await client.getPrompt('restock_plan', { sku: 'SKU-7' });
    expect(messages[0].content.text).toBe('Plan a restock for SKU-7.');
  });

  it('serves concurrent clients independently', async () => {
    const extra = await Promise.all(
      Array.from({ length: 3 }, () =>
        MCPClient.connect({ transport: 'http', url: `http://127.0.0.1:${server.getPort()}/mcp` })
      )
    );
    try {
      const results = await Promise.all(
        extra.map((c, i) => c.callTool('lookup_stock', { sku: i === 0 ? 'SKU-42' : `SKU-${i}` }))
      );
      expect(results).toEqual([
        { sku: 'SKU-42', units: 137 },
        { sku: 'SKU-1', units: 0 },
        { sku: 'SKU-2', units: 0 },
      ]);
    } finally {
      await Promise.all(extra.map((c) => c.close()));
    }
  });
});

describe('MCP: stdio transport', () => {
  it('spawns a stdio server with logging enabled and calls its tools', async () => {
    const { client, tools, cleanup } = await connectMCPServer({
      transport: 'stdio',
      command: process.execPath,
      args: [STDIO_FIXTURE],
      cwd: fileURLToPath(new URL('../../..', import.meta.url)),
      timeout: 30_000,
    });

    try {
      expect(tools.map((t) => t.name).sort()).toEqual(['add', 'fail']);
      expect(await client.callTool('add', { a: 19, b: 23 })).toEqual({ sum: 42 });
      await expect(client.callTool('fail', { reason: 'nope' })).rejects.toThrow('nope');
    } finally {
      await cleanup();
    }
    expect(client.isConnected()).toBe(false);
  });
});

async function runUntilToolCalled(
  cogitator: Cogitator,
  agent: ReturnType<typeof createTestAgent>,
  input: string,
  calls: Array<{ tool: string }>,
  maxAttempts = 4
) {
  let result = await cogitator.run(agent, { input });
  for (let i = 1; i < maxAttempts && calls.length === 0; i++) {
    result = await cogitator.run(agent, { input });
  }
  return result;
}

describeE2E('MCP: Agent using MCP tools (Ollama)', () => {
  let cogitator: Cogitator;
  let server: MCPServer;
  let client: MCPClient;
  const inventory = createInventoryTools();

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
    const started = await startHttpServer(inventory.tools);
    server = started.server;
    client = await MCPClient.connect({ transport: 'http', url: started.url });
  });

  afterAll(async () => {
    await client?.close();
    await server?.stop();
    await cogitator?.close();
  });

  it('runs an agent whose tools live on an MCP server', async () => {
    const tools = await client.getTools();
    const agent = createTestAgent({
      instructions:
        'You are an inventory assistant. You MUST call the lookup_stock tool to answer stock questions.',
      tools: tools.filter((t) => t.name === 'lookup_stock'),
      maxIterations: 4,
    });

    const result = await runUntilToolCalled(
      cogitator,
      agent,
      'How many units of SKU-42 are in stock? Call lookup_stock with sku "SKU-42".',
      inventory.calls
    );

    expect(typeof result.output).toBe('string');
    expect(inventory.calls.length).toBeGreaterThan(0);
    for (const call of result.toolCalls) {
      expect(call.name).toBe('lookup_stock');
    }
  });
});

describeHeavy('MCP: Agent using MCP tools (heavy model)', () => {
  let cogitator: Cogitator;
  let server: MCPServer;
  let client: MCPClient;
  const inventory = createInventoryTools();

  beforeAll(async () => {
    cogitator = new Cogitator({
      llm: {
        defaultModel: `ollama/${HEAVY_MODEL}`,
        providers: {
          ollama: { baseUrl: OLLAMA_CLOUD_URL, apiKey: process.env.OLLAMA_API_KEY },
        },
      },
    });
    const started = await startHttpServer(inventory.tools);
    server = started.server;
    client = await MCPClient.connect({ transport: 'http', url: started.url });
  });

  afterAll(async () => {
    await client?.close();
    await server?.stop();
    await cogitator?.close();
  });

  it('uses the remote tool result in its answer', async () => {
    const tools = await client.getTools();
    const agent = createTestAgent({
      instructions:
        'You are an inventory assistant. Always use the lookup_stock tool and report the exact unit count.',
      tools,
      model: `ollama/${HEAVY_MODEL}`,
      maxIterations: 5,
    });

    const result = await runUntilToolCalled(
      cogitator,
      agent,
      'How many units of SKU-42 do we have in stock?',
      inventory.calls
    );

    expect(inventory.calls.some((c) => c.tool === 'lookup_stock')).toBe(true);
    expect(result.output).toContain('137');
  });

  it('recovers when a remote tool reports an error', async () => {
    const tools = await client.getTools();
    const agent = createTestAgent({
      instructions:
        'You are an inventory assistant. Use reserve_units to reserve stock. If reservation fails, explain why to the user.',
      tools,
      model: `ollama/${HEAVY_MODEL}`,
      maxIterations: 5,
    });

    const before = inventory.calls.length;
    const result = await cogitator.run(agent, {
      input: 'Reserve 500 units of SKU-42.',
    });

    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);
    if (inventory.calls.length > before) {
      const reserveCall = result.toolCalls.find((c) => c.name === 'reserve_units');
      expect(reserveCall).toBeDefined();
    }
  });
});
