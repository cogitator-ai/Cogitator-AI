import { describe, it, expect } from 'vitest';
import { createWebSearchTool } from '@cogitator-ai/core';
import type { SearchResponse } from '@cogitator-ai/core';

const tavilyKey = process.env.TAVILY_API_KEY;
const ctx = { agentId: 'e2e', runId: 'e2e-web-search', signal: new AbortController().signal };

function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, '');
}

describe.skipIf(!tavilyKey)('Core: web search on Tavily', () => {
  const search = createWebSearchTool({ provider: 'tavily', apiKeys: { tavily: tavilyKey } });

  it('finds recent news with publication dates', { timeout: 60_000 }, async () => {
    const result = (await search.execute(
      { query: 'artificial intelligence', topic: 'news', recency: 'week', maxResults: 5 },
      ctx
    )) as SearchResponse;

    expect(result.provider).toBe('tavily');
    expect(result.results.length).toBeGreaterThan(0);
    const dates = result.results.flatMap((r) => (r.publishedAt ? [Date.parse(r.publishedAt)] : []));
    expect(dates.length).toBeGreaterThan(0);
    const weekAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    for (const date of dates) expect(date).toBeGreaterThan(weekAgo);
  });

  it('keeps results to the included domains', { timeout: 60_000 }, async () => {
    const result = (await search.execute(
      { query: 'climate', includeDomains: ['bbc.co.uk', 'bbc.com'], maxResults: 5 },
      ctx
    )) as SearchResponse;

    expect(result.results.length).toBeGreaterThan(0);
    for (const r of result.results) expect(hostOf(r.url)).toMatch(/(^|\.)bbc\.(co\.uk|com)$/);
  });

  it('leaves out excluded domains', { timeout: 60_000 }, async () => {
    const result = (await search.execute(
      { query: 'wikipedia python programming language', excludeDomains: ['wikipedia.org'] },
      ctx
    )) as SearchResponse;

    expect(result.results.length).toBeGreaterThan(0);
    for (const r of result.results) expect(hostOf(r.url)).not.toMatch(/(^|\.)wikipedia\.org$/);
  });

  it('keeps every result inside a date range', { timeout: 60_000 }, async () => {
    const result = (await search.execute(
      { query: 'space telescope discovery', dateRange: { from: '2026-09-01', to: '2026-09-15' } },
      ctx
    )) as SearchResponse;

    expect(result.results.length).toBeGreaterThan(0);
    for (const r of result.results) {
      const day = r.publishedAt?.slice(0, 10) ?? 'undated';
      expect(day >= '2026-09-01' && day <= '2026-09-15', `${r.url} ${day}`).toBe(true);
    }
  });

  it('favours a country and a language', { timeout: 60_000 }, async () => {
    const result = (await search.execute(
      { query: 'Bundeshaushalt', country: 'de', language: 'de', maxResults: 5 },
      ctx
    )) as SearchResponse;

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.some((r) => hostOf(r.url).endsWith('.de'))).toBe(true);
  });

  it('returns full page content on request', { timeout: 60_000 }, async () => {
    const result = (await search.execute(
      { query: 'TypeScript handbook generics', includeRawContent: true, maxResults: 2 },
      ctx
    )) as SearchResponse;

    expect(result.results.some((r) => (r.content?.length ?? 0) > r.snippet.length)).toBe(true);
  });
});
