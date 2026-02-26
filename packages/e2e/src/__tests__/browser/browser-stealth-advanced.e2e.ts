import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  BrowserSession,
  browserTools,
  humanLikeClick,
  humanLikeScroll,
} from '@cogitator-ai/browser';
import type { Tool, ToolContext } from '@cogitator-ai/types';

const describeIfBrowser = process.env.TEST_BROWSER ? describe : describe.skip;

const TEST_HTML = `<!DOCTYPE html>
<html>
<head><title>Stealth Test</title></head>
<body>
  <button id="toggle-btn" onclick="this.textContent = this.textContent === 'Click me' ? 'Clicked!' : 'Click me'">Click me</button>
  <div style="height:3000px">Tall content</div>
</body>
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
  const t = tools.find((tool) => tool.name === name);
  if (!t) throw new Error(`Tool "${name}" not found`);
  return t;
}

const ctx: ToolContext = {
  agentId: 'e2e-test',
  runId: 'e2e-run',
  signal: AbortSignal.timeout(30_000),
};

describeIfBrowser('Browser Stealth Advanced E2E', () => {
  let server: http.Server;
  let baseUrl: string;
  let session: BrowserSession;
  let tools: Tool[];

  beforeAll(async () => {
    server = await createTestServer();
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;

    session = new BrowserSession({ headless: true, stealth: true });
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

  it('navigator.plugins spoofed', { timeout: 30_000 }, async () => {
    const pluginsLength = await session.page.evaluate(() => navigator.plugins.length);
    expect(pluginsLength).toBeGreaterThan(0);
  });

  it('canvas fingerprint present', { timeout: 30_000 }, async () => {
    const dataUrl = await session.page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 50;
      const ctx2d = canvas.getContext('2d')!;
      ctx2d.fillStyle = '#f60';
      ctx2d.fillRect(0, 0, 200, 50);
      ctx2d.fillStyle = '#069';
      ctx2d.font = '18px Arial';
      ctx2d.fillText('fingerprint', 2, 30);
      return canvas.toDataURL();
    });

    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(dataUrl.length).toBeGreaterThan(50);
  });

  it('navigator.languages set', { timeout: 30_000 }, async () => {
    const languages = await session.page.evaluate(() => navigator.languages);
    expect(languages[0]).toBe('en-US');
  });

  it('humanLikeClick helper', { timeout: 30_000 }, async () => {
    const navigate = findTool(tools, 'browser_navigate');
    await navigate.execute({ url: baseUrl }, ctx);

    const before = await session.page.textContent('#toggle-btn');
    expect(before).toBe('Click me');

    await humanLikeClick(session.page, '#toggle-btn');

    const after = await session.page.textContent('#toggle-btn');
    expect(after).toBe('Clicked!');
  });

  it('humanLikeScroll helper', { timeout: 30_000 }, async () => {
    const navigate = findTool(tools, 'browser_navigate');
    await navigate.execute({ url: baseUrl }, ctx);

    await humanLikeScroll(session.page, 'down', 300);

    const scrollY = await session.page.evaluate(() => window.scrollY);
    expect(scrollY).toBeGreaterThan(0);
  });
});
