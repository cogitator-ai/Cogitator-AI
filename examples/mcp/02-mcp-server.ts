import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { MCPServer, MCPClient, MCPToolError } from '@cogitator-ai/mcp';
import { Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const stock: Record<string, number> = { 'SKU-42': 137, 'SKU-7': 12 };

const lookupStock = tool({
  name: 'lookup_stock',
  description: 'Look up how many units of a product SKU are in stock.',
  parameters: z.object({ sku: z.string().describe('Product SKU, e.g. "SKU-42"') }),
  execute: async ({ sku }) => ({ sku, units: stock[sku] ?? 0 }),
});

const reserveUnits = tool({
  name: 'reserve_units',
  description: 'Reserve units of a product. Fails if not enough stock is available.',
  parameters: z.object({ sku: z.string(), units: z.number().int().positive() }),
  execute: async ({ sku, units }) => {
    const available = stock[sku] ?? 0;
    if (units > available) {
      throw new Error(`Only ${available} units of ${sku} available`);
    }
    stock[sku] = available - units;
    return { sku, reserved: units, remaining: stock[sku] };
  },
});

async function main() {
  header('02 — MCP Server: Expose Cogitator Tools over HTTP');

  const server = new MCPServer({
    name: 'inventory',
    version: '1.0.0',
    transport: 'http',
    host: '127.0.0.1',
    port: 0,
  });
  server.registerTools([lookupStock, reserveUnits]);
  server.registerResource({
    uri: 'inventory://sku/{sku}',
    name: 'sku',
    mimeType: 'application/json',
    read: async ({ sku }) => ({
      uri: `inventory://sku/${sku}`,
      text: JSON.stringify({ sku, units: stock[sku] ?? 0 }),
    }),
  });

  let client: MCPClient | undefined;

  try {
    section('1. Start the MCP server');

    await server.start();
    const url = `http://127.0.0.1:${server.getPort()}/mcp`;
    console.log('Listening on', url);

    section('2. Connect an MCP client');

    client = await MCPClient.connect({ transport: 'http', url });
    const definitions = await client.listToolDefinitions();
    for (const def of definitions) {
      console.log(`  ${def.name}(${Object.keys(def.inputSchema.properties ?? {}).join(', ')})`);
    }

    section('3. Call tools and read resources directly');

    console.log('lookup_stock:', await client.callTool('lookup_stock', { sku: 'SKU-42' }));
    console.log('resource:', (await client.readResource('inventory://sku/SKU-7')).text);

    try {
      await client.callTool('reserve_units', { sku: 'SKU-7', units: 999 });
    } catch (error) {
      if (error instanceof MCPToolError) {
        console.log(`reserve_units failed as expected: ${error.message}`);
      } else {
        throw error;
      }
    }

    section('4. Let an agent drive the remote tools');

    const cog = createCogitator();
    const agent = new Agent({
      name: 'inventory-assistant',
      model: DEFAULT_MODEL,
      instructions:
        'You manage inventory. Use the tools to check stock and reserve units. Be concise.',
      tools: await client.getTools(),
      temperature: 0.2,
      maxIterations: 6,
    });

    const result = await cog.run(agent, {
      input: 'How many units of SKU-42 are in stock? Reserve 40 of them and tell me what remains.',
    });

    console.log('Agent output:', result.output);
    console.log('Tool calls:', result.toolCalls.map((tc) => tc.name).join(', '));

    await cog.close();
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await client?.close();
    await server.stop();
    console.log('\nServer stopped.');
  }
}

main();
