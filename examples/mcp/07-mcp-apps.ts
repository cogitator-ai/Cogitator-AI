import { header, section } from '../_shared/setup.js';
import { MCPClient, MCPServer, MCP_APP_MIME_TYPE, mcpApp } from '@cogitator-ai/mcp';
import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

const stock: Record<string, number> = { 'SKU-42': 137, 'SKU-7': 12 };

/**
 * The page of the app: it speaks JSON-RPC over postMessage with its host (no SDK needed), shows
 * the stock the tool call returned and reserves a unit through the host when its button is pressed
 */
const STOCK_PAGE = `<!doctype html>
<html>
  <body style="font-family: system-ui; margin: 12px">
    <h3 id="sku">Waiting for the call</h3>
    <p id="units"></p>
    <button id="reserve">Reserve one</button>
    <script>
      let next = 0;
      const pending = new Map();
      const request = (method, params) =>
        new Promise((resolve) => {
          const id = ++next;
          pending.set(id, resolve);
          window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
        });
      const show = (result) => {
        const stock = result.structuredContent ?? JSON.parse(result.content[0].text);
        document.getElementById('sku').textContent = stock.sku;
        document.getElementById('units').textContent = stock.units + ' units in stock';
      };
      window.addEventListener('message', ({ data }) => {
        if (data?.jsonrpc !== '2.0') return;
        if (data.id !== undefined && !data.method && pending.has(data.id)) {
          pending.get(data.id)(data.result);
          pending.delete(data.id);
        } else if (data.method === 'ui/notifications/tool-result') {
          show(data.params);
        }
      });
      document.getElementById('reserve').addEventListener('click', async () => {
        const sku = document.getElementById('sku').textContent;
        show(await request('tools/call', { name: 'reserve_unit', arguments: { sku } }));
      });
      request('ui/initialize', {
        appInfo: { name: 'stock', version: '1.0.0' },
        appCapabilities: {},
        protocolVersion: '2026-01-26',
      }).then(() =>
        window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }, '*')
      );
    </script>
  </body>
</html>`;

const stockApp = mcpApp({
  uri: 'ui://inventory/stock',
  name: 'Stock card',
  html: STOCK_PAGE,
  prefersBorder: true,
});

const lookupStock = tool({
  name: 'lookup_stock',
  description: 'Look up how many units of a product SKU are in stock, shown as a card.',
  parameters: z.object({ sku: z.string() }),
  outputSchema: z.object({ sku: z.string(), units: z.number() }),
  annotations: { readOnlyHint: true },
  app: stockApp,
  execute: async ({ sku }) => ({ sku, units: stock[sku] ?? 0 }),
});

const reserveUnit = tool({
  name: 'reserve_unit',
  description: 'Reserve one unit of a product, from the stock card.',
  parameters: z.object({ sku: z.string() }),
  outputSchema: z.object({ sku: z.string(), units: z.number() }),
  app: mcpApp({ uri: 'ui://inventory/stock', html: STOCK_PAGE, visibility: ['app'] }),
  execute: async ({ sku }) => {
    stock[sku] = Math.max(0, (stock[sku] ?? 0) - 1);
    return { sku, units: stock[sku] };
  },
});

header('MCP Apps: a tool with an interactive page');

const server = new MCPServer({
  name: 'inventory',
  version: '1.0.0',
  transport: 'http',
  host: '127.0.0.1',
  port: 0,
});
server.registerTools([lookupStock, reserveUnit]);
await server.start();
const url = `http://127.0.0.1:${server.getPort()}/mcp`;
console.log(`MCP server with apps on ${url}`);
console.log('Apps served:', server.getRegisteredApps());

const client = await MCPClient.connect({ transport: 'http', url });

section('What a host sees');
const apps = (await client.listResources()).filter(
  (resource) => resource.mimeType === MCP_APP_MIME_TYPE
);
console.log(
  'App resources:',
  apps.map((resource) => resource.uri)
);
const tools = await client.getTools();
console.log(
  'Tools for the agent:',
  tools.map((entry) => `${entry.name}${entry.app ? ` (app ${entry.app.resourceUri})` : ''}`)
);

const lookup = tools.find((entry) => entry.name === 'lookup_stock');
const page = await lookup?.app?.read();
console.log(`The page: ${page?.mimeType}, ${page?.html.length} characters`);

section('What the page does through its host');
console.log(
  'The call:',
  await lookup?.execute(
    { sku: 'SKU-42' },
    { agentId: 'demo', runId: 'demo', signal: new AbortController().signal }
  )
);
const reserved = await lookup?.app?.callTool?.('reserve_unit', { sku: 'SKU-42' });
console.log('The page reserved one:', reserved?.structuredContent);
await lookup?.app
  ?.callTool?.('lookup_stock_v2', { sku: 'SKU-42' })
  .catch((error: unknown) => console.log('A tool the server does not have:', String(error)));

section('See it rendered');
console.log(
  'Give an agent these tools in your project and run `cogitator dev`: Cogitator Studio shows the stock card under each lookup_stock call, and its button reserves a unit.'
);

await client.close();
await server.stop();
