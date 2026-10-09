import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedError } from '../feeds/errors';
import { MemoryTokenStore } from '../feeds/token-store';
import { ThreadsAccount } from '../channels/threads/account';
import { ThreadsFeed } from '../channels/threads/feed';
import { threadsErrorCode } from '../channels/threads/client';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

interface Call {
  method: string;
  path: string;
  params: Record<string, string>;
}

/** A post as `/{user-id}/threads` and `/{user-id}/replies` list it. */
interface Listed {
  id: string;
  text?: string;
  timestamp: string;
  permalink?: string;
  replied_to?: { id: string };
  media_type?: string;
}

/** A time as the Threads API writes it, like `2026-10-09T10:00:00+0000`. */
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+0000');

/**
 * A page of a listing as the Graph API sends it: the newest first, from
 * `since`, with `paging.cursors` and a `next` link while more remain.
 */
function listing(posts: Listed[], params: Record<string, string>, path: string) {
  const since = params.since === undefined ? 0 : Number(params.since) * 1000;
  const fields = (params.fields ?? 'id').split(',');
  const matching = posts
    .filter((post) => Date.parse(post.timestamp) >= since)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const limit = Number(params.limit ?? 25);
  const offset = params.after ? Number(Buffer.from(params.after, 'base64').toString()) : 0;
  const page = matching.slice(offset, offset + limit);
  const cursor = (n: number) => Buffer.from(String(n)).toString('base64');
  const more = offset + limit < matching.length;
  return {
    data: page.map((post) =>
      Object.fromEntries(
        Object.entries(post).filter(([key]) => key === 'id' || fields.includes(key))
      )
    ),
    ...(page.length > 0 && {
      paging: {
        cursors: { before: cursor(offset), after: cursor(offset + page.length) },
        ...(more && {
          next: `https://graph.threads.net/v1.0/${path}?fields=${params.fields}&limit=${limit}&after=${cursor(offset + page.length)}&access_token=token`,
        }),
      },
    }),
  };
}

/**
 * A Graph API double answering in the shapes of the Threads docs: containers
 * that are ready after `readyAfter` checks, publication, permalinks, quotas
 * and token renewal.
 */
function graph() {
  const calls: Call[] = [];
  const api = {
    calls,
    readyAfter: 1,
    containerStatus: 'FINISHED' as string,
    quota: {
      quota_usage: 3,
      config: { quota_total: 250, quota_duration: 86400 },
      reply_quota_usage: 0,
      reply_config: { quota_total: 1000, quota_duration: 86400 },
    },
    permalinkFails: false,
    threads: [] as Listed[],
    replies: [] as Listed[],
    listingFails: false,
    renewed: { access_token: 'token-2', token_type: 'bearer', expires_in: 60 * 24 * 60 * 60 },
    error: undefined as { status: number; body: unknown } | undefined,
    checks: new Map<string, number>(),
    fetch: vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const params = Object.fromEntries(
        method === 'POST' ? new URLSearchParams(String(init?.body)) : url.searchParams
      );
      const path = url.pathname.replace('/v1.0/', '');
      calls.push({ method, path, params });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (api.error) {
        const { status, body } = api.error;
        api.error = undefined;
        return json(body, status);
      }
      if (path === 'refresh_access_token') return json(api.renewed);
      if (path.endsWith('/threads_publishing_limit')) return json({ data: [api.quota] });
      if (method === 'GET' && (path === 'me/threads' || path === 'me/replies')) {
        if (api.listingFails)
          return json({ error: { message: 'An unknown error occurred', code: 1 } }, 500);
        return json(listing(path === 'me/threads' ? api.threads : api.replies, params, path));
      }
      if (path.endsWith('/threads') && method === 'POST')
        return json({ id: `container-${calls.length}` });
      if (path.endsWith('/threads_publish')) return json({ id: 'media-1' });
      if (method === 'DELETE') return json({ success: true });
      if (params.fields === 'status,error_message') {
        const seen = (api.checks.get(path) ?? 0) + 1;
        api.checks.set(path, seen);
        return json(
          seen < api.readyAfter
            ? { status: 'IN_PROGRESS', id: path }
            : {
                status: api.containerStatus,
                id: path,
                ...(api.containerStatus === 'ERROR' && { error_message: 'UNKNOWN' }),
              }
        );
      }
      if (params.fields === 'permalink') {
        if (api.permalinkFails) return json({ error: { message: 'boom', code: 1 } }, 500);
        return json({ permalink: 'https://www.threads.net/@mybot/post/abc', id: path });
      }
      if (method === 'GET') return json({ id: path });
      return json({ error: { message: `unexpected ${method} ${path}` } }, 404);
    }),
  };
  return api;
}

let api: ReturnType<typeof graph>;

function feed(
  options: { store?: MemoryTokenStore; expiresAt?: number; checkQuota?: boolean } = {}
) {
  return new ThreadsFeed({
    accessToken: 'token-1',
    ...(options.expiresAt !== undefined && { accessTokenExpiresAt: options.expiresAt }),
    store: options.store ?? new MemoryTokenStore(),
    fetch: api.fetch as unknown as typeof fetch,
    pollDelays: [0],
    ...(options.checkQuota !== undefined && { checkQuota: options.checkQuota }),
  });
}

const farFuture = () => Date.now() + 50 * DAY;

beforeEach(() => {
  api = graph();
});

describe('ThreadsFeed', () => {
  it('publishes a text post in two steps once its container is ready', async () => {
    api.readyAfter = 3;
    const published = await feed({ expiresAt: farFuture() }).publish({
      text: 'Big news',
      link: { url: 'https://example.com/story' },
      tags: ['#AI News'],
    });
    const container = api.calls.find((call) => call.path === 'me/threads');
    expect(container?.params).toMatchObject({
      media_type: 'TEXT',
      text: 'Big news',
      link_attachment: 'https://example.com/story',
      topic_tag: 'AI News',
      access_token: 'token-1',
    });
    const checks = api.calls.filter((call) => call.params.fields === 'status,error_message');
    expect(checks).toHaveLength(3);
    expect(api.calls.find((call) => call.path === 'me/threads_publish')?.params.creation_id).toBe(
      container && `container-${api.calls.indexOf(container) + 1}`
    );
    expect(published).toMatchObject({
      feed: 'threads',
      id: 'media-1',
      url: 'https://www.threads.net/@mybot/post/abc',
    });
  });

  it('publishes one image with its alt text, or a carousel of them', async () => {
    const threads = feed({ expiresAt: farFuture() });
    const image = (n: number) => ({
      type: 'image' as const,
      mimeType: 'image/jpeg',
      url: `https://cdn/${n}.jpg`,
    });
    await threads.publish({ text: 'One', images: [{ image: image(1), alt: 'A chart' }] });
    expect(api.calls.find((call) => call.path === 'me/threads')?.params).toMatchObject({
      media_type: 'IMAGE',
      image_url: 'https://cdn/1.jpg',
      alt_text: 'A chart',
      text: 'One',
    });

    api.calls.length = 0;
    await threads.publish({ text: 'Two', images: [{ image: image(1) }, { image: image(2) }] });
    const containers = api.calls.filter((call) => call.path === 'me/threads');
    expect(containers.map((call) => call.params.media_type)).toEqual([
      'IMAGE',
      'IMAGE',
      'CAROUSEL',
    ]);
    expect(containers[0].params.is_carousel_item).toBe('true');
    expect(containers[2].params.children).toMatch(/^container-\d+,container-\d+$/);
  });

  it('answers a post through its reply quota', async () => {
    await feed({ expiresAt: farFuture() }).publish({ text: 'Answer', replyTo: '17890' });
    expect(api.calls.find((call) => call.path === 'me/threads')?.params.reply_to_id).toBe('17890');
    api.quota.reply_quota_usage = 1000;
    await expect(
      feed({ expiresAt: farFuture() }).publish({ text: 'Again', replyTo: '17890' })
    ).rejects.toMatchObject({ code: 'quota_exceeded' });
  });

  it('stops before posting when the daily quota is used, unless told not to check', async () => {
    api.quota.quota_usage = 250;
    const error = await feed({ expiresAt: farFuture() })
      .publish({ text: 'x' })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'quota_exceeded' });
    expect((error as FeedError).retryable).toBe(true);
    expect(api.calls.some((call) => call.path === 'me/threads' && call.method === 'POST')).toBe(
      false
    );
    await feed({ expiresAt: farFuture(), checkQuota: false }).publish({ text: 'x' });
  });

  it('says when a full quota frees up: when its oldest post leaves the window', async () => {
    const now = Date.now();
    api.quota.quota_usage = 250;
    api.threads = [
      ...Array.from({ length: 150 }, (_, n) => ({
        id: `post-${n}`,
        timestamp: iso(now - (n + 1) * 60_000),
      })),
      { id: 'oldest', timestamp: iso(now - 23 * HOUR) },
      { id: 'outside', timestamp: iso(now - 25 * HOUR) },
    ];
    const error = await feed({ expiresAt: farFuture() })
      .publish({ text: 'x' })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'quota_exceeded' });
    const retryAfter = (error as FeedError).retryAfter ?? 0;
    expect(retryAfter).toBeGreaterThan(HOUR + 60_000 - 5_000);
    expect(retryAfter).toBeLessThanOrEqual(HOUR + 60_000);
    const listings = api.calls.filter((call) => call.path === 'me/threads');
    expect(listings).toHaveLength(2);
    expect(listings[0].params).toMatchObject({ fields: 'timestamp', limit: '100' });
    expect(Number(listings[0].params.since)).toBeCloseTo((now - DAY) / 1000, -1);
    expect(listings[1].params.after).toBeDefined();
  });

  it('uses the reply quota window for a reply, and waits an hour when the oldest is unknown', async () => {
    const now = Date.now();
    api.quota.reply_quota_usage = 1000;
    api.quota.reply_config.quota_duration = 3600;
    api.replies = [{ id: 'reply-1', timestamp: iso(now - 30 * 60_000) }];
    const reply = (await feed({ expiresAt: farFuture() })
      .publish({ text: 'x', replyTo: '17890' })
      .catch((caught: unknown) => caught)) as FeedError;
    expect(reply.retryAfter).toBeGreaterThan(31 * 60_000 - 5_000);
    expect(reply.retryAfter).toBeLessThanOrEqual(31 * 60_000);

    api.quota.quota_usage = 250;
    const empty = (await feed({ expiresAt: farFuture() })
      .publish({ text: 'x' })
      .catch((caught: unknown) => caught)) as FeedError;
    expect(empty).toMatchObject({ code: 'quota_exceeded', retryAfter: HOUR });

    api.listingFails = true;
    const failed = (await feed({ expiresAt: farFuture() })
      .publish({ text: 'x' })
      .catch((caught: unknown) => caught)) as FeedError;
    expect(failed).toMatchObject({ code: 'quota_exceeded', retryAfter: HOUR });
  });

  it('fails a post Threads could not prepare, and one that takes too long', async () => {
    api.containerStatus = 'ERROR';
    await expect(feed({ expiresAt: farFuture() }).publish({ text: 'x' })).rejects.toMatchObject({
      code: 'invalid_post',
      message: expect.stringContaining('ERROR: UNKNOWN'),
    });
    api = graph();
    api.readyAfter = 1_000;
    const slow = new ThreadsFeed({
      accessToken: 'token-1',
      accessTokenExpiresAt: farFuture(),
      fetch: api.fetch as unknown as typeof fetch,
      pollDelays: [5],
      containerTimeout: 20,
    });
    await expect(slow.publish({ text: 'x' })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('keeps a published post when its permalink cannot be read', async () => {
    api.permalinkFails = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const published = await feed({ expiresAt: farFuture() }).publish({ text: 'x' });
    expect(published).toMatchObject({ id: 'media-1', url: '' });
    warn.mockRestore();
  });

  it.each([
    ['text over 500 with emoji counted as bytes', { text: `${'😀'.repeat(125)}a` }, '501 long'],
    [
      'six links',
      { text: [1, 2, 3, 4, 5, 6].map((n) => `https://e.com/${n}`).join(' ') },
      '6 links',
    ],
    [
      'images and a link',
      {
        text: 'x',
        link: { url: 'https://a' },
        images: [
          { image: { type: 'image' as const, mimeType: 'image/png', url: 'https://cdn/a.png' } },
        ],
      },
      'either images or a link',
    ],
    [
      'an image without a URL',
      {
        text: 'x',
        images: [
          { image: { type: 'image' as const, mimeType: 'image/png', buffer: new Uint8Array(1) } },
        ],
      },
      'public URL',
    ],
    ['a topic tag with a period', { text: 'x', tags: ['v1.0'] }, 'cannot hold'],
    ['a topic tag over 50', { text: 'x', tags: ['a'.repeat(51)] }, '1 to 50'],
    ['an empty post', { text: ' ' }, 'empty'],
  ])('refuses %s before calling Threads', async (_name, post, message) => {
    const error = await feed({ expiresAt: farFuture() })
      .publish(post)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'invalid_post' });
    expect((error as Error).message).toContain(message);
    expect(api.calls).toEqual([]);
  });

  it('turns Graph API errors into feed errors', async () => {
    api.error = {
      status: 400,
      body: {
        error: {
          message: 'Error validating access token',
          type: 'OAuthException',
          code: 190,
          error_subcode: 463,
        },
      },
    };
    await expect(
      feed({ expiresAt: farFuture(), checkQuota: false }).publish({ text: 'x' })
    ).rejects.toMatchObject({
      code: 'token_expired',
    });
    expect(threadsErrorCode(400, { code: 4 })).toBe('rate_limited');
    expect(threadsErrorCode(400, { code: 190 })).toBe('auth');
    expect(threadsErrorCode(400, { message: 'THREADS_API__LINK_LIMIT_EXCEEDED' })).toBe(
      'invalid_post'
    );
    expect(threadsErrorCode(503, {})).toBe('unavailable');
  });

  it('makes keys that hold their time and differ', () => {
    const threads = feed();
    const before = Date.now();
    const [first, second] = [threads.idempotencyKey(), threads.idempotencyKey()];
    expect(first).not.toBe(second);
    const [time, random] = first.split('.');
    expect(Number(time)).toBeGreaterThanOrEqual(before);
    expect(Number(time)).toBeLessThanOrEqual(Date.now());
    expect(random.length).toBeGreaterThanOrEqual(8);
  });

  it('returns the post an earlier attempt with the same key made, without posting again', async () => {
    const threads = feed({ expiresAt: farFuture() });
    const key = threads.idempotencyKey();
    const keyTime = Number(key.split('.')[0]);
    api.threads = [
      ...Array.from({ length: 60 }, (_, n) => ({
        id: `other-${n}`,
        text: `Another post ${n}`,
        timestamp: iso(keyTime + 1000),
        permalink: `https://www.threads.net/@mybot/post/other${n}`,
        media_type: 'TEXT_POST',
      })),
      {
        id: '17920',
        text: 'Big   news\n today ',
        timestamp: iso(keyTime - 30_000),
        permalink: 'https://www.threads.net/@mybot/post/DBig',
        media_type: 'TEXT_POST',
      },
    ];
    const published = await threads.publish(
      { text: 'Big news today', link: { url: 'https://example.com/story' } },
      { idempotencyKey: key }
    );
    expect(published).toEqual({
      feed: 'threads',
      id: '17920',
      url: 'https://www.threads.net/@mybot/post/DBig',
      publishedAt: new Date(Math.floor((keyTime - 30_000) / 1000) * 1000),
    });
    expect(api.calls.some((call) => call.method === 'POST')).toBe(false);
    expect(api.calls.some((call) => call.path.endsWith('threads_publishing_limit'))).toBe(false);
    const lookups = api.calls.filter((call) => call.path === 'me/threads');
    expect(lookups).toHaveLength(2);
    expect(lookups[0].params).toMatchObject({
      fields: 'id,text,timestamp,permalink',
      since: String(Math.floor((keyTime - 60_000) / 1000)),
    });
  });

  it('finds an earlier reply by its text and parent', async () => {
    const threads = feed({ expiresAt: farFuture() });
    const key = threads.idempotencyKey();
    const at = iso(Number(key.split('.')[0]) + 2000);
    api.replies = [
      { id: 'r-other-parent', text: 'Thanks!', timestamp: at, replied_to: { id: '555' } },
      {
        id: 'r-match',
        text: 'Thanks!',
        timestamp: at,
        permalink: 'https://www.threads.net/@mybot/post/DReply',
        replied_to: { id: '17890' },
      },
    ];
    const published = await threads.publish(
      { text: 'Thanks!', replyTo: '17890' },
      { idempotencyKey: key }
    );
    expect(published).toMatchObject({
      id: 'r-match',
      url: 'https://www.threads.net/@mybot/post/DReply',
    });
    expect(api.calls[0]).toMatchObject({
      path: 'me/replies',
      params: { fields: 'id,text,timestamp,permalink,replied_to' },
    });
    expect(api.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('matches an image post without text on its empty text', async () => {
    const threads = feed({ expiresAt: farFuture() });
    const key = threads.idempotencyKey();
    api.threads = [
      {
        id: 'img-1',
        timestamp: iso(Number(key.split('.')[0]) + 1000),
        permalink: 'https://www.threads.net/@mybot/post/DImg',
        media_type: 'IMAGE',
      },
    ];
    const published = await threads.publish(
      {
        text: '',
        images: [{ image: { type: 'image', mimeType: 'image/jpeg', url: 'https://cdn/1.jpg' } }],
      },
      { idempotencyKey: key }
    );
    expect(published.id).toBe('img-1');
  });

  it('posts when no earlier post matches the key, and refuses a key it did not make', async () => {
    const threads = feed({ expiresAt: farFuture() });
    const key = threads.idempotencyKey();
    const keyTime = Number(key.split('.')[0]);
    api.threads = [
      { id: 'same-text-too-old', text: 'Hello', timestamp: iso(keyTime - 5 * 60_000) },
      { id: 'other-text', text: 'Hello there', timestamp: iso(keyTime + 1000) },
    ];
    const published = await threads.publish({ text: 'Hello' }, { idempotencyKey: key });
    expect(published.id).toBe('media-1');
    expect(api.calls.map((call) => `${call.method} ${call.path}`).slice(0, 3)).toEqual([
      'GET me/threads',
      'GET me/threads_publishing_limit',
      'POST me/threads',
    ]);

    api.calls.length = 0;
    for (const bad of ['story-42', '', '1700000000000', '1700000000000.short']) {
      await expect(
        threads.publish({ text: 'Hello' }, { idempotencyKey: bad })
      ).rejects.toMatchObject({
        code: 'invalid_post',
        message: expect.stringContaining('idempotencyKey()'),
      });
    }
    expect(api.calls).toEqual([]);
  });

  it('deletes a post', async () => {
    await feed({ expiresAt: farFuture() }).delete('media-1');
    expect(api.calls).toMatchObject([{ method: 'DELETE', path: 'media-1' }]);
  });
});

describe('the Threads token', () => {
  it('is renewed when it ends within a week and is at least a day old, and saved', async () => {
    let clock = Date.now();
    const store = new MemoryTokenStore();
    await store.set('threads', {
      value: 'token-1',
      issuedAt: clock - 54 * DAY,
      expiresAt: clock + 6 * DAY,
    });
    const renewed = vi.fn();
    const account = new ThreadsAccount({
      store,
      fetch: api.fetch as unknown as typeof fetch,
      onTokenRenewed: renewed,
      now: () => clock,
    });
    await account.get('me', { fields: 'id' });
    expect(api.calls.map((call) => call.path)).toEqual(['refresh_access_token', 'me']);
    expect(api.calls[0].params).toMatchObject({
      grant_type: 'th_refresh_token',
      access_token: 'token-1',
    });
    expect(api.calls[1].params.access_token).toBe('token-2');
    expect(await store.get('threads')).toMatchObject({
      value: 'token-2',
      expiresAt: clock + 60 * DAY,
    });
    expect(renewed).toHaveBeenCalledTimes(1);

    clock += DAY;
    await account.get('me');
    expect(api.calls.filter((call) => call.path === 'refresh_access_token')).toHaveLength(1);
  });

  it('is renewed at the first chance when its expiry is unknown, and the attempts wait an hour after a failure', async () => {
    let clock = Date.now();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const account = new ThreadsAccount({
      accessToken: 'token-1',
      fetch: api.fetch as unknown as typeof fetch,
      now: () => clock,
    });
    api.error = { status: 400, body: { error: { message: 'token too new', code: 100 } } };
    await account.get('me');
    expect(api.calls.map((call) => call.path)).toEqual(['refresh_access_token', 'me']);
    expect(api.calls[1].params.access_token).toBe('token-1');
    await account.get('me');
    expect(api.calls.filter((call) => call.path === 'refresh_access_token')).toHaveLength(1);
    clock += 60 * 60 * 1000;
    await account.get('me');
    expect(api.calls.filter((call) => call.path === 'refresh_access_token')).toHaveLength(2);
    expect(api.calls.at(-1)?.params.access_token).toBe('token-2');
    warn.mockRestore();
  });

  it('is renewed once for calls made at the same time', async () => {
    const store = new MemoryTokenStore();
    await store.set('threads', {
      value: 'token-1',
      issuedAt: Date.now() - 55 * DAY,
      expiresAt: Date.now() + DAY,
    });
    const account = new ThreadsAccount({ store, fetch: api.fetch as unknown as typeof fetch });
    await Promise.all([account.get('a'), account.get('b'), account.get('c')]);
    expect(api.calls.filter((call) => call.path === 'refresh_access_token')).toHaveLength(1);
  });

  it('fails clearly once expired, and without any token', async () => {
    const store = new MemoryTokenStore();
    await store.set('threads', { value: 'old', issuedAt: 0, expiresAt: Date.now() - 1 });
    await expect(
      new ThreadsAccount({ store, fetch: api.fetch as unknown as typeof fetch }).get('me')
    ).rejects.toMatchObject({ code: 'token_expired' });
    await expect(
      new ThreadsAccount({ fetch: api.fetch as unknown as typeof fetch }).get('me')
    ).rejects.toMatchObject({ code: 'auth', message: expect.stringContaining('No Threads token') });
  });

  it('can be renewed on demand, and checked daily once connected', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const account = new ThreadsAccount({
        accessToken: 'token-1',
        accessTokenExpiresAt: Date.now() + 30 * DAY,
        fetch: api.fetch as unknown as typeof fetch,
      });
      await account.renewToken();
      expect(api.calls.map((call) => call.path)).toEqual(['refresh_access_token']);
      await account.connect();
      await vi.advanceTimersByTimeAsync(DAY);
      account.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
