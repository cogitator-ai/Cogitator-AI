import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryTokenStore } from '../feeds/token-store';
import { FeedError } from '../feeds/errors';

interface Session {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
  active: boolean;
}

const state = vi.hoisted(() => ({
  logins: [] as Array<{ identifier: string; password: string }>,
  resumed: [] as Session[],
  posts: [] as Array<Record<string, unknown>>,
  uploads: [] as Array<{ size: number; encoding: string }>,
  deleted: [] as string[],
  existing: new Map<string, { uri: string; cid: string; record: unknown }>(),
  failPost: undefined as unknown,
  badResume: false,
}));

vi.mock('@atproto/api', () => {
  class CredentialSession {
    session?: Session;
    constructor(
      readonly serviceUrl: URL,
      readonly fetch: unknown,
      readonly persist: (event: string, session?: Session) => Promise<void> | void
    ) {}
    async login(opts: { identifier: string; password: string }) {
      state.logins.push(opts);
      this.session = {
        did: 'did:plc:newsroom',
        handle: opts.identifier,
        accessJwt: 'access-1',
        refreshJwt: 'refresh-1',
        active: true,
      };
      await this.persist('create', this.session);
    }
    async resumeSession(session: Session) {
      if (state.badResume)
        throw Object.assign(new Error('expired'), { status: 400, error: 'ExpiredToken' });
      state.resumed.push(session);
      this.session = session;
      await this.persist('update', session);
    }
  }
  class Agent {
    constructor(readonly sessionManager: CredentialSession) {}
    get did() {
      return this.sessionManager.session?.did;
    }
    async post(record: Record<string, unknown>) {
      if (state.failPost) throw state.failPost;
      state.posts.push(record);
      return {
        uri: `at://did:plc:newsroom/app.bsky.feed.post/rkey${state.posts.length}`,
        cid: 'cid',
      };
    }
    async deletePost(uri: string) {
      state.deleted.push(uri);
    }
    async uploadBlob(bytes: Uint8Array, opts: { encoding: string }) {
      state.uploads.push({ size: bytes.byteLength, encoding: opts.encoding });
      return { data: { blob: { ref: `blob${state.uploads.length}`, mimeType: opts.encoding } } };
    }
    async getPosts({ uris }: { uris: string[] }) {
      return { data: { posts: uris.map((uri) => state.existing.get(uri)).filter(Boolean) } };
    }
  }
  class RichText {
    text: string;
    facets?: Array<Record<string, unknown>>;
    constructor({ text }: { text: string }) {
      this.text = text;
    }
    async detectFacets() {
      const links = [...this.text.matchAll(/https?:\/\/\S+/g)];
      if (links.length) {
        this.facets = links.map((match) => ({
          index: { byteStart: match.index, byteEnd: (match.index ?? 0) + match[0].length },
          features: [{ $type: 'app.bsky.richtext.facet#link', uri: match[0] }],
        }));
      }
    }
  }
  return { CredentialSession, Agent, RichText };
});

const { BlueskyFeed, blueskyPostUrl } = await import('../channels/bluesky/feed');
const { BlueskyAccount } = await import('../channels/bluesky/account');

const png = (size: number) => ({
  type: 'image' as const,
  mimeType: 'image/png',
  buffer: new Uint8Array(size),
});

function feed(store = new MemoryTokenStore()) {
  return new BlueskyFeed({ identifier: 'newsroom.bsky.social', appPassword: 'app-pass', store });
}

beforeEach(() => {
  state.logins.length = 0;
  state.resumed.length = 0;
  state.posts.length = 0;
  state.uploads.length = 0;
  state.deleted.length = 0;
  state.existing.clear();
  state.failPost = undefined;
  state.badResume = false;
});

describe('BlueskyFeed', () => {
  it('signs in with the app password once and keeps the session in the store', async () => {
    const store = new MemoryTokenStore();
    const first = feed(store);
    await first.publish({ text: 'one' });
    await first.publish({ text: 'two' });
    expect(state.logins).toEqual([{ identifier: 'newsroom.bsky.social', password: 'app-pass' }]);
    const saved = await store.get('bluesky:newsroom.bsky.social');
    expect(JSON.parse(saved?.value ?? '{}')).toMatchObject({ did: 'did:plc:newsroom' });

    await feed(store).publish({ text: 'after a restart' });
    expect(state.logins).toHaveLength(1);
    expect(state.resumed).toHaveLength(1);
  });

  it('signs in again when the stored session cannot be resumed', async () => {
    const store = new MemoryTokenStore();
    await store.set('bluesky:newsroom.bsky.social', { value: '{"did":"x"}', issuedAt: 1 });
    state.badResume = true;
    await feed(store).publish({ text: 'hello' });
    expect(state.logins).toHaveLength(1);
  });

  it('posts the text with its link facets, tags and languages', async () => {
    const published = await feed().publish({
      text: 'Read https://example.com/story',
      tags: ['#ai', 'news'],
      langs: ['en'],
    });
    expect(state.posts[0]).toMatchObject({
      $type: 'app.bsky.feed.post',
      text: 'Read https://example.com/story',
      tags: ['ai', 'news'],
      langs: ['en'],
      facets: [{ features: [{ uri: 'https://example.com/story' }] }],
    });
    expect(published).toMatchObject({
      feed: 'bluesky',
      id: 'at://did:plc:newsroom/app.bsky.feed.post/rkey1',
      url: 'https://bsky.app/profile/did:plc:newsroom/post/rkey1',
    });
  });

  it('uploads the link preview first and attaches the card', async () => {
    await feed().publish({
      text: 'Story',
      link: {
        url: 'https://example.com/story',
        title: 'The story',
        description: 'What happened',
        image: png(1000),
      },
    });
    expect(state.uploads).toEqual([{ size: 1000, encoding: 'image/png' }]);
    expect(state.posts[0].embed).toEqual({
      $type: 'app.bsky.embed.external',
      external: {
        uri: 'https://example.com/story',
        title: 'The story',
        description: 'What happened',
        thumb: { ref: 'blob1', mimeType: 'image/png' },
      },
    });
  });

  it('uploads images with their alt text and aspect ratio', async () => {
    await feed().publish({
      text: '',
      images: [
        { image: png(10), alt: 'A chart', aspectRatio: { width: 4, height: 3 } },
        { image: png(20) },
      ],
    });
    expect(state.posts[0].embed).toEqual({
      $type: 'app.bsky.embed.images',
      images: [
        {
          image: { ref: 'blob1', mimeType: 'image/png' },
          alt: 'A chart',
          aspectRatio: { width: 4, height: 3 },
        },
        { image: { ref: 'blob2', mimeType: 'image/png' }, alt: '' },
      ],
    });
  });

  it('downloads a preview given by URL, refusing one over the limit', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(new Uint8Array(500), { headers: { 'content-length': '500' } })
    );
    const withFetch = new BlueskyFeed({
      identifier: 'newsroom.bsky.social',
      appPassword: 'app-pass',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await withFetch.publish({
      text: 'Story',
      link: {
        url: 'https://example.com',
        image: { type: 'image', mimeType: 'image/jpeg', url: 'https://cdn/x.jpg' },
      },
    });
    expect(state.uploads).toEqual([{ size: 500, encoding: 'image/jpeg' }]);

    fetchImpl.mockResolvedValueOnce(
      new Response(new Uint8Array(10), { headers: { 'content-length': '2000000' } })
    );
    await expect(
      withFetch.publish({
        text: 'Story',
        link: {
          url: 'https://example.com',
          image: { type: 'image', mimeType: 'image/jpeg', url: 'https://cdn/big.jpg' },
        },
      })
    ).rejects.toMatchObject({ code: 'invalid_post' });
  });

  it('places a reply in the thread of the post it answers', async () => {
    state.existing.set('at://did:plc:x/app.bsky.feed.post/child', {
      uri: 'at://did:plc:x/app.bsky.feed.post/child',
      cid: 'child-cid',
      record: {
        reply: { root: { uri: 'at://did:plc:x/app.bsky.feed.post/root', cid: 'root-cid' } },
      },
    });
    state.existing.set('at://did:plc:x/app.bsky.feed.post/top', {
      uri: 'at://did:plc:x/app.bsky.feed.post/top',
      cid: 'top-cid',
      record: { text: 'top' },
    });
    const bluesky = feed();
    await bluesky.publish({ text: 'deep', replyTo: 'at://did:plc:x/app.bsky.feed.post/child' });
    await bluesky.publish({ text: 'first', replyTo: 'at://did:plc:x/app.bsky.feed.post/top' });
    expect(state.posts[0].reply).toEqual({
      root: { uri: 'at://did:plc:x/app.bsky.feed.post/root', cid: 'root-cid' },
      parent: { uri: 'at://did:plc:x/app.bsky.feed.post/child', cid: 'child-cid' },
    });
    expect(state.posts[1].reply).toEqual({
      root: { uri: 'at://did:plc:x/app.bsky.feed.post/top', cid: 'top-cid' },
      parent: { uri: 'at://did:plc:x/app.bsky.feed.post/top', cid: 'top-cid' },
    });
    await expect(
      bluesky.publish({ text: 'x', replyTo: 'at://did:plc:x/app.bsky.feed.post/gone' })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it.each([
    ['too many graphemes', { text: 'a'.repeat(301) }, '301 graphemes'],
    ['too many bytes', { text: '👨‍👩‍👧'.repeat(200) }, 'bytes'],
    [
      'images and a link',
      { text: 'x', link: { url: 'https://a' }, images: [{ image: png(1) }] },
      'either images or a link',
    ],
    [
      'five images',
      { text: 'x', images: Array.from({ length: 5 }, () => ({ image: png(1) })) },
      '5 images',
    ],
    ['an image too large', { text: 'x', images: [{ image: png(2_000_001) }] }, '2000001 bytes'],
    [
      'a file as an image',
      {
        text: 'x',
        images: [
          {
            image: {
              type: 'file' as const,
              mimeType: 'application/pdf',
              buffer: new Uint8Array(1),
            },
          },
        ],
      },
      'must be an image',
    ],
    ['nine tags', { text: 'x', tags: Array.from({ length: 9 }, (_, i) => `t${i}`) }, '9 tags'],
    ['an empty post', { text: '  ' }, 'empty'],
  ])('refuses %s before sending anything', async (_name, post, message) => {
    const error = await feed()
      .publish(post)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FeedError);
    expect(error).toMatchObject({ code: 'invalid_post' });
    expect((error as Error).message).toContain(message);
    expect(state.posts).toEqual([]);
  });

  it('turns a rate limit into a retryable error with the wait Bluesky asked for', async () => {
    const reset = Math.floor(Date.now() / 1000) + 30;
    state.failPost = Object.assign(new Error('Rate Limit Exceeded'), {
      status: 429,
      error: 'RateLimitExceeded',
      headers: { 'ratelimit-reset': String(reset) },
    });
    const error = (await feed()
      .publish({ text: 'x' })
      .catch((caught: unknown) => caught)) as FeedError;
    expect(error.code).toBe('rate_limited');
    expect(error.retryable).toBe(true);
    expect(error.retryAfter).toBeGreaterThan(25_000);
  });

  it('deletes a post and builds post URLs from URIs', async () => {
    await feed().delete('at://did:plc:newsroom/app.bsky.feed.post/abc');
    expect(state.deleted).toEqual(['at://did:plc:newsroom/app.bsky.feed.post/abc']);
    expect(() => blueskyPostUrl('https://bsky.app')).toThrow('Not a Bluesky post URI');
  });

  it('shares one session between feeds of one account', async () => {
    const account = new BlueskyAccount({ identifier: 'newsroom.bsky.social', appPassword: 'p' });
    await new BlueskyFeed({ account }).publish({ text: 'a' });
    await new BlueskyFeed({ account }).publish({ text: 'b' });
    expect(state.logins).toHaveLength(1);
    expect(await account.did()).toBe('did:plc:newsroom');
  });
});
