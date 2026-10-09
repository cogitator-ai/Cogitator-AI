import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FeedError,
  FileTokenStore,
  ThreadsAccount,
  ThreadsChannel,
  ThreadsFeed,
} from '@cogitator-ai/channels';

const accessToken = process.env.THREADS_ACCESS_TOKEN;
const imageUrl = process.env.THREADS_TEST_IMAGE_URL;
const renew = process.env.THREADS_E2E_RENEW === '1';

/**
 * Publishes to a real Threads account with a long-lived token (THREADS_ACCESS_TOKEN) and reads the
 * posts back from the Graph API. Every post it makes is deleted at the end, which needs the
 * threads_delete permission. The token is kept in ~/.cogitator/tokens.json under a key of its own,
 * so a renewal made here is not lost. Images need a public URL (THREADS_TEST_IMAGE_URL), and the
 * forced renewal runs only with THREADS_E2E_RENEW=1, on a token at least a day old.
 */
const describeLive = accessToken ? describe : describe.skip;

interface ThreadsMedia {
  id: string;
  text?: string;
  permalink?: string;
  topic_tag?: string;
  link_attachment_url?: string;
  media_type?: string;
  alt_text?: string;
  replied_to?: { id: string };
  root_post?: { id: string };
}

describeLive('Threads on the live Graph API', () => {
  const store = new FileTokenStore();
  const published: string[] = [];
  const stamp = new Date().toISOString();
  let account: ThreadsAccount;
  let feed: ThreadsFeed;
  let channel: ThreadsChannel;
  let root = '';

  beforeAll(() => {
    account = new ThreadsAccount({
      accessToken: accessToken ?? '',
      store,
      storeKey: 'threads:e2e',
    });
    feed = new ThreadsFeed({ account });
    channel = new ThreadsChannel({ account });
  });

  const media = (id: string) =>
    account.get<ThreadsMedia>(`/${id}`, {
      fields:
        'id,text,permalink,topic_tag,link_attachment_url,media_type,alt_text,replied_to,root_post',
    });

  afterAll(async () => {
    for (const id of published.reverse()) await feed.delete(id).catch(() => {});
    await feed.close();
    account.close();
  });

  it('publishes a text post with a link card and a topic tag', async () => {
    const post = await feed.publish({
      text: `Cogitator e2e ${stamp}: https://cogitator.app`,
      link: { url: 'https://cogitator.app' },
      tags: ['Cogitator'],
    });
    published.push(post.id);
    root = post.id;

    expect(post.feed).toBe('threads');
    expect(post.url).toMatch(/^https:\/\/www\.threads\.(net|com)\//);

    const seen = await media(post.id);
    expect(seen.text).toContain(stamp);
    expect(seen.topic_tag).toBe('Cogitator');
    expect(seen.link_attachment_url).toBe('https://cogitator.app');
  }, 360_000);

  it('answers under a post through the channel', async () => {
    const id = await channel.sendText(`post:${root}`, `A reply from the e2e suite, ${stamp}`);
    published.push(id);

    const seen = await media(id);
    expect(seen.replied_to?.id).toBe(root);
    expect(seen.root_post?.id).toBe(root);
  }, 360_000);

  it.skipIf(!imageUrl)(
    'publishes an image with alt text',
    async () => {
      const post = await feed.publish({
        text: 'An image from the e2e suite',
        images: [
          {
            image: { type: 'image', mimeType: 'image/jpeg', url: imageUrl ?? '' },
            alt: 'A test image',
          },
        ],
      });
      published.push(post.id);

      const seen = await media(post.id);
      expect(seen.media_type).toBe('IMAGE');
      expect(seen.alt_text).toBe('A test image');
    },
    360_000
  );

  it('rejects a post over the limits before sending it', async () => {
    await expect(feed.publish({ text: 'x'.repeat(501) })).rejects.toMatchObject({
      code: 'invalid_post',
    });
    await expect(feed.publish({ text: 'x', tags: ['has.dot'] })).rejects.toBeInstanceOf(FeedError);
  });

  it.skipIf(!renew)(
    'renews the long-lived token and keeps it in the store',
    async () => {
      const before = await store.get('threads:e2e');
      await account.renewToken();
      const after = await store.get('threads:e2e');
      expect(after?.value).toBeTruthy();
      expect(after?.issuedAt).toBeGreaterThan(before?.issuedAt ?? 0);
      expect(after?.expiresAt).toBeGreaterThan(Date.now() + 50 * 24 * 3600_000);
      await expect(media(root)).resolves.toMatchObject({ id: root });
    },
    60_000
  );
});
