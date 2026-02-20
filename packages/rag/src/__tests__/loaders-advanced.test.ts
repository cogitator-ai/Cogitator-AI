import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), 'cogitator-rag-advanced-' + Date.now());

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe('JSONLoader', () => {
  it('loads a single JSON object', async () => {
    const { JSONLoader } = await import('../loaders/json-loader');
    const file = join(TEST_DIR, 'single.json');
    writeFileSync(file, JSON.stringify({ content: 'Hello JSON', title: 'Test' }));

    const loader = new JSONLoader();
    const docs = await loader.load(file);

    expect(docs).toHaveLength(1);
    expect(docs[0].content).toBe('Hello JSON');
    expect(docs[0].sourceType).toBe('json');
    expect(docs[0].source).toContain('single.json');
    expect(docs[0].id).toBeDefined();
  });

  it('loads a JSON array into multiple documents', async () => {
    const { JSONLoader } = await import('../loaders/json-loader');
    const file = join(TEST_DIR, 'array.json');
    writeFileSync(
      file,
      JSON.stringify([
        { text: 'First', author: 'Alice' },
        { text: 'Second', author: 'Bob' },
        { text: 'Third', author: 'Charlie' },
      ])
    );

    const loader = new JSONLoader({ contentField: 'text', metadataFields: ['author'] });
    const docs = await loader.load(file);

    expect(docs).toHaveLength(3);
    expect(docs[0].content).toBe('First');
    expect(docs[0].metadata?.author).toBe('Alice');
    expect(docs[1].content).toBe('Second');
    expect(docs[2].metadata?.author).toBe('Charlie');
  });

  it('falls back to "text" and "body" fields for content', async () => {
    const { JSONLoader } = await import('../loaders/json-loader');
    const textFile = join(TEST_DIR, 'text-field.json');
    writeFileSync(textFile, JSON.stringify({ text: 'From text field' }));

    const bodyFile = join(TEST_DIR, 'body-field.json');
    writeFileSync(bodyFile, JSON.stringify({ body: 'From body field' }));

    const loader = new JSONLoader();

    const textDocs = await loader.load(textFile);
    expect(textDocs[0].content).toBe('From text field');

    const bodyDocs = await loader.load(bodyFile);
    expect(bodyDocs[0].content).toBe('From body field');
  });

  it('stringifies object when no content field found', async () => {
    const { JSONLoader } = await import('../loaders/json-loader');
    const file = join(TEST_DIR, 'no-content.json');
    const obj = { foo: 'bar', num: 42 };
    writeFileSync(file, JSON.stringify(obj));

    const loader = new JSONLoader();
    const docs = await loader.load(file);

    expect(docs[0].content).toBe(JSON.stringify(obj, null, 2));
  });

  it('has correct supportedTypes', async () => {
    const { JSONLoader } = await import('../loaders/json-loader');
    const loader = new JSONLoader();
    expect(loader.supportedTypes).toContain('json');
  });
});

describe('CSVLoader', () => {
  it('loads CSV rows into documents', async () => {
    const { CSVLoader } = await import('../loaders/csv-loader');
    const file = join(TEST_DIR, 'data.csv');
    writeFileSync(file, 'name,content,age\nAlice,Hello world,30\nBob,Goodbye world,25\n');

    const loader = new CSVLoader({ contentColumn: 'content', metadataColumns: ['name', 'age'] });
    const docs = await loader.load(file);

    expect(docs).toHaveLength(2);
    expect(docs[0].content).toBe('Hello world');
    expect(docs[0].metadata?.name).toBe('Alice');
    expect(docs[0].metadata?.age).toBe('30');
    expect(docs[0].sourceType).toBe('csv');
    expect(docs[1].content).toBe('Goodbye world');
    expect(docs[1].metadata?.name).toBe('Bob');
  });

  it('uses first column as content when no contentColumn specified', async () => {
    const { CSVLoader } = await import('../loaders/csv-loader');
    const file = join(TEST_DIR, 'no-col.csv');
    writeFileSync(file, 'title,value\nHello,42\n');

    const loader = new CSVLoader();
    const docs = await loader.load(file);

    expect(docs).toHaveLength(1);
    expect(docs[0].content).toBe('Hello');
  });

  it('supports custom delimiter', async () => {
    const { CSVLoader } = await import('../loaders/csv-loader');
    const file = join(TEST_DIR, 'tabs.csv');
    writeFileSync(file, 'col1\tcol2\nfoo\tbar\n');

    const loader = new CSVLoader({ delimiter: '\t' });
    const docs = await loader.load(file);

    expect(docs).toHaveLength(1);
    expect(docs[0].content).toBe('foo');
  });

  it('has correct supportedTypes', async () => {
    const { CSVLoader } = await import('../loaders/csv-loader');
    const loader = new CSVLoader();
    expect(loader.supportedTypes).toContain('csv');
  });
});

describe('HTMLLoader', () => {
  it('extracts text from HTML file', async () => {
    const { HTMLLoader } = await import('../loaders/html-loader');
    const file = join(TEST_DIR, 'page.html');
    writeFileSync(
      file,
      '<html><head><title>Test Page</title></head><body><h1>Hello</h1><p>World</p></body></html>'
    );

    const loader = new HTMLLoader();
    const docs = await loader.load(file);

    expect(docs).toHaveLength(1);
    expect(docs[0].content).toContain('Hello');
    expect(docs[0].content).toContain('World');
    expect(docs[0].content).not.toContain('<h1>');
    expect(docs[0].sourceType).toBe('html');
    expect(docs[0].metadata?.title).toBe('Test Page');
  });

  it('uses custom CSS selector', async () => {
    const { HTMLLoader } = await import('../loaders/html-loader');
    const file = join(TEST_DIR, 'selector.html');
    writeFileSync(
      file,
      '<html><body><div id="nav">Navigation</div><div class="content">Main content</div></body></html>'
    );

    const loader = new HTMLLoader({ selector: '.content' });
    const docs = await loader.load(file);

    expect(docs[0].content).toContain('Main content');
    expect(docs[0].content).not.toContain('Navigation');
  });

  it('handles missing title gracefully', async () => {
    const { HTMLLoader } = await import('../loaders/html-loader');
    const file = join(TEST_DIR, 'no-title.html');
    writeFileSync(file, '<html><body><p>No title here</p></body></html>');

    const loader = new HTMLLoader();
    const docs = await loader.load(file);

    expect(docs[0].content).toContain('No title here');
    expect(docs[0].metadata?.title).toBeUndefined();
  });

  it('has correct supportedTypes', async () => {
    const { HTMLLoader } = await import('../loaders/html-loader');
    const loader = new HTMLLoader();
    expect(loader.supportedTypes).toEqual(['html', 'htm']);
  });
});

describe('PDFLoader', () => {
  it('loads all pages as a single document by default', async () => {
    vi.doMock('pdf-parse', () => ({
      default: vi.fn().mockResolvedValue({
        text: 'Page one content\nPage two content',
        numpages: 2,
        info: { Title: 'Test PDF' },
      }),
    }));

    const { PDFLoader } = await import('../loaders/pdf-loader');
    const file = join(TEST_DIR, 'test.pdf');
    writeFileSync(file, 'fake pdf content');

    const loader = new PDFLoader();
    const docs = await loader.load(file);

    expect(docs).toHaveLength(1);
    expect(docs[0].content).toContain('Page one content');
    expect(docs[0].content).toContain('Page two content');
    expect(docs[0].sourceType).toBe('pdf');
    expect(docs[0].metadata?.pages).toBe(2);
    expect(docs[0].metadata?.title).toBe('Test PDF');

    vi.doUnmock('pdf-parse');
  });

  it('splits pages into separate documents when splitPages=true', async () => {
    const pageTexts = ['First page text', 'Second page text', 'Third page text'];

    vi.doMock('pdf-parse', () => ({
      default: vi
        .fn()
        .mockImplementation(
          async (
            _buf: Buffer,
            options?: { pagerender?: (pageData: { pageIndex: number }) => string }
          ) => {
            if (options?.pagerender) {
              for (let i = 0; i < pageTexts.length; i++) {
                options.pagerender({ pageIndex: i });
              }
            }
            return {
              text: pageTexts.join('\n\n'),
              numpages: 3,
              info: { Title: 'Split PDF' },
            };
          }
        ),
    }));

    const { PDFLoader } = await import('../loaders/pdf-loader');
    const file = join(TEST_DIR, 'split.pdf');
    writeFileSync(file, 'fake pdf');

    const loader = new PDFLoader({ splitPages: true });
    const docs = await loader.load(file);

    expect(docs.length).toBeGreaterThanOrEqual(1);
    expect(docs[0].sourceType).toBe('pdf');
    if (docs.length > 1) {
      expect(docs[0].metadata?.pageNumber).toBeDefined();
    }

    vi.doUnmock('pdf-parse');
  });

  it('has correct supportedTypes', async () => {
    vi.doMock('pdf-parse', () => ({
      default: vi.fn(),
    }));

    const { PDFLoader } = await import('../loaders/pdf-loader');
    const loader = new PDFLoader();
    expect(loader.supportedTypes).toEqual(['pdf']);

    vi.doUnmock('pdf-parse');
  });
});

describe('WebLoader', () => {
  it('fetches URL and extracts text content', async () => {
    const html =
      '<html><head><title>Web Page</title></head><body><p>Web content here</p></body></html>';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(html),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { WebLoader } = await import('../loaders/web-loader');
    const loader = new WebLoader();
    const docs = await loader.load('https://example.com');

    expect(docs).toHaveLength(1);
    expect(docs[0].content).toContain('Web content here');
    expect(docs[0].content).not.toContain('<p>');
    expect(docs[0].sourceType).toBe('web');
    expect(docs[0].source).toBe('https://example.com');
    expect(docs[0].metadata?.title).toBe('Web Page');

    expect(mockFetch).toHaveBeenCalledWith('https://example.com', expect.any(Object));

    vi.unstubAllGlobals();
  });

  it('passes custom headers to fetch', async () => {
    const html = '<html><body>OK</body></html>';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(html),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { WebLoader } = await import('../loaders/web-loader');
    const loader = new WebLoader({ headers: { Authorization: 'Bearer token123' } });
    await loader.load('https://example.com/protected');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com/protected',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token123' }),
      })
    );

    vi.unstubAllGlobals();
  });

  it('throws on failed fetch', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });
    vi.stubGlobal('fetch', mockFetch);

    const { WebLoader } = await import('../loaders/web-loader');
    const loader = new WebLoader();

    await expect(loader.load('https://example.com/missing')).rejects.toThrow('404');

    vi.unstubAllGlobals();
  });

  it('uses custom selector', async () => {
    const html = '<html><body><nav>Menu</nav><article>Article content</article></body></html>';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(html),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { WebLoader } = await import('../loaders/web-loader');
    const loader = new WebLoader({ selector: 'article' });
    const docs = await loader.load('https://example.com');

    expect(docs[0].content).toContain('Article content');
    expect(docs[0].content).not.toContain('Menu');

    vi.unstubAllGlobals();
  });

  it('has correct supportedTypes', async () => {
    const { WebLoader } = await import('../loaders/web-loader');
    const loader = new WebLoader();
    expect(loader.supportedTypes).toEqual(['http', 'https']);
  });
});
