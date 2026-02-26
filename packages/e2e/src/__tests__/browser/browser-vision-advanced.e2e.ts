import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BrowserSession, browserTools } from '@cogitator-ai/browser';
import type { Tool, ToolContext } from '@cogitator-ai/types';

const describeIfBrowser = process.env.TEST_BROWSER ? describe : describe.skip;

const TEST_HTML = `<!DOCTYPE html>
<html>
<head><title>Vision Test</title></head>
<body>
  <img id="test-img" alt="pixel" data-custom="test-value" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" />
  <div style="height:2000px">Tall content for full page screenshot</div>
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
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`Tool "${name}" not found`);
  return t;
}

const ctx: ToolContext = {
  agentId: 'e2e-test',
  runId: 'e2e-run',
  signal: AbortSignal.timeout(30_000),
};

describeIfBrowser('Browser Vision Advanced E2E', () => {
  let server: http.Server;
  let baseUrl: string;
  let session: BrowserSession;
  let tools: Tool[];

  beforeAll(async () => {
    server = await createTestServer();
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;

    session = new BrowserSession({ headless: true });
    await session.start();
    tools = browserTools(session);
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
  });

  it('getAttribute returns correct attribute values', async () => {
    const navigate = findTool(tools, 'browser_navigate');
    await navigate.execute({ url: baseUrl }, ctx);

    const getAttribute = findTool(tools, 'browser_get_attribute');

    const altResult = await getAttribute.execute({ selector: '#test-img', attribute: 'alt' }, ctx);
    expect(altResult).toMatchObject({ value: 'pixel' });

    const customResult = await getAttribute.execute(
      { selector: '#test-img', attribute: 'data-custom' },
      ctx
    );
    expect(customResult).toMatchObject({ value: 'test-value' });
  }, 30_000);

  it('screenshot JPEG with quality returns valid JPEG', async () => {
    const navigate = findTool(tools, 'browser_navigate');
    await navigate.execute({ url: baseUrl }, ctx);

    const screenshot = findTool(tools, 'browser_screenshot');
    const result = (await screenshot.execute({ quality: 80 }, ctx)) as {
      image: string;
      width: number;
      height: number;
    };

    expect(typeof result.image).toBe('string');
    expect(result.image.length).toBeGreaterThan(100);

    const buf = Buffer.from(result.image, 'base64');
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xd8);
  }, 30_000);

  it('screenshot fullPage captures content beyond viewport', async () => {
    const navigate = findTool(tools, 'browser_navigate');
    await navigate.execute({ url: baseUrl }, ctx);

    const screenshot = findTool(tools, 'browser_screenshot');
    const result = (await screenshot.execute({ fullPage: true }, ctx)) as {
      image: string;
      width: number;
      height: number;
    };

    const buf = Buffer.from(result.image, 'base64');
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);

    const pngHeight = buf.readUInt32BE(20);
    expect(pngHeight).toBeGreaterThan(720);
  }, 30_000);
});
