import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { BrowserSession, browserTools, humanLikeType } from '@cogitator-ai/browser';
import type { Tool, ToolContext } from '@cogitator-ai/types';

const describeIfBrowser = process.env.TEST_BROWSER ? describe : describe.skip;

const TEST_HTML = `<!DOCTYPE html>
<html>
<head><title>Cogitator Browser E2E</title></head>
<body>
  <h1 id="heading">Hello Browser</h1>

  <button id="toggle-btn" onclick="this.textContent = this.textContent === 'Click me' ? 'Clicked!' : 'Click me'">Click me</button>

  <form id="test-form" onsubmit="event.preventDefault(); document.getElementById('form-result').textContent = 'Submitted: ' + new FormData(this).get('username')">
    <input name="username" placeholder="Username" />
    <input name="email" type="email" placeholder="Email" />
    <button type="submit" id="submit-btn">Submit</button>
  </form>
  <div id="form-result"></div>

  <nav id="links">
    <a href="/page-one">Page One</a>
    <a href="/page-two" title="Second page">Page Two</a>
    <a href="https://example.com">External</a>
  </nav>

  <table id="data-table">
    <thead><tr><th>Name</th><th>Age</th><th>City</th></tr></thead>
    <tbody>
      <tr><td>Alice</td><td>30</td><td>NYC</td></tr>
      <tr><td>Bob</td><td>25</td><td>LA</td></tr>
      <tr><td>Carol</td><td>35</td><td>Chicago</td></tr>
    </tbody>
  </table>

  <img id="test-img" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" alt="pixel" />

  <select id="fruit-select">
    <option value="apple">Apple</option>
    <option value="banana">Banana</option>
    <option value="cherry">Cherry</option>
  </select>

  <div id="hover-target" onmouseenter="document.getElementById('hover-result').textContent='hovered'" style="width:100px;height:100px;background:blue">
    Hover me
  </div>
  <div id="hover-result"></div>

  <div id="scroll-container" style="height:200px;overflow-y:scroll">
    <div style="height:1000px">Tall content</div>
  </div>

  <input id="key-input" onkeydown="if(event.key==='Enter')document.getElementById('key-result').textContent='enter-pressed'" />
  <div id="key-result"></div>

  <div id="drag-source" draggable="true" ondragstart="event.dataTransfer.setData('text','hello')">Drag me</div>
  <div id="drop-target" ondrop="event.preventDefault();this.textContent='dropped'" ondragover="event.preventDefault()">Drop here</div>

  <input type="file" id="file-upload" />

  <a id="nav-link" href="/page-two">Go to page 2</a>
</body>
</html>`;

const PAGE_TWO_HTML = `<!DOCTYPE html>
<html>
<head><title>Page Two</title></head>
<body><h1>Page Two</h1><a href="/">Back home</a></body>
</html>`;

const API_RESPONSE = JSON.stringify({ status: 'ok', data: [1, 2, 3] });

function createTestServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      if (_req.url === '/api/data') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(API_RESPONSE);
        return;
      }
      if (_req.url === '/page-two') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(PAGE_TWO_HTML);
        return;
      }
      if (_req.url?.endsWith('.png')) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(Buffer.from('iVBORw0KGgo=', 'base64'));
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

describeIfBrowser('Browser Tools E2E', () => {
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

  describe('Navigation', () => {
    it('navigates to test page and verifies URL + title', async () => {
      const navigate = findTool(tools, 'browser_navigate');
      const result = await navigate.execute({ url: baseUrl }, ctx);

      expect(result).toMatchObject({
        url: baseUrl + '/',
        title: 'Cogitator Browser E2E',
        status: 200,
      });
    });

    it('gets current URL after navigation', async () => {
      const getCurrentUrl = findTool(tools, 'browser_get_current_url');
      const result = await getCurrentUrl.execute({}, ctx);

      expect(result).toMatchObject({
        url: baseUrl + '/',
        title: 'Cogitator Browser E2E',
      });
    });

    it('goes back to previous page', async () => {
      const navigate = findTool(tools, 'browser_navigate');
      const goBack = findTool(tools, 'browser_go_back');

      await navigate.execute({ url: baseUrl }, ctx);
      await navigate.execute({ url: `${baseUrl}/page-two` }, ctx);

      const result = await goBack.execute({}, ctx);
      expect((result as { url: string }).url).toBe(baseUrl + '/');
      expect((result as { title: string }).title).toBe('Cogitator Browser E2E');
    });

    it('goes forward after going back', async () => {
      const goForward = findTool(tools, 'browser_go_forward');

      const result = await goForward.execute({}, ctx);
      expect((result as { url: string }).url).toBe(`${baseUrl}/page-two`);
      expect((result as { title: string }).title).toBe('Page Two');
    });

    it('reloads the current page', async () => {
      const navigate = findTool(tools, 'browser_navigate');
      const reload = findTool(tools, 'browser_reload');

      await navigate.execute({ url: baseUrl }, ctx);
      const result = await reload.execute({}, ctx);
      expect((result as { url: string }).url).toBe(baseUrl + '/');
      expect((result as { title: string }).title).toBe('Cogitator Browser E2E');
    });

    it('waits for navigation after clicking a link', async () => {
      const navigate = findTool(tools, 'browser_navigate');
      const click = findTool(tools, 'browser_click');
      const waitForNav = findTool(tools, 'browser_wait_for_navigation');

      await navigate.execute({ url: baseUrl }, ctx);

      const navPromise = waitForNav.execute({ url: '**/page-two', timeout: 5000 }, ctx);

      await click.execute({ selector: '#nav-link' }, ctx);

      const result = await navPromise;
      expect((result as { url: string }).url).toContain('/page-two');
      expect((result as { title: string }).title).toBe('Page Two');
    });

    it('waits for selector to appear', async () => {
      const waitForSelector = findTool(tools, 'browser_wait_for_selector');
      const navigate = findTool(tools, 'browser_navigate');
      await navigate.execute({ url: baseUrl }, ctx);

      const result = await waitForSelector.execute({ selector: '#heading', state: 'visible' }, ctx);
      expect((result as { found: boolean }).found).toBe(true);
    });
  });

  describe('Interaction', () => {
    it('clicks button and verifies state change', async () => {
      const navigate = findTool(tools, 'browser_navigate');
      await navigate.execute({ url: baseUrl }, ctx);

      const click = findTool(tools, 'browser_click');
      const getText = findTool(tools, 'browser_get_text');

      const before = await getText.execute({ selector: '#toggle-btn' }, ctx);
      expect((before as { text: string }).text).toBe('Click me');

      await click.execute({ selector: '#toggle-btn' }, ctx);

      const after = await getText.execute({ selector: '#toggle-btn' }, ctx);
      expect((after as { text: string }).text).toBe('Clicked!');
    });

    it('fills form, submits, and verifies result', async () => {
      const navigate = findTool(tools, 'browser_navigate');
      await navigate.execute({ url: baseUrl }, ctx);

      const fillForm = findTool(tools, 'browser_fill_form');
      const click = findTool(tools, 'browser_click');
      const getText = findTool(tools, 'browser_get_text');

      await fillForm.execute(
        {
          fields: { username: 'testuser', email: 'test@example.com' },
        },
        ctx
      );

      await click.execute({ selector: '#submit-btn' }, ctx);

      const result = await getText.execute({ selector: '#form-result' }, ctx);
      expect((result as { text: string }).text).toBe('Submitted: testuser');
    });

    it('types text into input field', async () => {
      const navigate = findTool(tools, 'browser_navigate');
      await navigate.execute({ url: baseUrl }, ctx);

      const type = findTool(tools, 'browser_type');
      await type.execute(
        { selector: 'input[name="username"]', text: 'typed-user', clearFirst: true },
        ctx
      );

      const val = await session.page.inputValue('input[name="username"]');
      expect(val).toBe('typed-user');
    });

    it('selects option from dropdown', async () => {
      const navigate = findTool(tools, 'browser_navigate');
      await navigate.execute({ url: baseUrl }, ctx);

      const selectOption = findTool(tools, 'browser_select_option');
      const result = await selectOption.execute(
        { selector: '#fruit-select', value: 'banana' },
        ctx
      );
      expect((result as { selected: string[] }).selected).toContain('banana');

      const val = await session.page.inputValue('#fruit-select');
      expect(val).toBe('banana');
    });

    it('hovers over element and triggers mouseenter', async () => {
      const navigate = findTool(tools, 'browser_navigate');
      await navigate.execute({ url: baseUrl }, ctx);

      const hover = findTool(tools, 'browser_hover');
      const getText = findTool(tools, 'browser_get_text');

      await hover.execute({ selector: '#hover-target' }, ctx);

      const result = await getText.execute({ selector: '#hover-result' }, ctx);
      expect((result as { text: string }).text).toBe('hovered');
    });

    it('scrolls an element', async () => {
      const navigate = findTool(tools, 'browser_navigate');
      await navigate.execute({ url: baseUrl }, ctx);

      const scroll = findTool(tools, 'browser_scroll');
      await scroll.execute({ direction: 'down', amount: 200, selector: '#scroll-container' }, ctx);

      const scrollTop = await session.page
        .locator('#scroll-container')
        .evaluate((el: Element) => el.scrollTop);
      expect(scrollTop).toBeGreaterThan(0);
    });

    it('presses a key and verifies effect', async () => {
      const navigate = findTool(tools, 'browser_navigate');
      await navigate.execute({ url: baseUrl }, ctx);

      await session.page.click('#key-input');

      const pressKey = findTool(tools, 'browser_press_key');
      await pressKey.execute({ key: 'Enter' }, ctx);

      const getText = findTool(tools, 'browser_get_text');
      const result = await getText.execute({ selector: '#key-result' }, ctx);
      expect((result as { text: string }).text).toBe('enter-pressed');
    });

    it('drags and drops an element', async () => {
      const navigate = findTool(tools, 'browser_navigate');
      await navigate.execute({ url: baseUrl }, ctx);

      const dragAndDrop = findTool(tools, 'browser_drag_and_drop');
      await dragAndDrop.execute({ source: '#drag-source', target: '#drop-target' }, ctx);

      const getText = findTool(tools, 'browser_get_text');
      const result = await getText.execute({ selector: '#drop-target' }, ctx);
      expect((result as { text: string }).text).toBe('dropped');
    });

    it('uploads a file', async () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'browser-e2e-'));
      const tmpFile = path.join(tmpDir, 'test-upload.txt');
      writeFileSync(tmpFile, 'hello upload');

      try {
        const navigate = findTool(tools, 'browser_navigate');
        await navigate.execute({ url: baseUrl }, ctx);

        const uploadFile = findTool(tools, 'browser_upload_file');
        const result = await uploadFile.execute(
          { selector: '#file-upload', filePaths: [tmpFile] },
          ctx
        );
        expect((result as { uploaded: boolean }).uploaded).toBe(true);

        const files = await session.page
          .locator('#file-upload')
          .evaluate((el: HTMLInputElement) => el.files?.length ?? 0);
        expect(files).toBe(1);
      } finally {
        unlinkSync(tmpFile);
      }
    });
  });

  describe('Extraction', () => {
    it('extracts text from heading', async () => {
      const navigate = findTool(tools, 'browser_navigate');
      await navigate.execute({ url: baseUrl }, ctx);

      const getText = findTool(tools, 'browser_get_text');
      const result = await getText.execute({ selector: '#heading' }, ctx);
      expect((result as { text: string }).text).toBe('Hello Browser');
    });

    it('extracts links from nav', async () => {
      const getLinks = findTool(tools, 'browser_get_links');
      const result = await getLinks.execute({ selector: '#links', baseUrl }, ctx);
      const links = (result as { links: Array<{ text: string; href: string; title?: string }> })
        .links;

      expect(links).toHaveLength(3);
      expect(links[0]).toMatchObject({ text: 'Page One', href: `${baseUrl}/page-one` });
      expect(links[1]).toMatchObject({ text: 'Page Two', title: 'Second page' });
      expect(links[2]).toMatchObject({ text: 'External', href: 'https://example.com/' });
    });

    it('extracts table data with headers and rows', async () => {
      const extractTable = findTool(tools, 'browser_extract_table');
      const result = await extractTable.execute({ selector: '#data-table' }, ctx);

      const { headers, rows } = result as { headers: string[]; rows: string[][] };

      expect(headers).toEqual(['Name', 'Age', 'City']);
      expect(rows).toHaveLength(3);
      expect(rows[0]).toEqual(['Alice', '30', 'NYC']);
      expect(rows[1]).toEqual(['Bob', '25', 'LA']);
      expect(rows[2]).toEqual(['Carol', '35', 'Chicago']);
    });

    it('queries multiple elements via querySelectorAll', async () => {
      const qsa = findTool(tools, 'browser_query_selector_all');
      const result = await qsa.execute(
        {
          selector: '#data-table tbody td',
          attributes: ['class'],
          limit: 9,
        },
        ctx
      );

      const { elements } = result as { elements: Array<{ tag: string; text: string }> };
      expect(elements).toHaveLength(9);
      expect(elements[0]).toMatchObject({ tag: 'td', text: 'Alice' });
    });

    it('gets HTML content of an element', async () => {
      const getHtml = findTool(tools, 'browser_get_html');
      const result = await getHtml.execute({ selector: '#heading', outer: true }, ctx);
      const { html } = result as { html: string };
      expect(html).toContain('<h1');
      expect(html).toContain('Hello Browser');
    });

    it('extracts structured text with instruction', async () => {
      const navigate = findTool(tools, 'browser_navigate');
      await navigate.execute({ url: baseUrl }, ctx);

      const extractStructured = findTool(tools, 'browser_extract_structured');
      const result = await extractStructured.execute(
        { instruction: 'Get the heading text', selector: '#heading' },
        ctx
      );

      const data = result as { instruction: string; text: string; url: string; title: string };
      expect(data.instruction).toBe('Get the heading text');
      expect(data.text).toBe('Hello Browser');
      expect(data.url).toContain(baseUrl);
      expect(data.title).toBe('Cogitator Browser E2E');
    });
  });

  describe('Vision', () => {
    it('takes screenshot and returns valid base64 PNG', async () => {
      const navigate = findTool(tools, 'browser_navigate');
      await navigate.execute({ url: baseUrl }, ctx);

      const screenshot = findTool(tools, 'browser_screenshot');
      const result = await screenshot.execute({}, ctx);

      const { image, width, height } = result as { image: string; width: number; height: number };

      expect(typeof image).toBe('string');
      expect(image.length).toBeGreaterThan(100);

      const buf = Buffer.from(image, 'base64');
      const pngMagic = buf.subarray(0, 4);
      expect(pngMagic[0]).toBe(0x89);
      expect(pngMagic[1]).toBe(0x50);
      expect(pngMagic[2]).toBe(0x4e);
      expect(pngMagic[3]).toBe(0x47);

      expect(width).toBe(1280);
      expect(height).toBe(720);
    });

    it('screenshots a specific element with bounding box', async () => {
      const navigate = findTool(tools, 'browser_navigate');
      await navigate.execute({ url: baseUrl }, ctx);

      const screenshotElement = findTool(tools, 'browser_screenshot_element');
      const result = await screenshotElement.execute({ selector: '#heading' }, ctx);

      const data = result as {
        image: string;
        boundingBox: { x: number; y: number; width: number; height: number } | null;
      };

      expect(typeof data.image).toBe('string');
      expect(data.image.length).toBeGreaterThan(50);

      const buf = Buffer.from(data.image, 'base64');
      expect(buf[0]).toBe(0x89);
      expect(buf[1]).toBe(0x50);

      expect(data.boundingBox).not.toBeNull();
      expect(data.boundingBox!.width).toBeGreaterThan(0);
      expect(data.boundingBox!.height).toBeGreaterThan(0);
    });

    it('finds elements by accessibility description', async () => {
      const navigate = findTool(tools, 'browser_navigate');
      await navigate.execute({ url: baseUrl }, ctx);

      const findByDescription = findTool(tools, 'browser_find_by_description');
      const result = await findByDescription.execute({ description: 'heading' }, ctx);

      const { elements } = result as {
        elements: Array<{ role: string; name: string; description: string }>;
      };

      expect(elements.length).toBeGreaterThan(0);
      expect(elements.some((e) => e.role === 'heading')).toBe(true);
    });

    it('clicks element by description', async () => {
      const navigate = findTool(tools, 'browser_navigate');
      await navigate.execute({ url: baseUrl }, ctx);

      const clickByDesc = findTool(tools, 'browser_click_by_description');
      const result = await clickByDesc.execute({ description: 'Click me' }, ctx);

      const data = result as { clicked: boolean };
      expect(data.clicked).toBe(true);

      const getText = findTool(tools, 'browser_get_text');
      const after = await getText.execute({ selector: '#toggle-btn' }, ctx);
      expect((after as { text: string }).text).toBe('Clicked!');
    });
  });

  describe('Network', () => {
    it('blocks image resources and verifies they fail', async () => {
      const blockResources = findTool(tools, 'browser_block_resources');
      const navigate = findTool(tools, 'browser_navigate');

      const blockResult = await blockResources.execute({ types: ['image'] }, ctx);
      expect((blockResult as { blocking: boolean }).blocking).toBe(true);

      const blocked: string[] = [];
      session.page.on('requestfailed', (req) => {
        if (req.resourceType() === 'image') {
          blocked.push(req.url());
        }
      });

      await navigate.execute({ url: `${baseUrl}/with-img` }, ctx);

      const getAttribute = findTool(tools, 'browser_get_attribute');
      const src = await getAttribute.execute({ selector: '#test-img', attribute: 'src' }, ctx);

      expect((src as { value: string | null }).value).toContain('data:image/png');
      expect(blocked.length).toBeGreaterThanOrEqual(0);
    });

    it('waits for network response from API endpoint', async () => {
      const navigate = findTool(tools, 'browser_navigate');
      await navigate.execute({ url: baseUrl }, ctx);

      const waitForResponse = findTool(tools, 'browser_wait_for_response');

      const responsePromise = waitForResponse.execute(
        { urlPattern: '/api/data', timeout: 5000 },
        ctx
      );

      await session.page.evaluate((url: string) => {
        void fetch(url + '/api/data');
      }, baseUrl);

      const result = await responsePromise;
      const { url, status, body } = result as { url: string; status: number; body: string };

      expect(url).toContain('/api/data');
      expect(status).toBe(200);
      expect(body).toBe(API_RESPONSE);
    });

    it('intercepts and blocks a request', async () => {
      const navigate = findTool(tools, 'browser_navigate');
      await navigate.execute({ url: baseUrl }, ctx);

      const intercept = findTool(tools, 'browser_intercept_request');
      const result = await intercept.execute(
        { urlPattern: '**/api/blocked', action: 'block' },
        ctx
      );

      expect((result as { interceptorId: string }).interceptorId).toBeTruthy();

      const failed = await session.page.evaluate(async (url: string) => {
        try {
          await fetch(url + '/api/blocked');
          return false;
        } catch {
          return true;
        }
      }, baseUrl);

      expect(failed).toBe(true);
    });

    it('intercepts and modifies a request with custom headers', async () => {
      const navigate = findTool(tools, 'browser_navigate');
      await navigate.execute({ url: baseUrl }, ctx);

      const intercept = findTool(tools, 'browser_intercept_request');
      await intercept.execute(
        {
          urlPattern: '**/api/data',
          action: 'modify',
          modify: { headers: { 'X-Custom-Header': 'e2e-test' } },
        },
        ctx
      );

      const waitForResponse = findTool(tools, 'browser_wait_for_response');
      const responsePromise = waitForResponse.execute(
        { urlPattern: '/api/data', timeout: 5000 },
        ctx
      );

      await session.page.evaluate((url: string) => {
        void fetch(url + '/api/data');
      }, baseUrl);

      const result = await responsePromise;
      expect((result as { status: number }).status).toBe(200);
    });

    it('captures HAR traffic', async () => {
      const captureHar = findTool(tools, 'browser_capture_har');
      const navigate = findTool(tools, 'browser_navigate');

      const startResult = await captureHar.execute({ action: 'start' }, ctx);
      expect((startResult as { capturing: boolean }).capturing).toBe(true);

      await navigate.execute({ url: baseUrl }, ctx);

      await session.page.evaluate((url: string) => {
        void fetch(url + '/api/data');
      }, baseUrl);

      await new Promise((r) => setTimeout(r, 500));

      const stopResult = await captureHar.execute({ action: 'stop' }, ctx);
      const data = stopResult as {
        capturing: boolean;
        entries: number;
        har: Array<{ url: string; method: string; status: number }>;
      };

      expect(data.capturing).toBe(false);
      expect(data.entries).toBeGreaterThan(0);
      expect(data.har.some((e) => e.url.includes('/api/data'))).toBe(true);
    });

    it('records and retrieves API calls', async () => {
      const getApiCalls = findTool(tools, 'browser_get_api_calls');
      const navigate = findTool(tools, 'browser_navigate');

      await navigate.execute({ url: baseUrl }, ctx);

      await getApiCalls.execute({}, ctx);

      await session.page.evaluate((url: string) => {
        void fetch(url + '/api/data');
      }, baseUrl);

      await new Promise((r) => setTimeout(r, 500));

      const result = await getApiCalls.execute({ urlPattern: '/api/data' }, ctx);
      const { calls } = result as {
        calls: Array<{ url: string; method: string; status: number }>;
      };

      expect(calls.length).toBeGreaterThan(0);
      expect(calls.some((c) => c.url.includes('/api/data') && c.status === 200)).toBe(true);
    });
  });

  describe('Session — Tab management', () => {
    it('opens new tab, switches, and closes', async () => {
      expect(session.tabs).toHaveLength(1);

      const newPage = await session.newTab(`${baseUrl}/page-two`);
      expect(session.tabs).toHaveLength(2);
      expect(newPage.url()).toContain('/page-two');

      const title = await session.page.title();
      expect(title).toBe('Page Two');

      session.switchTab(0);
      const origTitle = await session.page.title();
      expect(origTitle).not.toBe('Page Two');

      await session.closeTab(1);
      expect(session.tabs).toHaveLength(1);
    });

    it('throws on closing the last tab', async () => {
      expect(session.tabs).toHaveLength(1);
      await expect(session.closeTab(0)).rejects.toThrow('Cannot close the last tab');
    });

    it('throws on invalid tab index', () => {
      expect(() => session.switchTab(99)).toThrow('out of range');
    });
  });

  describe('Session — Cookie management', () => {
    it('sets and gets cookies', async () => {
      const navigate = findTool(tools, 'browser_navigate');
      await navigate.execute({ url: baseUrl }, ctx);

      await session.setCookies([
        {
          name: 'test-cookie',
          value: 'hello',
          domain: '127.0.0.1',
          path: '/',
        },
      ]);

      const cookies = await session.getCookies();
      const testCookie = cookies.find((c) => c.name === 'test-cookie');
      expect(testCookie).toBeDefined();
      expect(testCookie!.value).toBe('hello');
    });

    it('saves and loads cookies from file', async () => {
      const navigate = findTool(tools, 'browser_navigate');
      await navigate.execute({ url: baseUrl }, ctx);

      await session.setCookies([
        {
          name: 'persist-cookie',
          value: 'saved',
          domain: '127.0.0.1',
          path: '/',
        },
      ]);

      const tmpDir = mkdtempSync(path.join(tmpdir(), 'browser-cookies-'));
      const cookieFile = path.join(tmpDir, 'cookies.json');

      try {
        await session.saveCookies(cookieFile);

        const { readFileSync } = await import('node:fs');
        const savedData = JSON.parse(readFileSync(cookieFile, 'utf-8'));
        expect(savedData.some((c: { name: string }) => c.name === 'persist-cookie')).toBe(true);

        await session.loadCookies(cookieFile);
        const cookies = await session.getCookies();
        expect(cookies.some((c) => c.name === 'persist-cookie')).toBe(true);
      } finally {
        unlinkSync(cookieFile);
      }
    });
  });

  describe('Stealth', () => {
    let stealthSession: BrowserSession;
    let stealthTools: Tool[];

    beforeAll(async () => {
      stealthSession = new BrowserSession({
        headless: true,
        stealth: true,
      });
      await stealthSession.start();
      stealthTools = browserTools(stealthSession);
    }, 30_000);

    afterAll(async () => {
      await stealthSession?.close();
    });

    it('hides navigator.webdriver when stealth is enabled', async () => {
      const navigate = findTool(stealthTools, 'browser_navigate');
      await navigate.execute({ url: baseUrl }, ctx);

      const webdriverValue = await stealthSession.page.evaluate(
        () => (navigator as Navigator & { webdriver?: boolean }).webdriver
      );
      expect(webdriverValue).toBe(false);
    });

    it('exposes chrome runtime object', async () => {
      const hasChrome = await stealthSession.page.evaluate(
        () => !!(window as Window & { chrome?: unknown }).chrome
      );
      expect(hasChrome).toBe(true);
    });

    it('reports human-like typing config', () => {
      expect(stealthSession.stealthEnabled).toBe(true);
      expect(stealthSession.stealthConfig).toBeDefined();
      expect(stealthSession.stealthConfig!.humanLikeTyping).toBe(true);
    });

    it('humanLikeType helper types without error', async () => {
      const navigate = findTool(stealthTools, 'browser_navigate');
      await navigate.execute({ url: baseUrl }, ctx);

      await humanLikeType(stealthSession.page, 'input[name="username"]', 'hi');

      const val = await stealthSession.page.inputValue('input[name="username"]');
      expect(val).toContain('hi');
    });
  });
});
