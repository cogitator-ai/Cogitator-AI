import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  RESOURCE_MIME_TYPE,
  getToolUiResourceUri,
  isToolVisibilityAppOnly,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import { Cogitator, tool, toolContent, toolOutput } from '@cogitator-ai/core';
import type { Tool } from '@cogitator-ai/types';
import { MCPServer } from '../server/mcp-server';
import { MCPClient, appStructuredContent } from '../client/mcp-client';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APPS_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'apps-server.mjs');
import {
  MCP_APPS_EXTENSION,
  MCP_APP_MIME_TYPE,
  appMetaOf,
  isToolVisibleTo,
  mcpApp,
  toolAppMeta,
  toolAppRefOf,
  toolVisibilityOf,
} from '../apps';

const CHART_HTML = '<!doctype html><html><body><div id="chart"></div></body></html>';
const CART_HTML = '<!doctype html><html><body>cart</body></html>';

describe('app metadata', () => {
  it('reads the app of a tool from _meta.ui and the older flat key', () => {
    expect(toolAppRefOf({ ui: { resourceUri: 'ui://a/view', visibility: ['app'] } })).toEqual({
      resourceUri: 'ui://a/view',
      visibility: ['app'],
    });
    expect(toolAppRefOf({ 'ui/resourceUri': 'ui://a/old' })).toEqual({ resourceUri: 'ui://a/old' });
    expect(toolAppRefOf({ ui: { resourceUri: 'https://a/view' } })).toBeUndefined();
    expect(toolAppRefOf(undefined)).toBeUndefined();
  });

  it('writes the metadata the ext-apps host helpers read', () => {
    const meta = toolAppMeta({ resourceUri: 'ui://a/view', visibility: ['app'] });
    expect(getToolUiResourceUri({ _meta: meta })).toBe('ui://a/view');
    expect(isToolVisibilityAppOnly({ _meta: meta })).toBe(true);
    expect(MCP_APP_MIME_TYPE).toBe(RESOURCE_MIME_TYPE);
    expect(() => toolAppMeta({ resourceUri: 'https://a/view' })).toThrow('ui://');
  });

  it('keeps the CSP and permissions it understands, and drops the rest', () => {
    expect(
      appMetaOf({
        ui: {
          csp: { connectDomains: ['https://api.example.com', 3], frameDomains: 'nope' },
          permissions: { camera: {}, teleport: {} },
          prefersBorder: false,
          domain: 'app.example.com',
        },
      })
    ).toEqual({
      csp: { connectDomains: ['https://api.example.com'] },
      permissions: { camera: {} },
      prefersBorder: false,
      domain: 'app.example.com',
    });
    expect(appMetaOf({})).toEqual({});
  });

  it('opens a tool without visibility to the model and to apps', () => {
    expect(isToolVisibleTo(undefined, 'model')).toBe(true);
    expect(isToolVisibleTo({ visibility: ['app'] }, 'model')).toBe(false);
    expect(isToolVisibleTo({ visibility: ['model'] }, 'app')).toBe(false);
  });

  it('reads the visibility of a tool that points at no app', () => {
    expect(toolVisibilityOf({ ui: { visibility: ['app'] } })).toEqual(['app']);
    expect(toolAppRefOf({ ui: { visibility: ['app'] } })).toBeUndefined();
    expect(toolVisibilityOf({ ui: { visibility: ['nobody'] } })).toBeUndefined();
    expect(toolVisibilityOf({})).toBeUndefined();
  });
});

describe('MCPServer and MCPClient with MCP Apps', () => {
  let server: MCPServer;
  let client: MCPClient;
  let url: string;
  const calls: string[] = [];

  const chart = tool({
    name: 'show_chart',
    description: 'Shows sales as a chart',
    parameters: z.object({ year: z.number() }),
    app: mcpApp({
      uri: 'ui://sales/chart',
      html: () => CHART_HTML,
      csp: { resourceDomains: ['https://cdn.example.com'] },
      permissions: { clipboardWrite: {} },
      prefersBorder: true,
    }),
    execute: async ({ year }) => {
      calls.push(`show_chart:${year}`);
      return { year, total: 42 };
    },
  }) as Tool;

  const refresh = tool({
    name: 'refresh_sales',
    description: 'Refreshes the sales of a year, for the chart',
    parameters: z.object({ year: z.number() }),
    app: {
      resourceUri: 'ui://sales/chart',
      visibility: ['app'],
      read: () => Promise.reject(new Error('unused')),
    },
    execute: async ({ year }) => {
      calls.push(`refresh_sales:${year}`);
      return { year, total: 43 };
    },
  }) as Tool;

  const wipe = tool({
    name: 'wipe_sales',
    description: 'Wipes the sales',
    parameters: z.object({}),
    annotations: { destructiveHint: true },
    app: {
      resourceUri: 'ui://sales/chart',
      visibility: ['model'],
      read: () => Promise.reject(new Error('unused')),
    },
    execute: async () => 'wiped',
  }) as Tool;

  const cart = tool({
    name: 'show_cart',
    description: 'Shows the cart',
    parameters: z.object({}),
    app: { resourceUri: 'ui://shop/cart', read: () => Promise.reject(new Error('unused')) },
    execute: async () => ({ items: 2 }),
  }) as Tool;

  beforeAll(async () => {
    server = new MCPServer({
      name: 'sales',
      version: '1.0.0',
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
    });
    server.registerTools([chart, refresh, wipe, cart]);
    server.registerApp({
      uri: 'ui://shop/cart',
      name: 'Cart',
      description: 'The shopping cart',
      html: CART_HTML,
      csp: { connectDomains: ['https://shop.example.com'] },
    });
    await server.start();
    url = `http://127.0.0.1:${server.getPort()}/mcp`;
    client = await MCPClient.connect({ transport: 'http', url });
  });

  afterAll(async () => {
    await client?.close();
    await server?.stop();
  });

  it('declares the extension and lists every app once', async () => {
    expect(client.discover().capabilities).toMatchObject({
      extensions: { [MCP_APPS_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] } },
    });
    expect(server.getRegisteredApps().sort()).toEqual(['ui://sales/chart', 'ui://shop/cart']);
    const resources = await client.listResources();
    const apps = resources.filter((resource) => resource.mimeType === MCP_APP_MIME_TYPE);
    expect(apps.map((resource) => resource.uri).sort()).toEqual([
      'ui://sales/chart',
      'ui://shop/cart',
    ]);
    expect(apps.find((resource) => resource.uri === 'ui://shop/cart')).toMatchObject({
      name: 'Cart',
      description: 'The shopping cart',
      _meta: { ui: { csp: { connectDomains: ['https://shop.example.com'] } } },
    });
  });

  it('lists each tool with the app it points at, as a raw client reads it', async () => {
    const raw = new Client({ name: 'raw', version: '1.0.0' });
    await raw.connect(new StreamableHTTPClientTransport(new URL(url)));
    try {
      const { tools } = await raw.listTools();
      const byName = new Map(tools.map((entry) => [entry.name, entry]));
      expect(getToolUiResourceUri(byName.get('show_chart') ?? {})).toBe('ui://sales/chart');
      expect(byName.get('refresh_sales')?._meta).toMatchObject({
        ui: { resourceUri: 'ui://sales/chart', visibility: ['app'] },
        'ui/resourceUri': 'ui://sales/chart',
      });
      const read = await raw.readResource({ uri: 'ui://sales/chart' });
      expect(read.contents[0]).toMatchObject({
        uri: 'ui://sales/chart',
        mimeType: MCP_APP_MIME_TYPE,
        text: CHART_HTML,
        _meta: {
          ui: {
            csp: { resourceDomains: ['https://cdn.example.com'] },
            permissions: { clipboardWrite: {} },
            prefersBorder: true,
          },
        },
      });
    } finally {
      await raw.close();
    }
  });

  it('reads an app with its CSP, falling back to the listing', async () => {
    await expect(client.readApp('ui://sales/chart')).resolves.toEqual({
      uri: 'ui://sales/chart',
      mimeType: MCP_APP_MIME_TYPE,
      html: CHART_HTML,
      csp: { resourceDomains: ['https://cdn.example.com'] },
      permissions: { clipboardWrite: {} },
      prefersBorder: true,
    });
    await expect(client.readApp('ui://shop/cart')).resolves.toMatchObject({
      html: CART_HTML,
      csp: { connectDomains: ['https://shop.example.com'] },
    });
    await expect(client.readApp('https://sales/chart')).rejects.toThrow('ui://');
  });

  it('wraps tools with their app, leaving app-only tools out of the agent', async () => {
    const tools = new Map((await client.getTools()).map((entry) => [entry.name, entry]));
    expect([...tools.keys()].sort()).toEqual(['show_cart', 'show_chart', 'wipe_sales']);
    const app = tools.get('show_chart')?.app;
    expect(app?.resourceUri).toBe('ui://sales/chart');
    await expect(app?.read()).resolves.toMatchObject({ html: CHART_HTML });
    expect(tools.get('wipe_sales')?.app?.visibility).toEqual(['model']);
  });

  it('lets an app call the tools open to apps, and nothing else', async () => {
    const app = await client.getToolApp('show_chart');
    expect(app).toBeDefined();
    const result = await app?.callTool?.('refresh_sales', { year: 2025 });
    const [first] = result?.content ?? [];
    expect(first?.type).toBe('text');
    expect(JSON.parse(String(first?.text))).toEqual({ year: 2025, total: 43 });
    expect(calls).toContain('refresh_sales:2025');

    await expect(app?.callTool?.('wipe_sales', {})).rejects.toThrow('not open to apps');
    await expect(app?.callTool?.('nothing', {})).rejects.toThrow('no tool');
    await expect(app?.requiresApproval?.('wipe_sales')).resolves.toBe(true);
    await expect(app?.requiresApproval?.('refresh_sales')).resolves.toBe(false);

    const gated = await client.getToolApp('show_chart', { requiresApproval: true });
    await expect(gated?.requiresApproval?.('refresh_sales')).resolves.toBe(true);
    const open = (await client.getTools({ requiresApproval: false })).find(
      (entry) => entry.name === 'show_chart'
    );
    await expect(open?.app?.requiresApproval?.('wipe_sales')).resolves.toBe(false);
    const byName = (
      await client.getTools({ requiresApproval: (tool) => tool.name === 'refresh_sales' })
    ).find((entry) => entry.name === 'show_chart');
    await expect(byName?.app?.requiresApproval?.('refresh_sales')).resolves.toBe(true);
    await expect(byName?.app?.requiresApproval?.('wipe_sales')).resolves.toBe(false);
    await expect(client.getToolApp('refresh_sales')).resolves.toBeDefined();
  });

  it('refuses an app at a URI that is not ui://', () => {
    const other = new MCPServer({ name: 'x', version: '1', transport: 'stdio' });
    expect(() => other.registerApp({ uri: 'https://x/app', html: '' })).toThrow('ui://');
  });
});

describe('MCPClient without apps', () => {
  it('surfaces no apps, still keeping app-only tools from the agent', async () => {
    const server = new MCPServer({
      name: 'plain',
      version: '1.0.0',
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
    });
    server.registerTools([
      tool({
        name: 'echo',
        description: 'Echo',
        parameters: z.object({ text: z.string() }),
        app: mcpApp({ uri: 'ui://echo/view', html: '<p>echo</p>' }),
        execute: async ({ text }) => text,
      }) as Tool,
      tool({
        name: 'echo_refresh',
        description: 'Echo again, for the app',
        parameters: z.object({}),
        app: mcpApp({ uri: 'ui://echo/view', html: '<p>echo</p>', visibility: ['app'] }),
        execute: async () => 'again',
      }) as Tool,
    ]);
    await server.start();
    const client = await MCPClient.connect({
      transport: 'http',
      url: `http://127.0.0.1:${server.getPort()}/mcp`,
      apps: false,
    });
    try {
      const tools = await client.getTools();
      expect(tools.map((entry) => entry.name)).toEqual(['echo']);
      expect(tools[0]?.app).toBeUndefined();
      await expect(client.getToolApp('echo')).resolves.toBeUndefined();
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it('declares no apps extension on a server without apps', async () => {
    const server = new MCPServer({
      name: 'bare',
      version: '1.0.0',
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
    });
    server.registerTool(
      tool({
        name: 'ping',
        description: 'Ping',
        parameters: z.object({}),
        execute: async () => 'pong',
      }) as Tool
    );
    await server.start();
    const client = await MCPClient.connect({
      transport: 'http',
      url: `http://127.0.0.1:${server.getPort()}/mcp`,
    });
    try {
      const extensions = Object.keys(client.discover().capabilities.extensions ?? {});
      expect(extensions).not.toContain(MCP_APPS_EXTENSION);
    } finally {
      await client.close();
      await server.stop();
    }
  });
});

describe('agentTools with apps', () => {
  it("points an agent's tool at the app given for it", async () => {
    const { Agent } = await import('@cogitator-ai/core');
    const { agentTools } = await import('../server/serve-agents');
    const writer = new Agent({ name: 'writer', model: 'mock/m', instructions: 'Write.' });
    const reviewer = new Agent({ name: 'reviewer', model: 'mock/m', instructions: 'Review.' });
    const host = {
      run: () => Promise.reject(new Error('unused')),
      resume: () => Promise.reject(new Error('unused')),
    };
    const tools = agentTools(
      host,
      [writer, reviewer],
      {},
      {
        apps: { writer: mcpApp({ uri: 'ui://writer/draft', html: '<p>draft</p>' }) },
      }
    );
    const byName = new Map(tools.map((entry) => [entry.name, entry]));
    expect(byName.get('writer')?.app?.resourceUri).toBe('ui://writer/draft');
    expect(byName.get('writer_resume')?.app).toBeUndefined();
    expect(byName.get('reviewer')?.app).toBeUndefined();
  });
});

describe('a server that sets visibility on tools without an app, and part of _meta.ui on the content', () => {
  let client: MCPClient;

  beforeAll(async () => {
    client = await MCPClient.connect({
      transport: 'stdio',
      command: process.execPath,
      args: [APPS_SERVER],
    });
  });

  afterAll(async () => {
    await client?.close();
  });

  it('keeps an app-only tool without an app of its own from the agent', async () => {
    const definitions = await client.listToolDefinitions();
    expect(definitions.find((entry) => entry.name === 'move_card')).toMatchObject({
      visibility: ['app'],
    });
    expect(definitions.find((entry) => entry.name === 'move_card')?.app).toBeUndefined();
    const tools = await client.getTools();
    expect(tools.map((entry) => entry.name).sort()).toEqual([
      'archive_board',
      'chart_board',
      'show_board',
    ]);
  });

  it('lets an app call the app-only tool, never a model-only one', async () => {
    const app = await client.getToolApp('show_board');
    await expect(app?.callTool?.('move_card', {})).resolves.toMatchObject({
      content: [{ type: 'text', text: 'moved' }],
    });
    await expect(app?.callTool?.('archive_board', {})).rejects.toThrow('not open to apps');
  });

  it('gives an app the content blocks the server sent, a resource link as one', async () => {
    const app = await client.getToolApp('show_board');
    await expect(app?.callTool?.('link_card', {})).resolves.toEqual({
      content: [
        {
          type: 'resource_link',
          uri: 'file:///cards/todo.md',
          name: 'todo.md',
          mimeType: 'text/markdown',
          description: 'The card',
          _meta: { board: 'main' },
        },
      ],
    });
    await expect(client.callTool('link_card', {})).resolves.toBe(
      'Resource: file:///cards/todo.md (todo.md), text/markdown'
    );
  });

  it('keeps a structured result that is no object, in the { result } container', async () => {
    const app = await client.getToolApp('show_board');
    await expect(app?.callTool?.('list_cards', {})).resolves.toMatchObject({
      structuredContent: { result: ['todo', 'done'] },
    });
    await expect(app?.callTool?.('count_cards', {})).resolves.toMatchObject({
      structuredContent: { result: 2 },
    });
    expect(appStructuredContent(null)).toEqual({ result: null });
    expect(appStructuredContent({ a: 1 })).toEqual({ a: 1 });
  });

  it('keeps the structured result of an answer with media for the app, not the model', async () => {
    const forModel = toolContent(
      { type: 'text', text: 'The chart' },
      { type: 'image', data: 'iVBORw0KGgo=', mediaType: 'image/png' }
    );
    await expect(client.callTool('chart_board', {})).resolves.toEqual(forModel);
    await expect(client.callTool('chart_board', {}, { structuredDetails: true })).resolves.toEqual(
      toolOutput({ content: forModel, details: { structuredContent: { cards: 2 } } })
    );
    await expect(client.callTool('list_cards', {}, { structuredDetails: true })).resolves.toEqual([
      'todo',
      'done',
    ]);

    const tools = await client.getTools();
    const chart = tools.find((entry) => entry.name === 'chart_board')!;
    const board = tools.find((entry) => entry.name === 'show_board')!;
    const cogitator = new Cogitator();
    try {
      const charted = await cogitator.invokeTool(chart, {});
      expect(charted.error).toBeUndefined();
      expect(charted.result).toEqual(forModel);
      expect(charted.details).toEqual({ structuredContent: { cards: 2 } });

      const shown = await cogitator.invokeTool(board, {});
      expect(shown.result).toBe('board');
      expect(shown.details).toBeUndefined();
    } finally {
      await cogitator.close();
    }
  });

  it("merges the listing's _meta.ui with the content's, field by field", async () => {
    await expect(client.readApp('ui://board/view')).resolves.toEqual({
      uri: 'ui://board/view',
      mimeType: MCP_APP_MIME_TYPE,
      html: '<p>board</p>',
      csp: { connectDomains: ['https://board.example.com'] },
      permissions: { clipboardWrite: {} },
      prefersBorder: false,
    });
  });
});
