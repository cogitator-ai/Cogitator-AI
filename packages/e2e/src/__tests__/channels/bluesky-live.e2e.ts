import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crc32, deflateSync } from 'node:zlib';
import {
  BlueskyAccount,
  BlueskyChannel,
  BlueskyFeed,
  FeedError,
  FileTokenStore,
  graphemeLength,
  splitText,
} from '@cogitator-ai/channels';

const identifier = process.env.BLUESKY_HANDLE;
const appPassword = process.env.BLUESKY_APP_PASSWORD;
const service = process.env.BLUESKY_SERVICE;
const APPVIEW = 'https://public.api.bsky.app/xrpc';

/**
 * Publishes to a real Bluesky account (BLUESKY_HANDLE, BLUESKY_APP_PASSWORD, and BLUESKY_SERVICE
 * for a PDS other than bsky.social) and reads the posts back from the public AppView. Every post
 * it makes is deleted at the end. The session is kept in ~/.cogitator/tokens.json under a key of
 * its own, so it never takes over the session of a bot on the same account.
 */
const describeLive = identifier && appPassword ? describe : describe.skip;

function png(size: number, [r, g, b]: [number, number, number]): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(size).fill([r, g, b]).flat())]);
  const pixels = deflateSync(Buffer.concat(Array<Buffer>(size).fill(row)));
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', pixels),
      chunk('IEND', Buffer.alloc(0)),
    ])
  );
}

interface AppViewPost {
  uri: string;
  author: { did: string };
  record: {
    text: string;
    facets?: { features: { $type: string }[] }[];
    tags?: string[];
    langs?: string[];
    reply?: { root: { uri: string }; parent: { uri: string } };
  };
  embed?: { $type: string; images?: { alt: string }[]; external?: { uri: string; thumb?: string } };
}

interface ThreadView {
  post: AppViewPost;
  replies?: ThreadView[];
}

async function appView<T>(method: string, params: Record<string, string | string[]>): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  }
  const response = await fetch(`${APPVIEW}/${method}?${query}`);
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 20 && !done(value); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    value = await read();
  }
  return value;
}

const postsOf = (uri: string) =>
  appView<{ posts: AppViewPost[] }>('app.bsky.feed.getPosts', { uris: [uri] }).then(
    ({ posts }) => posts
  );

/** The post as the AppView shows it, once the network has indexed it. */
async function indexed(uri: string): Promise<AppViewPost> {
  const [post] = await eventually(
    () => postsOf(uri),
    (posts) => posts.length > 0
  );
  if (!post) throw new Error(`${uri} never showed up on the AppView`);
  return post;
}

function descendants(thread: ThreadView, did: string): string[] {
  return (thread.replies ?? []).flatMap((reply) => [
    ...(reply.post.author.did === did ? [reply.post.uri] : []),
    ...descendants(reply, did),
  ]);
}

describeLive('Bluesky on the live network', () => {
  const published: string[] = [];
  const stamp = new Date().toISOString();
  let account: BlueskyAccount;
  let feed: BlueskyFeed;
  let channel: BlueskyChannel;
  let did = '';
  let root = '';

  beforeAll(async () => {
    account = new BlueskyAccount({
      identifier: identifier ?? '',
      appPassword: appPassword ?? '',
      ...(service && { service }),
      store: new FileTokenStore(),
      storeKey: `bluesky:e2e:${identifier}`,
    });
    feed = new BlueskyFeed({ account });
    channel = new BlueskyChannel({ account, directMessages: false });
    did = await account.did();
  });

  afterAll(async () => {
    for (const uri of published.reverse()) await feed.delete(uri).catch(() => {});
  });

  it('publishes a post with facets, tags and a link card with an uploaded preview', async () => {
    const post = await feed.publish({
      text: `Cogitator e2e ${stamp} #cogitator https://cogitator.app`,
      link: {
        url: 'https://cogitator.app',
        title: 'Cogitator',
        description: 'A link card from the e2e suite',
        image: { type: 'image', mimeType: 'image/png', buffer: png(64, [46, 111, 158]) },
      },
      tags: ['e2e'],
      langs: ['en'],
    });
    published.push(post.id);
    root = post.id;

    expect(post.feed).toBe('bluesky');
    expect(post.id.startsWith(`at://${did}/app.bsky.feed.post/`)).toBe(true);
    expect(post.url).toBe(`https://bsky.app/profile/${did}/post/${post.id.split('/').pop() ?? ''}`);

    const seen = await indexed(post.id);
    const features = (seen.record.facets ?? []).flatMap((facet) =>
      facet.features.map((feature) => feature.$type)
    );
    expect(features).toEqual(
      expect.arrayContaining(['app.bsky.richtext.facet#tag', 'app.bsky.richtext.facet#link'])
    );
    expect(seen.record.tags).toEqual(['e2e']);
    expect(seen.record.langs).toEqual(['en']);
    expect(seen.embed?.external?.uri).toBe('https://cogitator.app');
    expect(seen.embed?.external?.thumb).toBeTruthy();
  }, 60_000);

  it('publishes images with alt text in reply to the first post', async () => {
    const post = await feed.publish({
      text: 'Two squares, with alt text',
      images: [
        {
          image: { type: 'image', mimeType: 'image/png', buffer: png(48, [200, 60, 60]) },
          alt: 'A red square',
          aspectRatio: { width: 1, height: 1 },
        },
        {
          image: { type: 'image', mimeType: 'image/png', buffer: png(48, [60, 160, 90]) },
          alt: 'A green square',
        },
      ],
      replyTo: root,
    });
    published.push(post.id);

    const seen = await indexed(post.id);
    expect(seen.embed?.images?.map((image) => image.alt)).toEqual([
      'A red square',
      'A green square',
    ]);
    expect(seen.record.reply).toEqual({
      root: expect.objectContaining({ uri: root }),
      parent: expect.objectContaining({ uri: root }),
    });
  }, 60_000);

  it('answers under a post as a thread of posts within 300 graphemes', async () => {
    const answer = Array.from(
      { length: 12 },
      (_, index) => `Sentence ${index + 1} of a long answer that does not fit in one post.`
    ).join(' ');
    const first = await channel.sendText(`post:${root}`, answer);
    published.push(first);

    const seen = await indexed(first);
    expect(seen.record.reply?.parent.uri).toBe(root);
    expect([...new Intl.Segmenter().segment(seen.record.text)].length).toBeLessThanOrEqual(300);

    const parts = splitText(answer, 300, graphemeLength).length;
    const chain = await eventually(
      async () => {
        const { thread } = await appView<{ thread: ThreadView }>('app.bsky.feed.getPostThread', {
          uri: first,
          depth: '20',
        });
        return descendants(thread, did);
      },
      (uris) => uris.length >= parts - 1
    );
    published.push(...chain);
    expect(parts).toBeGreaterThan(1);
    expect(chain).toHaveLength(parts - 1);
  }, 90_000);

  it('rejects a post over the limit before sending it', async () => {
    await expect(feed.publish({ text: 'x'.repeat(301) })).rejects.toMatchObject({
      code: 'invalid_post',
    });
    await expect(feed.publish({ text: 'x'.repeat(301) })).rejects.toBeInstanceOf(FeedError);
  });

  it('deletes a post', async () => {
    const post = await feed.publish({ text: `Deleted right away ${stamp}` });
    await feed.delete(post.id);
    await indexed(post.id).catch(() => undefined);
    const posts = await eventually(
      () => postsOf(post.id),
      (found) => found.length === 0
    );
    expect(posts).toEqual([]);
  }, 60_000);
});
