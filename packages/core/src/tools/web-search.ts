import { z } from 'zod';
import { tool } from '../tool';

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
  searchDepth: z
    .enum(['basic', 'advanced'])
    .optional()
    .describe('Search depth for Tavily (default: basic)'),
  includeAnswer: z
    .boolean()
    .optional()
    .describe('Include AI-generated answer summary (Tavily only, default: false)'),
});

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
}

export interface SearchResponse {
  query: string;
  provider: string;
  results: SearchResult[];
  answer?: string;
}

async function searchTavily(
  query: string,
  maxResults: number,
  searchDepth: 'basic' | 'advanced',
  includeAnswer: boolean,
  apiKey: string
): Promise<SearchResponse> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      search_depth: searchDepth,
      include_answer: includeAnswer,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Tavily API error: ${response.status} ${text}`);
  }

  const data = (await response.json()) as {
    results: Array<{ title: string; url: string; content: string; score?: number }>;
    answer?: string;
  };

  return {
    query,
    provider: 'tavily',
    results: data.results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
      score: r.score,
    })),
    answer: data.answer,
  };
}

async function searchBrave(
  query: string,
  maxResults: number,
  apiKey: string
): Promise<SearchResponse> {
  const params = new URLSearchParams({
    q: query,
    count: maxResults.toString(),
  });

  const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Brave Search API error: ${response.status} ${text}`);
  }

  const data = (await response.json()) as {
    web?: { results: Array<{ title: string; url: string; description: string }> };
  };

  return {
    query,
    provider: 'brave',
    results: (data.web?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
    })),
  };
}

async function searchSerper(
  query: string,
  maxResults: number,
  apiKey: string
): Promise<SearchResponse> {
  const response = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
    body: JSON.stringify({
      q: query,
      num: maxResults,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Serper API error: ${response.status} ${text}`);
  }

  const data = (await response.json()) as {
    organic: Array<{ title: string; link: string; snippet: string; position?: number }>;
    answerBox?: { answer?: string; snippet?: string };
  };

  return {
    query,
    provider: 'serper',
    results: data.organic.map((r) => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet,
    })),
    answer: data.answerBox?.answer ?? data.answerBox?.snippet,
  };
}

function detectProvider(): { provider: 'tavily' | 'brave' | 'serper'; apiKey: string } | null {
  const tavily = process.env.TAVILY_API_KEY;
  if (tavily) return { provider: 'tavily', apiKey: tavily };

  const brave = process.env.BRAVE_API_KEY;
  if (brave) return { provider: 'brave', apiKey: brave };

  const serper = process.env.SERPER_API_KEY;
  if (serper) return { provider: 'serper', apiKey: serper };

  return null;
}

function getApiKey(provider: 'tavily' | 'brave' | 'serper'): string | null {
  switch (provider) {
    case 'tavily':
      return process.env.TAVILY_API_KEY ?? null;
    case 'brave':
      return process.env.BRAVE_API_KEY ?? null;
    case 'serper':
      return process.env.SERPER_API_KEY ?? null;
  }
}

export const webSearch = tool({
  name: 'web_search',
  description:
    'Search the web using Tavily, Brave, or Serper APIs. Returns relevant results with titles, URLs, and snippets. Requires API key in environment (TAVILY_API_KEY, BRAVE_API_KEY, or SERPER_API_KEY).',
  parameters: webSearchParams,
  category: 'web',
  tags: ['search', 'web', 'internet'],
  execute: async ({
    query,
    provider: requestedProvider,
    maxResults = 5,
    searchDepth = 'basic',
    includeAnswer = false,
  }) => {
    let provider: 'tavily' | 'brave' | 'serper';
    let apiKey: string;

    if (requestedProvider) {
      const key = getApiKey(requestedProvider);
      if (!key) {
        return {
          error: `API key not found for ${requestedProvider}. Set ${requestedProvider.toUpperCase()}_API_KEY environment variable.`,
        };
      }
      provider = requestedProvider;
      apiKey = key;
    } else {
      const detected = detectProvider();
      if (!detected) {
        return {
          error:
            'No search API key found. Set one of: TAVILY_API_KEY, BRAVE_API_KEY, or SERPER_API_KEY',
        };
      }
      provider = detected.provider;
      apiKey = detected.apiKey;
    }

    try {
      switch (provider) {
        case 'tavily':
          return await searchTavily(query, maxResults, searchDepth, includeAnswer, apiKey);
        case 'brave':
          return await searchBrave(query, maxResults, apiKey);
        case 'serper':
          return await searchSerper(query, maxResults, apiKey);
      }
    } catch (err) {
      return { error: (err as Error).message, query, provider };
    }
  },
});
