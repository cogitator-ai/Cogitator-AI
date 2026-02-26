import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserSession } from '../session';
import {
  createGetTextTool,
  createGetHtmlTool,
  createGetAttributeTool,
  createGetLinksTool,
  createQuerySelectorAllTool,
  createExtractTableTool,
  createExtractStructuredTool,
  createExtractionTools,
} from '../tools/extraction';

function createMockSession() {
  const mockPage = {
    textContent: vi.fn().mockResolvedValue('Hello World'),
    innerHTML: vi.fn().mockResolvedValue('<p>Hello</p>'),
    content: vi.fn().mockResolvedValue('<html><body><p>Hello</p></body></html>'),
    getAttribute: vi.fn().mockResolvedValue('test-value'),
    evaluate: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue('https://example.com'),
    title: vi.fn().mockResolvedValue('Example'),
    locator: vi.fn().mockReturnValue({
      evaluate: vi.fn().mockResolvedValue('<div>outer</div>'),
    }),
  };
  const session = { page: mockPage } as unknown as BrowserSession;
  return { session, mockPage };
}

const dummyContext = {
  agentId: 'test',
  runId: 'test-run',
  signal: new AbortController().signal,
};

describe('extraction tools', () => {
  let session: BrowserSession;
  let mockPage: ReturnType<typeof createMockSession>['mockPage'];

  beforeEach(() => {
    const mock = createMockSession();
    session = mock.session;
    mockPage = mock.mockPage;
  });

  describe('createGetTextTool', () => {
    it('has correct shape', () => {
      const t = createGetTextTool(session);

      expect(t.name).toBe('browser_get_text');
      expect(t.description).toBeTruthy();
      expect(t.category).toBe('web');
      expect(t.tags).toContain('browser');
      expect(t.tags).toContain('extraction');
      expect(typeof t.execute).toBe('function');
      expect(typeof t.toJSON).toBe('function');
    });

    it('serializes to JSON schema', () => {
      const t = createGetTextTool(session);
      const json = t.toJSON();

      expect(json.name).toBe('browser_get_text');
      expect(json.parameters.type).toBe('object');
    });

    it('extracts text from selector', async () => {
      const t = createGetTextTool(session);
      const result = await t.execute({ selector: '.content' }, dummyContext);

      expect(mockPage.textContent).toHaveBeenCalledWith('.content');
      expect(result).toEqual({ text: 'Hello World' });
    });

    it('extracts body innerText when no selector', async () => {
      mockPage.evaluate.mockResolvedValueOnce('Full page text');
      const t = createGetTextTool(session);
      const result = await t.execute({}, dummyContext);

      expect(mockPage.evaluate).toHaveBeenCalled();
      expect(result).toEqual({ text: 'Full page text' });
    });

    it('returns empty string when textContent is null', async () => {
      mockPage.textContent.mockResolvedValueOnce(null);
      const t = createGetTextTool(session);
      const result = await t.execute({ selector: '.missing' }, dummyContext);

      expect(result).toEqual({ text: '' });
    });
  });

  describe('createGetHtmlTool', () => {
    it('has correct shape', () => {
      const t = createGetHtmlTool(session);

      expect(t.name).toBe('browser_get_html');
      expect(t.category).toBe('web');
      expect(t.tags).toContain('extraction');
    });

    it('returns innerHTML for selector', async () => {
      const t = createGetHtmlTool(session);
      const result = await t.execute({ selector: '.content' }, dummyContext);

      expect(mockPage.innerHTML).toHaveBeenCalledWith('.content');
      expect(result).toEqual({ html: '<p>Hello</p>' });
    });

    it('returns outerHTML when outer=true', async () => {
      const t = createGetHtmlTool(session);
      const result = await t.execute({ selector: '.content', outer: true }, dummyContext);

      expect(mockPage.locator).toHaveBeenCalledWith('.content');
      expect(result).toEqual({ html: '<div>outer</div>' });
    });

    it('returns full page content when no selector', async () => {
      const t = createGetHtmlTool(session);
      const result = await t.execute({}, dummyContext);

      expect(mockPage.content).toHaveBeenCalled();
      expect(result).toEqual({ html: '<html><body><p>Hello</p></body></html>' });
    });
  });

  describe('createGetAttributeTool', () => {
    it('has correct shape', () => {
      const t = createGetAttributeTool(session);

      expect(t.name).toBe('browser_get_attribute');
      expect(t.category).toBe('web');
    });

    it('gets attribute value', async () => {
      const t = createGetAttributeTool(session);
      const result = await t.execute({ selector: 'a.link', attribute: 'href' }, dummyContext);

      expect(mockPage.getAttribute).toHaveBeenCalledWith('a.link', 'href');
      expect(result).toEqual({ value: 'test-value' });
    });

    it('returns null for missing attribute', async () => {
      mockPage.getAttribute.mockResolvedValueOnce(null);
      const t = createGetAttributeTool(session);
      const result = await t.execute({ selector: 'div', attribute: 'data-missing' }, dummyContext);

      expect(result).toEqual({ value: null });
    });
  });

  describe('createGetLinksTool', () => {
    it('has correct shape', () => {
      const t = createGetLinksTool(session);

      expect(t.name).toBe('browser_get_links');
      expect(t.category).toBe('web');
    });

    it('extracts links from page', async () => {
      const mockLinks = [
        { text: 'Home', href: '/', title: undefined },
        { text: 'About', href: '/about', title: 'About us' },
      ];
      mockPage.evaluate.mockResolvedValueOnce(mockLinks);

      const t = createGetLinksTool(session);
      const result = await t.execute({}, dummyContext);

      expect(mockPage.evaluate).toHaveBeenCalled();
      expect(result).toEqual({ links: mockLinks });
    });

    it('passes selector and baseUrl to evaluate', async () => {
      mockPage.evaluate.mockResolvedValueOnce([]);

      const t = createGetLinksTool(session);
      await t.execute({ selector: 'nav', baseUrl: 'https://example.com' }, dummyContext);

      expect(mockPage.evaluate).toHaveBeenCalledWith(expect.any(Function), {
        selector: 'nav',
        baseUrl: 'https://example.com',
      });
    });

    it('returns empty array when no links found', async () => {
      mockPage.evaluate.mockResolvedValueOnce([]);

      const t = createGetLinksTool(session);
      const result = await t.execute({}, dummyContext);

      expect(result).toEqual({ links: [] });
    });
  });

  describe('createQuerySelectorAllTool', () => {
    it('has correct shape', () => {
      const t = createQuerySelectorAllTool(session);

      expect(t.name).toBe('browser_query_selector_all');
      expect(t.category).toBe('web');
    });

    it('queries elements', async () => {
      const mockElements = [
        { tag: 'div', text: 'Hello', attributes: { id: 'main' }, visible: true },
      ];
      mockPage.evaluate.mockResolvedValueOnce(mockElements);

      const t = createQuerySelectorAllTool(session);
      const result = await t.execute({ selector: 'div' }, dummyContext);

      expect(result).toEqual({ elements: mockElements });
    });

    it('passes attributes and limit', async () => {
      mockPage.evaluate.mockResolvedValueOnce([]);

      const t = createQuerySelectorAllTool(session);
      await t.execute({ selector: 'img', attributes: ['src', 'alt'], limit: 5 }, dummyContext);

      expect(mockPage.evaluate).toHaveBeenCalledWith(expect.any(Function), {
        selector: 'img',
        attributes: ['src', 'alt'],
        limit: 5,
      });
    });

    it('returns empty array when nothing matches', async () => {
      mockPage.evaluate.mockResolvedValueOnce([]);

      const t = createQuerySelectorAllTool(session);
      const result = await t.execute({ selector: '.nonexistent' }, dummyContext);

      expect(result).toEqual({ elements: [] });
    });
  });

  describe('createExtractTableTool', () => {
    it('has correct shape', () => {
      const t = createExtractTableTool(session);

      expect(t.name).toBe('browser_extract_table');
      expect(t.category).toBe('web');
    });

    it('extracts table data', async () => {
      const mockData = {
        headers: ['Name', 'Age'],
        rows: [
          ['Alice', '30'],
          ['Bob', '25'],
        ],
      };
      mockPage.evaluate.mockResolvedValueOnce(mockData);

      const t = createExtractTableTool(session);
      const result = await t.execute({}, dummyContext);

      expect(result).toEqual(mockData);
    });

    it('passes selector to evaluate', async () => {
      mockPage.evaluate.mockResolvedValueOnce({ headers: [], rows: [] });

      const t = createExtractTableTool(session);
      await t.execute({ selector: '#data-table' }, dummyContext);

      expect(mockPage.evaluate).toHaveBeenCalledWith(expect.any(Function), '#data-table');
    });

    it('returns empty headers and rows when no table found', async () => {
      mockPage.evaluate.mockResolvedValueOnce({ headers: [], rows: [] });

      const t = createExtractTableTool(session);
      const result = await t.execute({}, dummyContext);

      expect(result).toEqual({ headers: [], rows: [] });
    });
  });

  describe('createExtractStructuredTool', () => {
    it('has correct shape', () => {
      const t = createExtractStructuredTool(session);

      expect(t.name).toBe('browser_extract_structured');
      expect(t.category).toBe('web');
    });

    it('extracts structured text from page', async () => {
      mockPage.evaluate.mockResolvedValueOnce('Clean page text without scripts');

      const t = createExtractStructuredTool(session);
      const result = await t.execute({ instruction: 'Extract product prices' }, dummyContext);

      expect(result).toEqual({
        instruction: 'Extract product prices',
        text: 'Clean page text without scripts',
        url: 'https://example.com',
        title: 'Example',
      });
    });

    it('passes selector to evaluate', async () => {
      mockPage.evaluate.mockResolvedValueOnce('Scoped text');

      const t = createExtractStructuredTool(session);
      await t.execute({ instruction: 'Get content', selector: '#article' }, dummyContext);

      expect(mockPage.evaluate).toHaveBeenCalledWith(expect.any(Function), '#article');
    });

    it('returns empty text when scope not found', async () => {
      mockPage.evaluate.mockResolvedValueOnce('');

      const t = createExtractStructuredTool(session);
      const result = await t.execute({ instruction: 'Extract data' }, dummyContext);

      expect(result.text).toBe('');
    });
  });

  describe('createExtractionTools', () => {
    it('returns all 7 tools', () => {
      const tools = createExtractionTools(session);
      expect(tools).toHaveLength(7);
    });

    it('all tools have unique names', () => {
      const tools = createExtractionTools(session);
      const names = tools.map((t) => t.name);
      expect(new Set(names).size).toBe(7);
    });

    it('all tools have web category', () => {
      const tools = createExtractionTools(session);
      for (const t of tools) {
        expect(t.category).toBe('web');
      }
    });

    it('all tools serialize to JSON', () => {
      const tools = createExtractionTools(session);
      for (const t of tools) {
        const json = t.toJSON();
        expect(json.name).toBe(t.name);
        expect(json.parameters.type).toBe('object');
      }
    });
  });
});
