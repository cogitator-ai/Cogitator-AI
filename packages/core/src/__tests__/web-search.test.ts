import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWebSearchTool, toPublishedAt, webSearch } from '../tools/web-search';

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

    it('sends the Tavily key as a bearer token, not in the request body', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'test-tavily-key');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const result = await webSearch.execute({ query: 'test' }, ctx);

      const init = mockFetch.mock.calls[0][1] as RequestInit;
      expect(init.headers).toMatchObject({ Authorization: 'Bearer test-tavily-key' });
      expect(String(init.body)).not.toContain('test-tavily-key');
      expect(result).toMatchObject({ provider: 'tavily', results: [] });
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

  describe('news, recency and domain filters', () => {
    const okJson = (body: unknown) => ({ ok: true, json: async () => body });

    it('sends Tavily its own topic, time range and domain parameters', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'k');
      mockFetch.mockResolvedValueOnce(
        okJson({
          results: [
            {
              title: 'T',
              url: 'https://reuters.com/a',
              content: 'c',
              published_date: 'Fri, 03 Oct 2026 14:00:00 GMT',
            },
          ],
        })
      );

      const result = await webSearch.execute(
        {
          query: 'EU AI Act',
          topic: 'news',
          recency: 'week',
          includeDomains: ['reuters.com', 'apnews.com'],
          excludeDomains: ['msn.com'],
        },
        ctx
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toMatchObject({
        query: 'EU AI Act',
        topic: 'news',
        time_range: 'week',
        include_domains: ['reuters.com', 'apnews.com'],
        exclude_domains: ['msn.com'],
        include_published_date: true,
      });
      expect(result).toMatchObject({
        results: [{ url: 'https://reuters.com/a', publishedAt: '2026-10-03T14:00:00.000Z' }],
      });
    });

    it('leaves optional Tavily filters out of a plain search', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'k');
      mockFetch.mockResolvedValueOnce(okJson({ results: [] }));

      await webSearch.execute({ query: 'plain' }, ctx);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.topic).toBe('general');
      expect(body).not.toHaveProperty('time_range');
      expect(body).not.toHaveProperty('include_domains');
      expect(body).not.toHaveProperty('exclude_domains');
    });

    it('uses the Brave news endpoint with freshness and site operators', async () => {
      vi.stubEnv('BRAVE_API_KEY', 'k');
      mockFetch.mockResolvedValueOnce(
        okJson({
          type: 'news',
          results: [
            {
              title: 'B',
              url: 'https://apnews.com/b',
              description: 'd',
              age: '2 hours ago',
              page_age: '2026-10-04T10:30:00',
            },
          ],
        })
      );

      const result = await webSearch.execute(
        {
          query: 'quake',
          provider: 'brave',
          topic: 'news',
          recency: 'day',
          includeDomains: ['apnews.com', 'reuters.com'],
          excludeDomains: ['msn.com'],
        },
        ctx
      );

      const url = new URL(mockFetch.mock.calls[0][0] as string);
      expect(url.pathname).toBe('/res/v1/news/search');
      expect(url.searchParams.get('freshness')).toBe('pd');
      expect(url.searchParams.get('q')).toBe(
        'quake (site:apnews.com OR site:reuters.com) -site:msn.com'
      );
      expect(result).toMatchObject({
        query: 'quake',
        results: [{ url: 'https://apnews.com/b', publishedAt: '2026-10-04T10:30:00.000Z' }],
      });
    });

    it('uses the Serper news endpoint with a time filter and resolves relative dates', async () => {
      vi.stubEnv('SERPER_API_KEY', 'k');
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
      try {
        mockFetch.mockResolvedValueOnce(
          okJson({
            news: [
              {
                title: 'S',
                link: 'https://bbc.co.uk/s',
                snippet: 's',
                date: '3 hours ago',
                source: 'BBC',
              },
            ],
          })
        );

        const result = await webSearch.execute(
          {
            query: 'launch',
            provider: 'serper',
            topic: 'news',
            recency: 'month',
            includeDomains: ['bbc.co.uk'],
          },
          ctx
        );

        expect(mockFetch.mock.calls[0][0]).toBe('https://google.serper.dev/news');
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body).toMatchObject({ q: 'launch site:bbc.co.uk', tbs: 'qdr:m' });
        expect(result).toMatchObject({
          query: 'launch',
          results: [
            {
              url: 'https://bbc.co.uk/s',
              source: 'BBC',
              publishedAt: '2026-10-04T09:00:00.000Z',
            },
          ],
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('refuses domains that are not bare domains', () => {
      const parse = (domains: string[]) =>
        webSearch.parameters.safeParse({ query: 'q', includeDomains: domains }).success;
      expect(parse(['reuters.com', 'news.bbc.co.uk'])).toBe(true);
      expect(parse(['https://reuters.com'])).toBe(false);
      expect(parse(['reuters.com/world'])).toBe(false);
      expect(parse(['site:reuters.com OR x'])).toBe(false);
    });
  });

  describe('createWebSearchTool', () => {
    it('uses a key passed in options over the environment', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'env-key');
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });

      const search = createWebSearchTool({ apiKeys: { tavily: 'option-key' } });
      await search.execute({ query: 'q' }, ctx);

      const init = mockFetch.mock.calls[0][1] as RequestInit;
      expect(init.headers).toMatchObject({ Authorization: 'Bearer option-key' });
    });

    it('defaults to the configured provider when a call names none', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'tavily-key');
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ organic: [] }) });

      const search = createWebSearchTool({ provider: 'serper', apiKeys: { serper: 's' } });
      const result = await search.execute({ query: 'q' }, ctx);

      expect(mockFetch.mock.calls[0][0]).toBe('https://google.serper.dev/search');
      expect(result).toMatchObject({ provider: 'serper' });
    });

    it('reports a missing key for the configured provider', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'tavily-key');
      const search = createWebSearchTool({ provider: 'brave' });
      const result = await search.execute({ query: 'q' }, ctx);
      expect((result as { error: string }).error).toContain('BRAVE_API_KEY');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('toPublishedAt', () => {
    const now = Date.parse('2026-10-04T12:00:00Z');

    it('reads absolute dates, a zoneless timestamp as UTC', () => {
      expect(toPublishedAt('2026-10-04T10:30:00', now)).toBe('2026-10-04T10:30:00.000Z');
      expect(toPublishedAt('2026-10-04T10:30:00+02:00', now)).toBe('2026-10-04T08:30:00.000Z');
      expect(toPublishedAt('Fri, 03 Oct 2026 14:00:00 GMT', now)).toBe('2026-10-03T14:00:00.000Z');
    });

    it('resolves relative dates against now', () => {
      expect(toPublishedAt('3 hours ago', now)).toBe('2026-10-04T09:00:00.000Z');
      expect(toPublishedAt('a day ago', now)).toBe('2026-10-03T12:00:00.000Z');
      expect(toPublishedAt('1 week ago', now)).toBe('2026-09-27T12:00:00.000Z');
    });

    it('drops what it cannot read instead of guessing', () => {
      expect(toPublishedAt('recently', now)).toBeUndefined();
      expect(toPublishedAt('', now)).toBeUndefined();
      expect(toPublishedAt(null, now)).toBeUndefined();
      expect(toPublishedAt(42, now)).toBeUndefined();
    });
  });

  describe('country, language, date range and paging', () => {
    const okJson = (body: unknown) => ({ ok: true, json: async () => body });

    it('maps country and language to Tavily names and asks for raw content', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'k');
      mockFetch.mockResolvedValueOnce(
        okJson({
          results: [{ title: 'T', url: 'https://a.cz', content: 'c', raw_content: '# Full page' }],
        })
      );

      const result = await webSearch.execute(
        {
          query: 'q',
          country: 'cz',
          language: 'CS',
          dateRange: { from: '2026-09-01', to: '2026-09-30' },
          includeRawContent: true,
          searchDepth: 'fast',
        },
        ctx
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toMatchObject({
        country: 'czech republic',
        language: 'cs',
        start_date: '2026-09-01',
        end_date: '2026-09-30',
        include_raw_content: 'markdown',
        search_depth: 'fast',
      });
      expect(result).toMatchObject({ results: [{ content: '# Full page' }] });
    });

    it('ends an open date range today', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'k');
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
      try {
        mockFetch.mockResolvedValueOnce(okJson({ results: [] }));
        await webSearch.execute({ query: 'q', dateRange: { from: '2026-09-01' } }, ctx);
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body).toMatchObject({ start_date: '2026-09-01', end_date: '2026-10-04' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('refuses what Tavily cannot do instead of dropping it', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'k');
      const errorOf = async (args: Parameters<typeof webSearch.execute>[0]) =>
        ((await webSearch.execute(args, ctx)) as { error?: string }).error;

      expect(await errorOf({ query: 'q', page: 2 })).toContain('one page');
      expect(await errorOf({ query: 'q', topic: 'news', country: 'us' })).toContain('general');
      expect(await errorOf({ query: 'q', country: 'aq' })).toContain('"aq"');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('refuses recency together with a date range, and a range that ends before it starts', async () => {
      vi.stubEnv('BRAVE_API_KEY', 'k');
      const both = await webSearch.execute(
        { query: 'q', recency: 'week', dateRange: { from: '2026-09-01' } },
        ctx
      );
      expect((both as { error: string }).error).toContain('not both');

      const backwards = await webSearch.execute(
        { query: 'q', dateRange: { from: '2026-09-30', to: '2026-09-01' } },
        ctx
      );
      expect((backwards as { error: string }).error).toContain('starts after it ends');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('sends Brave country, language, a date range and the page offset', async () => {
      vi.stubEnv('BRAVE_API_KEY', 'k');
      mockFetch.mockResolvedValueOnce(okJson({ web: { results: [] } }));

      await webSearch.execute(
        {
          query: 'q',
          provider: 'brave',
          country: 'de',
          language: 'de',
          dateRange: { from: '2026-09-01', to: '2026-09-30' },
          page: 3,
        },
        ctx
      );

      const url = new URL(mockFetch.mock.calls[0][0] as string);
      expect(url.searchParams.get('country')).toBe('DE');
      expect(url.searchParams.get('search_lang')).toBe('de');
      expect(url.searchParams.get('freshness')).toBe('2026-09-01to2026-09-30');
      expect(url.searchParams.get('offset')).toBe('2');
    });

    it('sends Serper gl, hl, a custom date range and the page', async () => {
      vi.stubEnv('SERPER_API_KEY', 'k');
      mockFetch.mockResolvedValueOnce(okJson({ organic: [] }));

      await webSearch.execute(
        {
          query: 'q',
          provider: 'serper',
          country: 'FR',
          language: 'fr',
          dateRange: { from: '2026-09-01', to: '2026-09-30' },
          page: 2,
        },
        ctx
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toMatchObject({
        gl: 'fr',
        hl: 'fr',
        page: 2,
        tbs: 'cdr:1,cd_min:9/1/2026,cd_max:9/30/2026',
      });
    });

    it('validates dates, country and language codes', () => {
      const ok = (args: Record<string, unknown>) =>
        webSearch.parameters.safeParse({ query: 'q', ...args }).success;
      expect(ok({ dateRange: { from: '2026-09-01' } })).toBe(true);
      expect(ok({ dateRange: { from: '2026-13-01' } })).toBe(false);
      expect(ok({ dateRange: { from: '1 Sep 2026' } })).toBe(false);
      expect(ok({ country: 'usa' })).toBe(false);
      expect(ok({ language: 'pt-br' })).toBe(true);
      expect(ok({ language: 'english' })).toBe(false);
    });
  });
});
