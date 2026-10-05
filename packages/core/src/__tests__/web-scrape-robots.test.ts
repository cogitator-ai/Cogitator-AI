import type { RobotsChecker } from '@cogitator-ai/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebScrapeTool } from '../tools/web-scrape';
import type { FetchFunction } from '../utils/public-network';
/** Sends the tool's requests through the global `fetch`, which these tests stub. */
const viaGlobalFetch: FetchFunction = (input, init) => fetch(input, init);

const fetchMock = vi.fn();
const html = (body: string) =>
  new Response(`<html><head><title>T</title></head><body>${body}</body></html>`, {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
const context = { agentId: 'a', runId: 'r', signal: new AbortController().signal };
const noPrivate: RobotsChecker = {
  allows: (url) => Promise.resolve(!new URL(url).pathname.startsWith('/private')),
};

describe('web_scrape with a robots checker', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const scrape = createWebScrapeTool({
    userAgent: 'NewsBot/1.0',
    robots: noPrivate,
    fetch: viaGlobalFetch,
  });

  it('fetches an allowed page with its own User-Agent', async () => {
    fetchMock.mockResolvedValueOnce(html('<p>Open news</p>'));

    const result = await scrape.execute({ url: 'https://site.test/news' }, context);

    expect(result).toMatchObject({ content: expect.stringContaining('Open news') });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ 'User-Agent': 'NewsBot/1.0' });
    expect(init.redirect).toBe('manual');
  });

  it('refuses a disallowed page without fetching it', async () => {
    const result = await scrape.execute({ url: 'https://site.test/private/a' }, context);

    expect(result).toEqual({
      error: 'robots.txt does not allow fetching https://site.test/private/a',
      url: 'https://site.test/private/a',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks every redirect hop', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: '/private/b' } })
    );

    const result = await scrape.execute({ url: 'https://site.test/moved' }, context);

    expect(result).toMatchObject({
      error: 'robots.txt does not allow fetching https://site.test/private/b',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows allowed redirects to the page', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { location: 'https://site.test/news/2' } })
      )
      .mockResolvedValueOnce(html('<p>Moved news</p>'));

    const result = await scrape.execute({ url: 'https://site.test/news/1' }, context);

    expect(result).toMatchObject({ content: expect.stringContaining('Moved news') });
  });
});
