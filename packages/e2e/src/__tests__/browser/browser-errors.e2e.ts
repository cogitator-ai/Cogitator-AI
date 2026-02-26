import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BrowserSession, browserTools } from '@cogitator-ai/browser';
import type { Tool, ToolContext } from '@cogitator-ai/types';

const describeIfBrowser = process.env.TEST_BROWSER ? describe : describe.skip;

const TEST_HTML = `<!DOCTYPE html>
<html>
<head><title>Error Test Page</title></head>
<body><h1 id="heading">Error Tests</h1></body>
</html>`;

function createTestServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(TEST_HTML);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function findTool(tools: Tool[], name: string): Tool {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`Tool "${name}" not found`);
  return t;
}

const ctx: ToolContext = {
  agentId: 'e2e-test',
  runId: 'e2e-run',
  signal: AbortSignal.timeout(30_000),
};

describeIfBrowser('Browser Tools — Error Handling', () => {
  let server: http.Server;
  let baseUrl: string;
  let session: BrowserSession;
  let tools: Tool[];

  beforeAll(async () => {
    server = await createTestServer();
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;

    session = new BrowserSession({ headless: true, actionTimeout: 5000 });
    await session.start();
    tools = browserTools(session);

    const navigate = findTool(tools, 'browser_navigate');
    await navigate.execute({ url: baseUrl }, ctx);
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
  });

  it('rejects when clicking a non-existent selector', { timeout: 30_000 }, async () => {
    const click = findTool(tools, 'browser_click');
    await expect(click.execute({ selector: '#does-not-exist' }, ctx)).rejects.toThrow();
  });

  it('rejects when navigating to an invalid URL', { timeout: 30_000 }, async () => {
    const navigate = findTool(tools, 'browser_navigate');
    await expect(navigate.execute({ url: 'not-a-valid-url' }, ctx)).rejects.toThrow();
  });
});
