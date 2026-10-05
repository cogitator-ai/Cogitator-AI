import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWebScrapeTool } from '../tools/web-scrape';
import type { FetchFunction } from '../utils/public-network';
/** Sends the tool's requests through the global `fetch`, which these tests stub. */
const viaGlobalFetch: FetchFunction = (input, init) => fetch(input, init);
const webScrape = createWebScrapeTool({ fetch: viaGlobalFetch });

const mockFetch = vi.fn();

describe('web_scrape tool', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ctx = { agentId: 'test', runId: 'run1', signal: new AbortController().signal };

  const createHtmlResponse = (html: string, contentType = 'text/html') => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Map([['content-type', contentType]]),
    text: async () => html,
  });

  describe('basic scraping', () => {
    it('scrapes page and extracts text', async () => {
      const html = `
        <html>
          <head><title>Test Page</title></head>
          <body>
            <h1>Hello World</h1>
            <p>This is a test paragraph.</p>
          </body>
        </html>
      `;
      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));

      const result = await webScrape.execute({ url: 'https://example.com' }, ctx);

      expect(result).toMatchObject({
        url: 'https://example.com',
        title: 'Test Page',
        format: 'text',
      });
      expect((result as { content: string }).content).toContain('Hello World');
      expect((result as { content: string }).content).toContain('This is a test paragraph');
    });

    it('extracts title from h1 if no title tag', async () => {
      const html = '<html><body><h1>Main Heading</h1></body></html>';
      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));

      const result = await webScrape.execute({ url: 'https://example.com' }, ctx);
      expect((result as { title: string }).title).toBe('Main Heading');
    });

    it('sends proper user agent', async () => {
      mockFetch.mockResolvedValueOnce(createHtmlResponse('<html><body>Test</body></html>'));

      await webScrape.execute({ url: 'https://example.com' }, ctx);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          headers: expect.objectContaining({
            'User-Agent': expect.stringContaining('CogitatorBot'),
          }),
        })
      );
    });
  });

  describe('output formats', () => {
    const html = `
      <html>
        <head><title>Format Test</title></head>
        <body>
          <h1>Heading</h1>
          <p><strong>Bold</strong> and <em>italic</em> text.</p>
          <a href="https://link.com">A link</a>
        </body>
      </html>
    `;

    it('returns plain text by default', async () => {
      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));

      const result = await webScrape.execute({ url: 'https://example.com', format: 'text' }, ctx);
      const content = (result as { content: string }).content;

      expect(content).toContain('Heading');
      expect(content).toContain('Bold');
      expect(content).not.toContain('<h1>');
      expect(content).not.toContain('**');
    });

    it('returns markdown when requested', async () => {
      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));

      const result = await webScrape.execute(
        { url: 'https://example.com', format: 'markdown' },
        ctx
      );
      const content = (result as { content: string }).content;

      expect(content).toContain('# Heading');
      expect(content).toContain('**Bold**');
      expect(content).toContain('*italic*');
      expect(content).toContain('[A link](https://link.com)');
    });

    it('keeps multi-line link text on one line and drops links without text', async () => {
      const page = `<p><a href="/docs">Read
        the docs</a> or <a href="/home"><img src="/logo.png"></a> go home</p>`;
      mockFetch.mockResolvedValueOnce(createHtmlResponse(page));

      const result = await webScrape.execute(
        { url: 'https://example.com', format: 'markdown' },
        ctx
      );

      expect((result as { content: string }).content).toBe('[Read the docs](/docs) or  go home');
    });

    it('returns raw HTML when requested', async () => {
      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));

      const result = await webScrape.execute({ url: 'https://example.com', format: 'html' }, ctx);
      const content = (result as { content: string }).content;

      expect(content).toContain('<h1>Heading</h1>');
      expect(content).toContain('<strong>Bold</strong>');
    });
  });

  describe('CSS selector extraction', () => {
    const html = `
      <html>
        <body>
          <nav>Navigation</nav>
          <article>
            <h2>Article Title</h2>
            <p>Article content here.</p>
          </article>
          <aside>Sidebar</aside>
        </body>
      </html>
    `;

    it('extracts content by tag selector', async () => {
      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));

      const result = await webScrape.execute(
        { url: 'https://example.com', selector: 'article' },
        ctx
      );
      const content = (result as { content: string }).content;

      expect(content).toContain('Article Title');
      expect(content).toContain('Article content');
      expect(content).not.toContain('Navigation');
      expect(content).not.toContain('Sidebar');
    });

    it('extracts content by class selector', async () => {
      const htmlWithClass = `
        <html><body>
          <div class="main-content">Target content</div>
          <div class="sidebar">Other content</div>
        </body></html>
      `;
      mockFetch.mockResolvedValueOnce(createHtmlResponse(htmlWithClass));

      const result = await webScrape.execute(
        { url: 'https://example.com', selector: '.main-content' },
        ctx
      );
      const content = (result as { content: string }).content;

      expect(content).toContain('Target content');
    });

    it('extracts content by id selector', async () => {
      const htmlWithId = `
        <html><body>
          <div id="target">Target content</div>
          <div>Other content</div>
        </body></html>
      `;
      mockFetch.mockResolvedValueOnce(createHtmlResponse(htmlWithId));

      const result = await webScrape.execute(
        { url: 'https://example.com', selector: '#target' },
        ctx
      );
      const content = (result as { content: string }).content;

      expect(content).toContain('Target content');
    });

    it('returns error when selector not found', async () => {
      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));

      const result = await webScrape.execute(
        { url: 'https://example.com', selector: '.nonexistent' },
        ctx
      );

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('Selector ".nonexistent" not found');
    });
  });

  describe('content truncation', () => {
    it('truncates content to maxLength', async () => {
      const longContent = 'A'.repeat(1000);
      const html = `<html><body>${longContent}</body></html>`;
      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));

      const result = await webScrape.execute({ url: 'https://example.com', maxLength: 500 }, ctx);

      expect((result as { content: string }).content.length).toBe(500);
      expect((result as { truncated: boolean }).truncated).toBe(true);
    });

    it('does not truncate short content', async () => {
      const html = '<html><body>Short content</body></html>';
      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));

      const result = await webScrape.execute({ url: 'https://example.com', maxLength: 50000 }, ctx);

      expect((result as { truncated: boolean }).truncated).toBe(false);
    });
  });

  describe('link extraction', () => {
    it('extracts links when includeLinks is true', async () => {
      const html = `
        <html><body>
          <a href="https://example.com/page1">Page 1</a>
          <a href="/relative">Relative Link</a>
          <a href="#anchor">Anchor</a>
          <a href="javascript:void(0)">JS Link</a>
        </body></html>
      `;
      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));

      const result = await webScrape.execute(
        { url: 'https://example.com', includeLinks: true },
        ctx
      );

      const links = (result as { links: Array<{ text: string; href: string }> }).links;
      expect(links).toBeDefined();
      expect(links).toContainEqual({ text: 'Page 1', href: 'https://example.com/page1' });
      expect(links).toContainEqual({ text: 'Relative Link', href: 'https://example.com/relative' });
      expect(links.some((l) => l.href.includes('#anchor'))).toBe(false);
      expect(links.some((l) => l.href.includes('javascript'))).toBe(false);
    });

    it('drops script-capable links regardless of case', async () => {
      const html = `
        <html><body>
          <a href="JavaScript:alert(1)">Mixed case</a>
          <a href="data:text/html,<b>x</b>">Data</a>
          <a href=" vbscript:msgbox(1)">VB</a>
          <a href="mailto:team@example.com">Mail</a>
        </body></html>
      `;
      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));

      const result = await webScrape.execute(
        { url: 'https://example.com', includeLinks: true },
        ctx
      );

      const links = (result as { links: Array<{ text: string; href: string }> }).links;
      expect(links).toEqual([{ text: 'Mail', href: 'mailto:team@example.com' }]);
    });

    it('deduplicates links', async () => {
      const html = `
        <html><body>
          <a href="https://example.com/page">Link 1</a>
          <a href="https://example.com/page">Link 2</a>
        </body></html>
      `;
      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));

      const result = await webScrape.execute(
        { url: 'https://example.com', includeLinks: true },
        ctx
      );

      const links = (result as { links: Array<{ text: string; href: string }> }).links;
      const pageLinks = links.filter((l) => l.href === 'https://example.com/page');
      expect(pageLinks).toHaveLength(1);
    });
  });

  describe('image extraction', () => {
    it('extracts images when includeImages is true', async () => {
      const html = `
        <html><body>
          <img src="https://example.com/image1.jpg" alt="Image 1">
          <img src="/relative/image2.png" alt="Image 2">
          <img src="data:image/gif;base64,..." alt="Data URL">
        </body></html>
      `;
      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));

      const result = await webScrape.execute(
        { url: 'https://example.com', includeImages: true },
        ctx
      );

      const images = (result as { images: Array<{ src: string; alt: string }> }).images;
      expect(images).toBeDefined();
      expect(images).toContainEqual({ src: 'https://example.com/image1.jpg', alt: 'Image 1' });
      expect(images).toContainEqual({
        src: 'https://example.com/relative/image2.png',
        alt: 'Image 2',
      });
      expect(images.some((i) => i.src.startsWith('data:'))).toBe(false);
    });
  });

  describe('error handling', () => {
    it('handles HTTP errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Map(),
      });

      const result = await webScrape.execute({ url: 'https://example.com/missing' }, ctx);

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('HTTP 404');
    });

    it('handles non-HTML content', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
      });

      const result = await webScrape.execute({ url: 'https://example.com/api' }, ctx);

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('Not an HTML page');
    });

    it('handles network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await webScrape.execute({ url: 'https://example.com' }, ctx);

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('Network error');
    });

    it('handles timeout', async () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValueOnce(abortError);

      const result = await webScrape.execute({ url: 'https://example.com', timeout: 1000 }, ctx);

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('timed out');
    });

    it('honors the tool context abort signal', async () => {
      const controller = new AbortController();
      controller.abort();
      mockFetch.mockImplementationOnce((_url: string, init?: RequestInit) => {
        expect(init?.signal?.aborted).toBe(true);
        const error = new Error('Aborted');
        error.name = 'AbortError';
        return Promise.reject(error);
      });

      const result = await webScrape.execute(
        { url: 'https://example.com' },
        { ...ctx, signal: controller.signal }
      );

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('aborted');
    });
  });

  describe('HTML cleaning', () => {
    it('removes script and style tags', async () => {
      const html = `
        <html>
          <head>
            <style>body { color: red; }</style>
            <script>alert('hi');</script>
          </head>
          <body>
            <script>console.log('evil');</script>
            <p>Clean content</p>
          </body>
        </html>
      `;
      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));

      const result = await webScrape.execute({ url: 'https://example.com' }, ctx);
      const content = (result as { content: string }).content;

      expect(content).not.toContain('alert');
      expect(content).not.toContain('console.log');
      expect(content).not.toContain('color: red');
      expect(content).toContain('Clean content');
    });

    it('removes nav, footer, aside tags', async () => {
      const html = `
        <html><body>
          <nav>Navigation links</nav>
          <main>Main content</main>
          <footer>Footer info</footer>
          <aside>Sidebar</aside>
        </body></html>
      `;
      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));

      const result = await webScrape.execute({ url: 'https://example.com' }, ctx);
      const content = (result as { content: string }).content;

      expect(content).toContain('Main content');
      expect(content).not.toContain('Navigation links');
      expect(content).not.toContain('Footer info');
      expect(content).not.toContain('Sidebar');
    });

    it('decodes HTML entities', async () => {
      const html = '<html><body>&amp; &lt; &gt; &quot; &#39; &nbsp;</body></html>';
      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));

      const result = await webScrape.execute({ url: 'https://example.com' }, ctx);
      const content = (result as { content: string }).content;

      expect(content).toContain('&');
      expect(content).toContain('<');
      expect(content).toContain('>');
      expect(content).toContain('"');
      expect(content).toContain("'");
    });

    it('decodes each entity once, so escaped entities stay literal', async () => {
      const html = '<html><body><p>Write &amp;lt;b&amp;gt; for bold</p></body></html>';
      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));

      const text = await webScrape.execute({ url: 'https://example.com' }, ctx);
      expect((text as { content: string }).content).toBe('Write &lt;b&gt; for bold');

      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));
      const markdown = await webScrape.execute(
        { url: 'https://example.com', format: 'markdown' },
        ctx
      );
      expect((markdown as { content: string }).content).toBe('Write &lt;b&gt; for bold');
    });

    it('removes scripts whose closing tag carries whitespace or attributes', async () => {
      const html =
        '<html><body><script>alert(1)</script ><p>Kept</p><style >x{}</style foo="bar"></body></html>';
      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));

      const result = await webScrape.execute({ url: 'https://example.com' }, ctx);
      const content = (result as { content: string }).content;

      expect(content).toBe('Kept');
    });

    it('reads a tag broken by another tag the way a browser does', async () => {
      const html =
        '<html><body><p>Before</p><scr<script>x</script>ipt>alert(1)</script><p>After</p></body></html>';
      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));

      const result = await webScrape.execute({ url: 'https://example.com' }, ctx);

      expect((result as { content: string }).content).toBe('Before x ipt>alert(1) After');
    });

    it('reads script and style content as raw text up to their closing tag', async () => {
      const html =
        '<p>Start</p><script>if (a<b) { x = "</p>" }</script><style>a<b{}</style><p>End</p>';
      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));

      const result = await webScrape.execute({ url: 'https://example.com' }, ctx);

      expect((result as { content: string }).content).toBe('Start End');
    });

    it('hides a script that is never closed, as a browser does', async () => {
      const html = '<p>Visible</p><script>var hidden = 1; <p>still script</p>';
      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));

      const result = await webScrape.execute({ url: 'https://example.com' }, ctx);

      expect((result as { content: string }).content).toBe('Visible');
    });

    it('keeps a bare < in text and a > inside a quoted attribute in its tag', async () => {
      const html = '<p>if a < b and c > d</p><p title="x > y">Titled</p>';
      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));

      const result = await webScrape.execute({ url: 'https://example.com' }, ctx);

      expect((result as { content: string }).content).toBe('if a < b and c > d Titled');
    });

    /**
     * The CPU time this process spends scraping the HTML in both text and markdown, in ms.
     * CPU time and not the clock, so other test workers busy at the same time do not count.
     */
    async function scrapeOnce(html: string): Promise<number> {
      const started = process.cpuUsage();
      for (const format of ['text', 'markdown'] as const) {
        mockFetch.mockResolvedValueOnce(createHtmlResponse(html));
        await webScrape.execute(
          { url: 'https://example.com', format, includeLinks: true, includeImages: true },
          ctx
        );
      }
      const used = process.cpuUsage(started);
      return (used.user + used.system) / 1000;
    }

    /** How much longer four times the input takes: small and large runs alternate, best of five. */
    async function growth(build: (n: number) => string): Promise<number> {
      await scrapeOnce(build(500));
      let small = Infinity;
      let large = Infinity;
      for (let run = 0; run < 5; run++) {
        small = Math.min(small, await scrapeOnce(build(40_000)));
        large = Math.min(large, await scrapeOnce(build(160_000)));
      }
      return large / Math.max(small, 5);
    }

    it.each([
      ['unclosed tags', (n: number) => '<a'.repeat(n * 5)],
      ['unclosed scripts', (n: number) => '<script>'.repeat(n * 2)],
      ['unclosed headings and links', (n: number) => '<h1><a href="x">'.repeat(n)],
      ['unterminated quotes', (n: number) => '<a title="x '.repeat(n * 2)],
      ['unterminated comments', (n: number) => '<!--'.repeat(n * 3)],
      ['nested fragments', (n: number) => '<scr'.repeat(n) + 'x' + 'ipt>x</script>'.repeat(n)],
    ])('cleans hostile markup with %s in linear time', async (_name, build) => {
      expect(await growth(build)).toBeLessThan(10);
    });
  });

  describe('CSS selector with regex metacharacters', () => {
    it('does not throw regex errors on attribute selectors', async () => {
      const html = `
        <html><body>
          <div class="class" data-x="1">Target</div>
        </body></html>
      `;
      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));

      const result = await webScrape.execute(
        { url: 'https://example.com', selector: '.class[data-x]' },
        ctx
      );

      expect((result as { error?: string }).error).not.toContain('Invalid regular expression');
    });

    it('does not throw regex errors on adjacent sibling selectors', async () => {
      const html = `
        <html><body>
          <div class="test">Content</div>
          <p>Next</p>
        </body></html>
      `;
      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));

      const result = await webScrape.execute(
        { url: 'https://example.com', selector: 'div.test+p' },
        ctx
      );

      expect((result as { error?: string }).error).not.toContain('Invalid regular expression');
    });

    it('matches class with special regex chars via escapeRegex', async () => {
      const html = `
        <html><body>
          <div class="my-class$test">Escaped class</div>
        </body></html>
      `;
      mockFetch.mockResolvedValueOnce(createHtmlResponse(html));

      const result = await webScrape.execute(
        { url: 'https://example.com', selector: '.my-class$test' },
        ctx
      );

      const content = (result as { content?: string }).content;
      expect(content).toContain('Escaped class');
    });
  });

  describe('tool metadata', () => {
    it('has correct name and description', () => {
      expect(webScrape.name).toBe('web_scrape');
      expect(webScrape.description).toContain('Fetch and extract content');
    });

    it('generates valid JSON schema', () => {
      const schema = webScrape.toJSON();
      expect(schema.name).toBe('web_scrape');
      expect(schema.parameters.properties).toHaveProperty('url');
      expect(schema.parameters.properties).toHaveProperty('selector');
      expect(schema.parameters.properties).toHaveProperty('format');
    });
  });
});
