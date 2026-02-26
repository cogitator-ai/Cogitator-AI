import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BrowserSession, browserTools } from '@cogitator-ai/browser';
import type { Tool, ToolContext } from '@cogitator-ai/types';

const describeIfBrowser = process.env.TEST_BROWSER ? describe : describe.skip;

const TEST_HTML = `<!DOCTYPE html>
<html>
<head><title>Test Page</title></head>
<body><h1>Hello</h1></body>
</html>`;

const PAGE_TWO_HTML = `<!DOCTYPE html>
<html>
<head><title>Page Two</title></head>
<body><h1>Second Page</h1></body>
</html>`;

function createTestServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      if (_req.url === '/page-two') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(PAGE_TWO_HTML);
        return;
      }
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

describeIfBrowser('BrowserSession Lifecycle & Config E2E', () => {
  let server: http.Server;
  let baseUrl: string;
  const sessionsToCleanup: BrowserSession[] = [];

  function trackSession(s: BrowserSession): BrowserSession {
    sessionsToCleanup.push(s);
    return s;
  }

  beforeAll(async () => {
    server = await createTestServer();
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterEach(async () => {
    for (const s of sessionsToCleanup) {
      await s.close().catch(() => {});
    }
    sessionsToCleanup.length = 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
  });

  it('double start guard — second start throws, session still usable', async () => {
    const session = trackSession(new BrowserSession({ headless: true }));
    await session.start();

    await expect(session.start()).rejects.toThrow('already started');

    const tools = browserTools(session);
    const navigate = findTool(tools, 'browser_navigate');
    const result = await navigate.execute({ url: baseUrl }, ctx);
    expect((result as { title: string }).title).toBe('Test Page');
  }, 30_000);

  it('custom viewport — page reports correct size and screenshot matches', async () => {
    const session = trackSession(
      new BrowserSession({ headless: true, viewport: { width: 800, height: 600 } })
    );
    await session.start();

    const tools = browserTools(session);
    const navigate = findTool(tools, 'browser_navigate');
    await navigate.execute({ url: baseUrl }, ctx);

    const viewport = session.page.viewportSize();
    expect(viewport).toEqual({ width: 800, height: 600 });

    const screenshot = findTool(tools, 'browser_screenshot');
    const result = await screenshot.execute({}, ctx);
    const { width, height } = result as { width: number; height: number };
    expect(width).toBe(800);
    expect(height).toBe(600);
  }, 30_000);

  it('locale and timezone — navigator.language and Intl reflect config', async () => {
    const session = trackSession(
      new BrowserSession({ headless: true, locale: 'de-DE', timezone: 'Europe/Berlin' })
    );
    await session.start();

    await session.page.goto(baseUrl);

    const language = await session.page.evaluate(() => navigator.language);
    expect(language).toBe('de-DE');

    const tz = await session.page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(tz).toBe('Europe/Berlin');
  }, 30_000);

  it('geolocation — navigator.geolocation returns configured coords', async () => {
    const session = trackSession(
      new BrowserSession({
        headless: true,
        geolocation: { latitude: 48.8566, longitude: 2.3522 },
      })
    );
    await session.start();

    await session.context!.grantPermissions(['geolocation']);
    await session.page.goto(baseUrl);

    const coords = await session.page.evaluate(
      () =>
        new Promise<{ latitude: number; longitude: number }>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
            reject
          );
        })
    );

    expect(coords.latitude).toBeCloseTo(48.8566, 3);
    expect(coords.longitude).toBeCloseTo(2.3522, 3);
  }, 30_000);

  it('custom userAgent — navigator.userAgent matches config', async () => {
    const session = trackSession(new BrowserSession({ headless: true, userAgent: 'TestBot/1.0' }));
    await session.start();
    await session.page.goto(baseUrl);

    const ua = await session.page.evaluate(() => navigator.userAgent);
    expect(ua).toBe('TestBot/1.0');
  }, 30_000);

  it('timeout config — session.config reflects provided values', async () => {
    const session = trackSession(
      new BrowserSession({ headless: true, timeout: 5000, actionTimeout: 2000 })
    );
    await session.start();

    expect(session.config.timeout).toBe(5000);
    expect(session.config.actionTimeout).toBe(2000);
  }, 30_000);

  it('pre-load cookies — cookies available after navigation', async () => {
    const session = trackSession(
      new BrowserSession({
        headless: true,
        cookies: [{ name: 'preloaded', value: 'yes', domain: '127.0.0.1', path: '/' }],
      })
    );
    await session.start();

    await session.page.goto(baseUrl);

    const cookies = await session.getCookies();
    const preloaded = cookies.find((c) => c.name === 'preloaded');
    expect(preloaded).toBeDefined();
    expect(preloaded!.value).toBe('yes');
  }, 30_000);

  it('multi-tab data isolation — different tabs show different pages', async () => {
    const session = trackSession(new BrowserSession({ headless: true }));
    await session.start();

    await session.page.goto(baseUrl);
    const titleTab0 = await session.page.title();
    expect(titleTab0).toBe('Test Page');

    await session.newTab(`${baseUrl}/page-two`);
    expect(session.tabs).toHaveLength(2);
    const titleTab1 = await session.page.title();
    expect(titleTab1).toBe('Page Two');

    session.switchTab(0);
    expect(await session.page.title()).toBe('Test Page');

    session.switchTab(1);
    expect(await session.page.title()).toBe('Page Two');

    expect(titleTab0).not.toBe(titleTab1);
  }, 30_000);

  it('session close cleanup — browser disconnects after close', async () => {
    const session = new BrowserSession({ headless: true });
    await session.start();

    const browser = session.browser!;
    expect(browser.isConnected()).toBe(true);

    await session.close();

    expect(browser.isConnected()).toBe(false);
    expect(session.browser).toBeNull();
  }, 30_000);
});
