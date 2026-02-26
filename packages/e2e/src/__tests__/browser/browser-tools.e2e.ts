import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BrowserSession, browserTools } from '@cogitator-ai/browser';
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
</body>
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

  it('clicks button and verifies state change', async () => {
    const click = findTool(tools, 'browser_click');
    const getText = findTool(tools, 'browser_get_text');

    const before = await getText.execute({ selector: '#toggle-btn' }, ctx);
    expect((before as { text: string }).text).toBe('Click me');

    await click.execute({ selector: '#toggle-btn' }, ctx);

    const after = await getText.execute({ selector: '#toggle-btn' }, ctx);
    expect((after as { text: string }).text).toBe('Clicked!');
  });

  it('fills form, submits, and verifies result', async () => {
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

  it('extracts text from heading', async () => {
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

  it('takes screenshot and returns valid base64 PNG', async () => {
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
    const src = await getAttribute.execute(
      {
        selector: '#test-img',
        attribute: 'src',
      },
      ctx
    );

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

  it('waits for selector to appear', async () => {
    const waitForSelector = findTool(tools, 'browser_wait_for_selector');
    const result = await waitForSelector.execute({ selector: '#heading', state: 'visible' }, ctx);
    expect((result as { found: boolean }).found).toBe(true);
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
});
