import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { chromium, type Browser, type Page } from 'playwright';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { MCPClient, MCPServer, MCP_APP_MIME_TYPE, mcpApp } from '@cogitator-ai/mcp';
import { startStudio, type StudioHandle } from '@cogitator-ai/studio';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  Tool,
  ToolResult,
} from '@cogitator-ai/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDIO_FIXTURE = join(HERE, 'fixtures', 'apps-studio');

/**
 * The chart app, as an MCP App page with no SDK: it speaks JSON-RPC over postMessage with its host,
 * shows the call's arguments and result, and calls two tools of its server from its buttons
 */
const CHART_HTML = `<!doctype html>
<html>
  <body>
    <pre id="input">waiting</pre>
    <pre id="result">waiting</pre>
    <pre id="called">nothing</pre>
    <button id="refresh">Refresh</button>
    <button id="wipe">Wipe</button>
    <script>
      let next = 0;
      const pending = new Map();
      const show = (id, value) => {
        document.getElementById(id).textContent = JSON.stringify(value);
      };
      function request(method, params) {
        return new Promise((resolve) => {
          const id = ++next;
          pending.set(id, resolve);
          window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
        });
      }
      window.addEventListener('message', (event) => {
        const message = event.data;
        if (!message || message.jsonrpc !== '2.0') return;
        if (message.id !== undefined && !message.method && pending.has(message.id)) {
          pending.get(message.id)(message.result ?? { error: message.error });
          pending.delete(message.id);
        } else if (message.method === 'ui/notifications/tool-input') {
          show('input', message.params.arguments);
        } else if (message.method === 'ui/notifications/tool-result') {
          show('result', message.params.content[0].text);
        } else if (message.id !== undefined && message.method) {
          window.parent.postMessage({ jsonrpc: '2.0', id: message.id, result: {} }, '*');
        }
      });
      const call = async (name) => {
        const result = await request('tools/call', { name, arguments: { year: 2025 } });
        show('called', result.isError ? 'error: ' + result.content[0].text : result.content[0].text);
      };
      document.getElementById('refresh').addEventListener('click', () => call('refresh_sales'));
      document.getElementById('wipe').addEventListener('click', () => call('wipe_sales'));
      request('ui/initialize', {
        appInfo: { name: 'chart', version: '1.0.0' },
        appCapabilities: {},
        protocolVersion: '2026-01-26',
      }).then(() => {
        window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*');
      });
    </script>
  </body>
</html>`;

const calls: string[] = [];

function salesServer(): MCPServer {
  const server = new MCPServer({
    name: 'sales',
    version: '1.0.0',
    transport: 'http',
    host: '127.0.0.1',
    port: 0,
  });
  server.registerTools([
    tool({
      name: 'show_chart',
      description: 'Shows the sales of a year as a chart',
      parameters: z.object({ year: z.number() }),
      app: mcpApp({
        uri: 'ui://sales/chart',
        name: 'Sales chart',
        html: CHART_HTML,
        csp: { connectDomains: ['https://sales.example.com'] },
      }),
      execute: async ({ year }) => ({ year, total: 42 }),
    }) as Tool,
    tool({
      name: 'refresh_sales',
      description: 'Refreshes the sales of a year, for the chart',
      parameters: z.object({ year: z.number() }),
      app: mcpApp({ uri: 'ui://sales/chart', html: CHART_HTML, visibility: ['app'] }),
      execute: async ({ year }) => {
        calls.push('refresh_sales');
        return `refreshed ${year}`;
      },
    }) as Tool,
    tool({
      name: 'wipe_sales',
      description: 'Wipes the sales of a year',
      parameters: z.object({ year: z.number() }),
      annotations: { destructiveHint: true },
      app: mcpApp({ uri: 'ui://sales/chart', html: CHART_HTML, visibility: ['app'] }),
      execute: async ({ year }) => {
        calls.push('wipe_sales');
        return `wiped ${year}`;
      },
    }) as Tool,
  ]);
  return server;
}

const usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };

function scriptedModel(): LLMBackend {
  const respond = (request: ChatRequest): ChatResponse =>
    request.messages.at(-1)?.role === 'tool'
      ? { id: 'answer', content: 'Here is the chart.', finishReason: 'stop', usage }
      : {
          id: 'call',
          content: '',
          toolCalls: [{ id: 'call_chart', name: 'show_chart', arguments: { year: 2025 } }],
          finishReason: 'tool_calls',
          usage,
        };
  return {
    provider: 'openai',
    chat: async (request) => respond(request),
    chatStream: async function* (request): AsyncGenerator<ChatStreamChunk> {
      const answer = respond(request);
      if (answer.content) yield { id: answer.id, delta: { content: answer.content } };
      if (answer.toolCalls) yield { id: answer.id, delta: { toolCalls: answer.toolCalls } };
      yield { id: answer.id, delta: {}, finishReason: answer.finishReason, usage };
    },
  };
}

describe('MCP Apps: a server serves an app, a client and a run carry it', () => {
  let server: MCPServer;
  let client: MCPClient;

  beforeAll(async () => {
    server = salesServer();
    await server.start();
    client = await MCPClient.connect({
      transport: 'http',
      url: `http://127.0.0.1:${server.getPort()}/mcp`,
    });
  });

  afterAll(async () => {
    await client?.close();
    await server?.stop();
  });

  it('lists the app as a resource of the MCP Apps type and reads it with its CSP', async () => {
    const resources = await client.listResources();
    expect(resources).toContainEqual(
      expect.objectContaining({ uri: 'ui://sales/chart', mimeType: MCP_APP_MIME_TYPE })
    );
    const app = await client.readApp('ui://sales/chart');
    expect(app.html).toContain('ui/initialize');
    expect(app.csp).toEqual({ connectDomains: ['https://sales.example.com'] });
  });

  it('gives the agent the model tools only, with the app on the one that has it', async () => {
    const tools = await client.getTools();
    expect(tools.map((entry) => entry.name)).toEqual(['show_chart']);
    expect(tools[0]?.app?.resourceUri).toBe('ui://sales/chart');
  });

  it('runs the tool in an agent, and the result comes with the app to show it', async () => {
    const cogitator = new Cogitator({ llm: { backends: { mock: scriptedModel() } } });
    const tools = await client.getTools();
    const results: ToolResult[] = [];
    const result = await cogitator.run(
      new Agent({ name: 'sales', model: 'mock/m', instructions: 'Show the sales.', tools }),
      { input: 'Chart 2025', onToolResult: (entry) => results.push(entry) }
    );
    expect(result.output).toBe('Here is the chart.');
    expect(results).toEqual([
      expect.objectContaining({ name: 'show_chart', result: { year: 2025, total: 42 } }),
    ]);
    const app = tools.find((entry) => entry.name === results[0]?.name)?.app;
    expect(app?.resourceUri).toBe('ui://sales/chart');
    await expect(app?.callTool?.('refresh_sales', { year: 2025 })).resolves.toMatchObject({
      content: [{ type: 'text', text: 'refreshed 2025' }],
    });
    await expect(app?.callTool?.('show_chart', { year: 2025 })).resolves.toMatchObject({
      content: [{ type: 'text' }],
    });
    await cogitator.close();
  });
});

async function chromiumInstalled(): Promise<boolean> {
  try {
    await (await chromium.launch()).close();
    return true;
  } catch {
    return false;
  }
}

const browserReady = await chromiumInstalled();
if (!browserReady) {
  console.warn(
    'Skipping the MCP Apps Studio e2e: no Chromium, run pnpm --filter @cogitator-ai/e2e exec playwright install chromium'
  );
}

describe.skipIf(!browserReady)('MCP Apps in Cogitator Studio', () => {
  let server: MCPServer;
  let studio: StudioHandle;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = salesServer();
    await server.start();
    process.env.MCP_APPS_URL = `http://127.0.0.1:${server.getPort()}/mcp`;
    studio = await startStudio({
      projectDir: STUDIO_FIXTURE,
      studioDir: mkdtempSync(join(tmpdir(), 'mcp-apps-studio-')),
      port: 0,
      watch: false,
      price: () => 0,
    });
    await studio.ready();
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.goto(`${studio.url}#/agents/sales`);
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await studio?.close();
    await server?.stop();
    delete process.env.MCP_APPS_URL;
  });

  it('shows the app of a tool call, sandboxed, with the call and its result', async () => {
    await page.getByTestId('chat-input').fill('Chart the sales of 2025');
    await page.getByTestId('send').click();
    const turn = page.getByTestId('turn').last();
    await expect
      .poll(() => turn.getAttribute('data-status'), { timeout: 30_000 })
      .toBe('completed');

    const frameElement = page.getByTestId('tool-app-frame');
    await frameElement.waitFor({ timeout: 30_000 });
    expect(await frameElement.getAttribute('sandbox')).toBe('allow-scripts');
    const app = page.frameLocator('[data-testid="tool-app-frame"]');
    await expect
      .poll(() => app.locator('#input').innerText(), { timeout: 15_000 })
      .toBe('{"year":2025}');
    await expect
      .poll(() => app.locator('#result').innerText(), { timeout: 15_000 })
      .toContain('42');

    const origin = await app.locator('body').evaluate(() => window.origin);
    expect(origin).toBe('null');
  });

  it('runs a tool the app calls, and asks before a destructive one', async () => {
    const app = page.frameLocator('[data-testid="tool-app-frame"]');
    await app.locator('#refresh').click();
    await expect
      .poll(() => app.locator('#called').innerText(), { timeout: 15_000 })
      .toContain('refreshed 2025');

    await app.locator('#wipe').click();
    await page.getByTestId('tool-app-approval').waitFor({ timeout: 15_000 });
    expect(calls).not.toContain('wipe_sales');
    await page.getByTestId('tool-app-allow').click();
    await expect
      .poll(() => app.locator('#called').innerText(), { timeout: 15_000 })
      .toContain('wiped 2025');
    expect(calls).toContain('wipe_sales');
  });
});
