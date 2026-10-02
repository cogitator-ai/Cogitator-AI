import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { AddressInfo } from 'node:net';
import { BrowserSession, browserTools } from '@cogitator-ai/browser';
import type { Tool, ToolContext } from '@cogitator-ai/types';

const describeIfBrowser = process.env.TEST_BROWSER ? describe : describe.skip;

const HOME_HTML = `<!DOCTYPE html>
<html>
<head><title>Audit Regressions</title></head>
<body>
  <p>Shipping is free over $50</p>
  <button>Checkout: 2 items</button>
  <a id="popup-link" href="/second" target="_blank">Open second</a>
  <div id="wrapper">
    <table>
      <thead><tr><th>Name</th><th>Details</th></tr></thead>
      <tbody>
        <tr><td>Alice</td><td><table><tr><td>nested-a</td></tr><tr><td>nested-b</td></tr></table></td></tr>
        <tr><td>Bob</td><td>plain</td></tr>
      </tbody>
    </table>
  </div>
  <form>
    <input name="city" value="Old value" />
  </form>
  <div id="hidden-box" style="visibility:hidden;width:50px;height:50px">hidden</div>
  <button id="human-btn" onclick="this.textContent='human-clicked'">Human</button>
</body>
</html>`;

const SECOND_HTML = `<!DOCTYPE html><html><head><title>Second</title></head><body>second</body></html>`;

function createServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith('/api/')) {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ path: req.url }));
        }, 20);
        return;
      }
      if (req.url === '/second') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(SECOND_HTML);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(HOME_HTML);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function findTool(tools: Tool[], name: string): Tool {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`Tool ${name} not found`);
  return found;
}

const ctx: ToolContext = {
  agentId: 'e2e-audit',
  runId: 'e2e-audit-run',
  signal: AbortSignal.timeout(60_000),
};

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Condition not met in time');
}

describeIfBrowser('Browser audit regressions E2E', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = await createServer();
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('default session', () => {
    let session: BrowserSession;
    let tools: Tool[];

    beforeAll(async () => {
      session = new BrowserSession({ headless: true });
      tools = browserTools(session);
      await findTool(tools, 'browser_navigate').execute({ url: baseUrl }, ctx);
    }, 30_000);

    afterAll(async () => {
      await session?.close();
    });

    it('find_by_description sees inline text and names containing colons', async () => {
      const find = findTool(tools, 'browser_find_by_description');

      const shipping = (await find.execute({ description: 'shipping is free' }, ctx)) as {
        elements: Array<{ role: string; name: string }>;
      };
      expect(shipping.elements).toContainEqual(
        expect.objectContaining({ role: 'paragraph', name: 'Shipping is free over $50' })
      );

      const checkout = (await find.execute({ description: 'checkout' }, ctx)) as {
        elements: Array<{ role: string; name: string }>;
      };
      expect(checkout.elements).toContainEqual(
        expect.objectContaining({ role: 'button', name: 'Checkout: 2 items' })
      );
    });

    it('extract_table ignores nested tables and resolves wrapper selectors', async () => {
      const extract = findTool(tools, 'browser_extract_table');
      const result = (await extract.execute({ selector: '#wrapper' }, ctx)) as {
        headers: string[];
        rows: string[][];
      };

      expect(result.headers).toEqual(['Name', 'Details']);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0][0]).toBe('Alice');
      expect(result.rows[1]).toEqual(['Bob', 'plain']);
    });

    it('query_selector_all reports visibility:hidden elements as not visible', async () => {
      const query = findTool(tools, 'browser_query_selector_all');
      const result = (await query.execute({ selector: '#hidden-box' }, ctx)) as {
        elements: Array<{ visible: boolean }>;
      };
      expect(result.elements[0].visible).toBe(false);
    });

    it('records API calls made before get_api_calls is first used, with real timings', async () => {
      await session.page.evaluate(async (url) => {
        await fetch(`${url}/api/early`);
      }, baseUrl);

      const getApiCalls = findTool(tools, 'browser_get_api_calls');
      let calls: Array<{ url: string; status: number; timing: number }> = [];
      await waitFor(async () => {
        const result = (await getApiCalls.execute({ urlPattern: '/api/early' }, ctx)) as {
          calls: typeof calls;
        };
        calls = result.calls;
        return calls.length > 0;
      });

      expect(calls[0].status).toBe(200);
      expect(calls[0].timing).toBeGreaterThan(0);
    });

    it('interceptors apply to every tab and can be removed', async () => {
      const intercept = findTool(tools, 'browser_intercept_request');
      const remove = findTool(tools, 'browser_remove_interceptor');

      const { interceptorId } = (await intercept.execute(
        { urlPattern: '/\\/api\\/blocked$/', action: 'block' },
        ctx
      )) as { interceptorId: string };

      const tab = await session.newTab(baseUrl);
      const blocked = await tab.evaluate(async (url) => {
        try {
          await fetch(`${url}/api/blocked`);
          return false;
        } catch {
          return true;
        }
      }, baseUrl);
      expect(blocked).toBe(true);

      const removed = (await remove.execute({ interceptorId }, ctx)) as { removed: string[] };
      expect(removed.removed).toEqual([interceptorId]);

      const status = await tab.evaluate(
        async (url) => (await fetch(`${url}/api/blocked`)).status,
        baseUrl
      );
      expect(status).toBe(200);

      await session.closeTab();
    });

    it('tracks pages opened by target=_blank links', async () => {
      session.switchTab(0);
      const before = session.tabs.length;

      await Promise.all([session.context!.waitForEvent('page'), session.page.click('#popup-link')]);

      expect(session.tabs).toHaveLength(before + 1);
      const popup = session.tabs[session.tabs.length - 1];
      await popup.waitForLoadState();
      expect(await popup.title()).toBe('Second');
      await session.closeTab(session.tabs.length - 1);
    });

    it('capture_har writes a HAR 1.2 file with ordered entries and timings', async () => {
      const har = findTool(tools, 'browser_capture_har');
      const workDir = await realpath(await mkdtemp(join(tmpdir(), 'cogitator-har-e2e-')));
      const cwd = process.cwd();
      process.chdir(workDir);
      try {
        await har.execute({ action: 'start' }, ctx);
        await session.page.evaluate(async (url) => {
          await fetch(`${url}/api/one?x=1`);
          await fetch(`${url}/api/two`, { method: 'POST', body: '{"k":1}' });
        }, baseUrl);

        const result = (await har.execute({ action: 'stop', path: 'capture.har' }, ctx)) as {
          entries: number;
          path: string;
          har: Array<{ url: string; timing: number; requestBody?: string }>;
        };

        const urls = result.har.map((e) => new URL(e.url).pathname);
        expect(urls).toEqual(['/api/one', '/api/two']);
        expect(result.har[1].requestBody).toBe('{"k":1}');
        expect(result.har.every((e) => e.timing > 0)).toBe(true);
        expect(relative(workDir, result.path)).toBe('capture.har');

        const doc = JSON.parse(await readFile(result.path, 'utf-8'));
        expect(doc.log.version).toBe('1.2');
        expect(doc.log.entries).toHaveLength(2);
        expect(doc.log.entries[0].request.queryString).toEqual([{ name: 'x', value: '1' }]);
        expect(doc.log.entries[0].response.content.mimeType).toBe('application/json');
      } finally {
        process.chdir(cwd);
        await rm(workDir, { recursive: true, force: true });
      }
    });
  });

  describe('stealth session', () => {
    let session: BrowserSession;
    let tools: Tool[];

    beforeAll(async () => {
      session = new BrowserSession({
        headless: true,
        stealth: { humanLikeTyping: true },
        locale: 'de-DE',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      });
      tools = browserTools(session);
      await findTool(tools, 'browser_navigate').execute({ url: baseUrl }, ctx);
    }, 30_000);

    afterAll(async () => {
      await session?.close();
    });

    it('merges partial stealth config with documented defaults', () => {
      expect(session.stealthConfig).toMatchObject({
        humanLikeTyping: true,
        humanLikeMouse: true,
        fingerprintRandomization: true,
        blockWebDriver: true,
      });
    });

    it('keeps navigator fingerprint consistent with user agent and locale', async () => {
      const fingerprint = await session.page.evaluate(() => ({
        platform: navigator.platform,
        languages: [...navigator.languages],
        webdriver: navigator.webdriver,
        ownWebdriver: Object.getOwnPropertyNames(navigator).includes('webdriver'),
      }));

      expect(fingerprint.platform).toBe('Win32');
      expect(fingerprint.languages).toEqual(['de-DE', 'de']);
      expect(fingerprint.webdriver).toBe(false);
      expect(fingerprint.ownWebdriver).toBe(false);
    });

    it('clicks with a human-like mouse path', async () => {
      await findTool(tools, 'browser_click').execute({ selector: '#human-btn' }, ctx);
      expect(await session.page.textContent('#human-btn')).toBe('human-clicked');
    });

    it('fill_form replaces existing values when typing like a human', async () => {
      const result = (await findTool(tools, 'browser_fill_form').execute(
        { fields: { city: 'Berlin' } },
        ctx
      )) as { filled: string[] };

      expect(result.filled).toEqual(['city']);
      expect(await session.page.inputValue('input[name="city"]')).toBe('Berlin');
    });
  });

  describe('session configuration', () => {
    it('honours persistentContext across restarts', async () => {
      const profileDir = await mkdtemp(join(tmpdir(), 'cogitator-profile-'));
      try {
        const first = new BrowserSession({ headless: true, persistentContext: profileDir });
        await first.start();
        expect(first.browser).toBeNull();
        await first.page.goto(baseUrl);
        await first.page.evaluate(() => localStorage.setItem('persisted', 'yes'));
        await first.close();

        const second = new BrowserSession({ headless: true, persistentContext: profileDir });
        await second.start();
        await second.page.goto(baseUrl);
        const value = await second.page.evaluate(() => localStorage.getItem('persisted'));
        await second.close();

        expect(value).toBe('yes');
      } finally {
        await rm(profileDir, { recursive: true, force: true });
      }
    }, 60_000);

    it('enforces pool.maxPages for newTab', async () => {
      const session = new BrowserSession({ headless: true, pool: { maxPages: 2 } });
      await session.start();
      try {
        await session.newTab();
        await expect(session.newTab()).rejects.toThrow('Tab limit reached');
      } finally {
        await session.close();
      }
    });

    it('starts a single browser for concurrent tool calls', async () => {
      const session = new BrowserSession({ headless: true });
      const tools = browserTools(session);
      const getUrl = findTool(tools, 'browser_get_current_url');
      try {
        await Promise.all([getUrl.execute({}, ctx), getUrl.execute({}, ctx)]);
        expect(session.started).toBe(true);
        expect(session.tabs).toHaveLength(1);
      } finally {
        await session.close();
      }
    });
  });
});
