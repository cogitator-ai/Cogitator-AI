import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webSearch } from '../tools/web-search';

const mockFetch = vi.fn();

describe('web_search tool', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    vi.stubEnv('TAVILY_API_KEY', '');
    vi.stubEnv('BRAVE_API_KEY', '');
    vi.stubEnv('SERPER_API_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const ctx = { agentId: 'test', runId: 'run1', signal: new AbortController().signal };

  describe('provider detection', () => {
    it('returns error when no API key is set', async () => {
      const result = await webSearch.execute({ query: 'test' }, ctx);
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('No search API key found');
    });

    it('auto-detects Tavily when TAVILY_API_KEY is set', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'test-tavily-key');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [], answer: null }),
      });

      await webSearch.execute({ query: 'test' }, ctx);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.tavily.com/search',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('auto-detects Brave when BRAVE_API_KEY is set', async () => {
      vi.stubEnv('BRAVE_API_KEY', 'test-brave-key');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ web: { results: [] } }),
      });

      await webSearch.execute({ query: 'test' }, ctx);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('api.search.brave.com'),
        expect.any(Object)
      );
    });

    it('auto-detects Serper when SERPER_API_KEY is set', async () => {
      vi.stubEnv('SERPER_API_KEY', 'test-serper-key');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ organic: [] }),
      });

      await webSearch.execute({ query: 'test' }, ctx);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://google.serper.dev/search',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  describe('Tavily provider', () => {
    beforeEach(() => {
      vi.stubEnv('TAVILY_API_KEY', 'test-tavily-key');
    });

    it('searches and returns results', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            { title: 'Result 1', url: 'https://example.com/1', content: 'Snippet 1', score: 0.9 },
            { title: 'Result 2', url: 'https://example.com/2', content: 'Snippet 2', score: 0.8 },
          ],
          answer: 'AI generated answer',
        }),
      });

      const result = await webSearch.execute(
        { query: 'test query', maxResults: 5, includeAnswer: true },
        ctx
      );

      expect(result).toMatchObject({
        query: 'test query',
        provider: 'tavily',
        results: [
          { title: 'Result 1', url: 'https://example.com/1', snippet: 'Snippet 1', score: 0.9 },
          { title: 'Result 2', url: 'https://example.com/2', snippet: 'Snippet 2', score: 0.8 },
        ],
        answer: 'AI generated answer',
      });
    });

    it('passes search depth option', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [] }),
      });

      await webSearch.execute({ query: 'test', searchDepth: 'advanced' }, ctx);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.search_depth).toBe('advanced');
    });

    it('handles API errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const result = await webSearch.execute({ query: 'test' }, ctx);
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('Tavily API error');
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

      const result = await webSearch.execute(
        { query: 'test' },
        { ...ctx, signal: controller.signal }
      );

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('aborted');
    });
  });

  describe('Brave provider', () => {
    beforeEach(() => {
      vi.stubEnv('BRAVE_API_KEY', 'test-brave-key');
    });

    it('searches and returns results', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          web: {
            results: [
              { title: 'Brave Result', url: 'https://brave.com/1', description: 'Brave snippet' },
            ],
          },
        }),
      });

      const result = await webSearch.execute({ query: 'brave test', provider: 'brave' }, ctx);

      expect(result).toMatchObject({
        query: 'brave test',
        provider: 'brave',
        results: [{ title: 'Brave Result', url: 'https://brave.com/1', snippet: 'Brave snippet' }],
      });
    });

    it('includes API key in header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ web: { results: [] } }),
      });

      await webSearch.execute({ query: 'test', provider: 'brave' }, ctx);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Subscription-Token': 'test-brave-key',
          }),
        })
      );
    });

    it('handles missing web results', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const result = await webSearch.execute({ query: 'test', provider: 'brave' }, ctx);
      expect((result as { results: unknown[] }).results).toEqual([]);
    });
  });

  describe('Serper provider', () => {
    beforeEach(() => {
      vi.stubEnv('SERPER_API_KEY', 'test-serper-key');
    });

    it('searches and returns results', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          organic: [
            { title: 'Serper Result', link: 'https://serper.dev/1', snippet: 'Serper text' },
          ],
          answerBox: { answer: 'Direct answer' },
        }),
      });

      const result = await webSearch.execute({ query: 'serper test', provider: 'serper' }, ctx);

      expect(result).toMatchObject({
        query: 'serper test',
        provider: 'serper',
        results: [{ title: 'Serper Result', url: 'https://serper.dev/1', snippet: 'Serper text' }],
        answer: 'Direct answer',
      });
    });

    it('includes API key in header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ organic: [] }),
      });

      await webSearch.execute({ query: 'test', provider: 'serper' }, ctx);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-API-KEY': 'test-serper-key',
          }),
        })
      );
    });
  });

  describe('explicit provider selection', () => {
    it('returns error when specified provider key is missing', async () => {
      const result = await webSearch.execute({ query: 'test', provider: 'tavily' }, ctx);
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('API key not found for tavily');
    });

    it('uses specified provider even when others are available', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'tavily-key');
      vi.stubEnv('BRAVE_API_KEY', 'brave-key');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ web: { results: [] } }),
      });

      const result = await webSearch.execute({ query: 'test', provider: 'brave' }, ctx);
      expect((result as { provider: string }).provider).toBe('brave');
    });
  });

  describe('tool metadata', () => {
    it('has correct name and description', () => {
      expect(webSearch.name).toBe('web_search');
      expect(webSearch.description).toContain('Search the web');
    });

    it('generates valid JSON schema', () => {
      const schema = webSearch.toJSON();
      expect(schema.name).toBe('web_search');
      expect(schema.parameters.type).toBe('object');
      expect(schema.parameters.properties).toHaveProperty('query');
      expect(schema.parameters.properties).toHaveProperty('provider');
      expect(schema.parameters.properties).toHaveProperty('maxResults');
    });
  });
});
