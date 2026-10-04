import { z } from 'zod';
import { tool } from '../tool';
import { createLinkedAbortController, getAbortErrorMessage } from '../utils/abort';
import { readEnv } from '../utils/env';
import { TAVILY_COUNTRIES } from './search-countries';

const SEARCH_TIMEOUT_MS = 30_000;

export type SearchProvider = 'tavily' | 'brave' | 'serper';
export type SearchTopic = 'general' | 'news';
export type SearchRecency = 'day' | 'week' | 'month' | 'year';
export type SearchDepth = 'ultra-fast' | 'fast' | 'basic' | 'advanced';

const PROVIDERS: readonly SearchProvider[] = ['tavily', 'brave', 'serper'];

const KEY_ENV: Record<SearchProvider, string> = {
  tavily: 'TAVILY_API_KEY',
  brave: 'BRAVE_API_KEY',
  serper: 'SERPER_API_KEY',
};

const domain = z
  .string()
  .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i, 'a bare domain such as "reuters.com"')
  .describe('A bare domain such as "reuters.com", its subdomains match too');

const webSearchParams = z.object({
  query: z.string().min(1).describe('Search query'),
  provider: z
    .enum(['tavily', 'brave', 'serper'])
    .optional()
    .describe('Search provider (default: auto-detect from available API keys)'),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('Maximum number of results (default: 5, max: 20)'),
  page: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Page of results (default: 1, Brave and Serper only)'),
  topic: z
    .enum(['general', 'news'])
    .optional()
    .describe('"news" searches news articles only (default: general)'),
  recency: z
    .enum(['day', 'week', 'month', 'year'])
    .optional()
    .describe('Only results published within the last day, week, month or year'),
  dateRange: z
    .object({
      from: z.iso.date().describe('First day, YYYY-MM-DD'),
      to: z.iso.date().optional().describe('Last day, YYYY-MM-DD (default: today)'),
    })
    .optional()
    .describe('Only results published within these days, instead of recency'),
  includeDomains: z.array(domain).min(1).max(20).optional().describe('Search only these domains'),
  excludeDomains: z
    .array(domain)
    .min(1)
    .max(20)
    .optional()
    .describe('Leave out results from these domains'),
  country: z
    .string()
    .regex(/^[a-z]{2}$/i, 'an ISO 3166-1 alpha-2 code such as "us"')
    .optional()
    .describe('Favour results from this country, an ISO 3166-1 alpha-2 code such as "us" or "de"'),
  language: z
    .string()
    .regex(/^[a-z]{2}(-[a-z]{2,4})?$/i, 'an ISO 639-1 code such as "en" or "pt-br"')
    .optional()
    .describe('Favour results in this language, an ISO 639-1 code such as "en" or "pt-br"'),
  searchDepth: z
    .enum(['ultra-fast', 'fast', 'basic', 'advanced'])
    .optional()
    .describe('Search depth for Tavily, faster or more thorough (default: basic)'),
  includeAnswer: z
    .boolean()
    .optional()
    .describe('Include AI-generated answer summary (Tavily only, default: false)'),
  includeRawContent: z
    .boolean()
    .optional()
    .describe('Include the full page content as markdown in each result (Tavily only)'),
});

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
  /** Publisher name, when the provider reports one (Serper news) */
  source?: string;
  /**
   * When the page was published, as ISO 8601, when the provider reports a date. Serper reports
   * news dates relative to now ("3 hours ago"), which are resolved at the time of the search.
   */
  publishedAt?: string;
  /** The full page content as markdown, with `includeRawContent` on Tavily */
  content?: string;
}

export interface SearchResponse {
  query: string;
  provider: string;
  results: SearchResult[];
  answer?: string;
}

interface SearchRequest {
  query: string;
  maxResults: number;
  page: number;
  topic: SearchTopic;
  recency?: SearchRecency;
  dateRange?: { from: string; to: string };
  includeDomains: string[];
  excludeDomains: string[];
  country?: string;
  language?: string;
  searchDepth: SearchDepth;
  includeAnswer: boolean;
  includeRawContent: boolean;
}

const RELATIVE_UNIT_MS: Record<string, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
};

/**
 * Reads a provider's publication date into ISO 8601: absolute dates (a timestamp without a zone
 * is UTC) and English relative ones like "3 hours ago". Anything else is dropped, never guessed.
 */
export function toPublishedAt(value: unknown, now: number = Date.now()): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;

  const relative = /^(\d+|an?) (second|minute|hour|day|week|month|year)s? ago$/i.exec(text);
  if (relative) {
    const count = /^\d+$/.test(relative[1]) ? Number(relative[1]) : 1;
    return new Date(now - count * RELATIVE_UNIT_MS[relative[2].toLowerCase()]).toISOString();
  }

  const zoneless = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text);
  const time = Date.parse(zoneless ? `${text}Z` : text);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/** Why a provider cannot run a request as asked, or undefined when it can. */
function unsupported(provider: SearchProvider, request: SearchRequest): string | undefined {
  if (provider !== 'tavily') return undefined;
  if (request.page > 1) return 'Tavily returns one page of results, leave out page';
  if (request.country && request.topic === 'news') {
    return 'Tavily favours a country only in general searches, not with topic "news"';
  }
  if (request.country && !TAVILY_COUNTRIES[request.country.toUpperCase()]) {
    return `Tavily cannot favour results from country "${request.country}"`;
  }
  return undefined;
}

/** Domain filters as search operators, for providers without domain parameters. */
function withSiteOperators(request: SearchRequest): string {
  const parts = [request.query];
  if (request.includeDomains.length > 0) {
    const sites = request.includeDomains.map((d) => `site:${d}`);
    parts.push(sites.length === 1 ? sites[0] : `(${sites.join(' OR ')})`);
  }
  for (const d of request.excludeDomains) parts.push(`-site:${d}`);
  return parts.join(' ');
}

async function fetchSearch(
  provider: string,
  url: string,
  init: RequestInit,
  signal: AbortSignal
): Promise<Response> {
  const abort = createLinkedAbortController(signal, SEARCH_TIMEOUT_MS);

  try {
    return await fetch(url, { ...init, signal: abort.signal });
  } catch (err) {
    const error = err as Error;
    if (error.name === 'AbortError') {
      throw new Error(getAbortErrorMessage(`${provider} search`, abort, SEARCH_TIMEOUT_MS), {
        cause: err,
      });
    }
    throw err;
  } finally {
    abort.cleanup();
  }
}

async function searchTavily(
  request: SearchRequest,
  apiKey: string,
  signal: AbortSignal
): Promise<SearchResponse> {
  const country = request.country && TAVILY_COUNTRIES[request.country.toUpperCase()];
  const response = await fetchSearch(
    'Tavily',
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: request.query,
        max_results: request.maxResults,
        search_depth: request.searchDepth,
        include_answer: request.includeAnswer,
        topic: request.topic,
        include_published_date: true,
        ...(request.recency && { time_range: request.recency }),
        ...(request.dateRange && {
          start_date: request.dateRange.from,
          end_date: request.dateRange.to,
        }),
        ...(request.includeDomains.length > 0 && { include_domains: request.includeDomains }),
        ...(request.excludeDomains.length > 0 && { exclude_domains: request.excludeDomains }),
        ...(country && { country }),
        ...(request.language && { language: request.language.toLowerCase() }),
        ...(request.includeRawContent && { include_raw_content: 'markdown' }),
      }),
    },
    signal
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Tavily API error: ${response.status} ${text}`);
  }

  const data = (await response.json()) as {
    results?: Array<{
      title: string;
      url: string;
      content: string;
      score?: number;
      published_date?: string | null;
      raw_content?: string | null;
    }>;
    answer?: string;
  };

  return {
    query: request.query,
    provider: 'tavily',
    results: (data.results ?? []).map((r) => {
      const publishedAt = toPublishedAt(r.published_date);
      return {
        title: r.title,
        url: r.url,
        snippet: r.content,
        score: r.score,
        ...(publishedAt && { publishedAt }),
        ...(r.raw_content && { content: r.raw_content }),
      };
    }),
    answer: data.answer,
  };
}

const BRAVE_FRESHNESS: Record<SearchRecency, string> = {
  day: 'pd',
  week: 'pw',
  month: 'pm',
  year: 'py',
};

interface BraveResult {
  title: string;
  url: string;
  description: string;
  page_age?: string;
}

async function searchBrave(
  request: SearchRequest,
  apiKey: string,
  signal: AbortSignal
): Promise<SearchResponse> {
  const news = request.topic === 'news';
  const params = new URLSearchParams({
    q: withSiteOperators(request),
    count: request.maxResults.toString(),
  });
  if (request.page > 1) params.set('offset', String(request.page - 1));
  if (request.recency) params.set('freshness', BRAVE_FRESHNESS[request.recency]);
  if (request.dateRange) {
    params.set('freshness', `${request.dateRange.from}to${request.dateRange.to}`);
  }
  if (request.country) params.set('country', request.country.toUpperCase());
  if (request.language) params.set('search_lang', request.language.toLowerCase());

  const response = await fetchSearch(
    'Brave Search',
    `https://api.search.brave.com/res/v1/${news ? 'news' : 'web'}/search?${params}`,
    {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
    },
    signal
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Brave Search API error: ${response.status} ${text}`);
  }

  const data = (await response.json()) as {
    web?: { results: BraveResult[] };
    results?: BraveResult[];
  };
  const results = (news ? data.results : data.web?.results) ?? [];

  return {
    query: request.query,
    provider: 'brave',
    results: results.map((r) => {
      const publishedAt = toPublishedAt(r.page_age);
      return {
        title: r.title,
        url: r.url,
        snippet: r.description,
        ...(publishedAt && { publishedAt }),
      };
    }),
  };
}

const SERPER_TIME_RANGE: Record<SearchRecency, string> = {
  day: 'qdr:d',
  week: 'qdr:w',
  month: 'qdr:m',
  year: 'qdr:y',
};

/** Google's custom date range, which writes days as M/D/YYYY. */
function serperDateRange(range: { from: string; to: string }): string {
  const day = (iso: string) => {
    const [year, month, date] = iso.split('-').map(Number);
    return `${month}/${date}/${year}`;
  };
  return `cdr:1,cd_min:${day(range.from)},cd_max:${day(range.to)}`;
}

async function searchSerper(
  request: SearchRequest,
  apiKey: string,
  signal: AbortSignal
): Promise<SearchResponse> {
  const news = request.topic === 'news';
  const tbs = request.dateRange
    ? serperDateRange(request.dateRange)
    : request.recency && SERPER_TIME_RANGE[request.recency];
  const response = await fetchSearch(
    'Serper',
    `https://google.serper.dev/${news ? 'news' : 'search'}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': apiKey,
      },
      body: JSON.stringify({
        q: withSiteOperators(request),
        num: request.maxResults,
        ...(request.page > 1 && { page: request.page }),
        ...(tbs && { tbs }),
        ...(request.country && { gl: request.country.toLowerCase() }),
        ...(request.language && { hl: request.language.toLowerCase() }),
      }),
    },
    signal
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Serper API error: ${response.status} ${text}`);
  }

  const data = (await response.json()) as {
    organic?: Array<{ title: string; link: string; snippet: string; date?: string }>;
    news?: Array<{ title: string; link: string; snippet: string; date?: string; source?: string }>;
    answerBox?: { answer?: string; snippet?: string };
  };
  const now = Date.now();

  if (news) {
    return {
      query: request.query,
      provider: 'serper',
      results: (data.news ?? []).map((r) => {
        const publishedAt = toPublishedAt(r.date, now);
        return {
          title: r.title,
          url: r.link,
          snippet: r.snippet,
          ...(r.source && { source: r.source }),
          ...(publishedAt && { publishedAt }),
        };
      }),
    };
  }

  return {
    query: request.query,
    provider: 'serper',
    results: (data.organic ?? []).map((r) => {
      const publishedAt = toPublishedAt(r.date, now);
      return {
        title: r.title,
        url: r.link,
        snippet: r.snippet,
        ...(publishedAt && { publishedAt }),
      };
    }),
    answer: data.answerBox?.answer ?? data.answerBox?.snippet,
  };
}

export interface WebSearchOptions {
  /**
   * Provider used when a call names none. Without it, the first provider with a key wins, in the
   * order Tavily, Brave, Serper
   */
  provider?: SearchProvider;
  /**
   * API keys by provider. A provider without one here reads its environment variable
   * (TAVILY_API_KEY, BRAVE_API_KEY, SERPER_API_KEY) at call time
   */
  apiKeys?: Partial<Record<SearchProvider, string>>;
}

/**
 * Builds a `web_search` tool. Every provider takes the same filters: news-only search, a recency
 * window or a date range, domain filters, country, language and paging, mapped to each
 * provider's own parameters, with `site:` operators where a provider has no domain parameter.
 * A filter a provider cannot apply comes back as an `error` rather than being dropped.
 *
 * @example
 * const search = createWebSearchTool({ provider: 'tavily', apiKeys: { tavily: process.env.KEY } });
 */
export function createWebSearchTool(options: WebSearchOptions = {}) {
  const keyFor = (provider: SearchProvider): string | undefined =>
    options.apiKeys?.[provider] || readEnv(KEY_ENV[provider]) || undefined;

  return tool({
    name: 'web_search',
    description:
      'Search the web using Tavily, Brave, or Serper APIs. Returns relevant results with titles, URLs, snippets and publication dates when known. Can search news only, limit results to a recent period or a date range, include or exclude domains, and favour a country or language.',
    parameters: webSearchParams,
    category: 'web',
    tags: ['search', 'web', 'internet'],
    sideEffects: ['network'],
    execute: async (
      {
        query,
        provider: requestedProvider,
        maxResults = 5,
        page = 1,
        topic = 'general',
        recency,
        dateRange,
        includeDomains = [],
        excludeDomains = [],
        country,
        language,
        searchDepth = 'basic',
        includeAnswer = false,
        includeRawContent = false,
      },
      context
    ) => {
      const named = requestedProvider ?? options.provider;
      const chosen = (named ? [named] : PROVIDERS)
        .map((provider) => ({ provider, apiKey: keyFor(provider) }))
        .find((c): c is { provider: SearchProvider; apiKey: string } => c.apiKey !== undefined);

      if (!chosen) {
        return {
          error: named
            ? `API key not found for ${named}. Set ${KEY_ENV[named]} environment variable.`
            : 'No search API key found. Set one of: TAVILY_API_KEY, BRAVE_API_KEY, or SERPER_API_KEY',
        };
      }

      if (recency && dateRange) {
        return { error: 'Use either recency or dateRange, not both', query };
      }
      const range = dateRange && {
        from: dateRange.from,
        to: dateRange.to ?? new Date().toISOString().slice(0, 10),
      };
      if (range && range.from > range.to) {
        return { error: `dateRange starts after it ends (${range.from} > ${range.to})`, query };
      }

      const request: SearchRequest = {
        query,
        maxResults,
        page,
        topic,
        ...(recency && { recency }),
        ...(range && { dateRange: range }),
        includeDomains,
        excludeDomains,
        ...(country && { country }),
        ...(language && { language }),
        searchDepth,
        includeAnswer,
        includeRawContent,
      };

      const refusal = unsupported(chosen.provider, request);
      if (refusal) return { error: refusal, query, provider: chosen.provider };

      const signal = context?.signal ?? new AbortController().signal;

      try {
        switch (chosen.provider) {
          case 'tavily':
            return await searchTavily(request, chosen.apiKey, signal);
          case 'brave':
            return await searchBrave(request, chosen.apiKey, signal);
          case 'serper':
            return await searchSerper(request, chosen.apiKey, signal);
        }
      } catch (err) {
        return { error: (err as Error).message, query, provider: chosen.provider };
      }
    },
  });
}

/** `web_search` with keys from the environment. */
export const webSearch = createWebSearchTool();
