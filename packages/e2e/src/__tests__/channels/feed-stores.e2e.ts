import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  FeedPublisher,
  PostgresPublishStore,
  PostgresTokenStore,
  graphemeLength,
  type PublishJob,
} from '@cogitator-ai/channels';
import type { FeedChannel, FeedPost, PublishedPost } from '@cogitator-ai/types';

const describePostgres = process.env.TEST_POSTGRES_URL ? describe : describe.skip;

function job(id: string, dueAt: number, key?: string): PublishJob {
  return {
    id,
    ...(key ? { key } : {}),
    post: {
      text: `post ${id}`,
      images: [
        { image: { type: 'image', mimeType: 'image/png', buffer: new Uint8Array([1, 2, 3]) } },
      ],
    },
    createdAt: dueAt,
    deliveries: [{ feed: 'bluesky', status: 'pending', attempts: 0, nextAttemptAt: dueAt }],
  };
}

function countingFeed(sent: FeedPost[]): FeedChannel {
  return {
    type: 'bluesky',
    limits: { maxLength: 300, maxImages: 4, maxImageBytes: 2_000_000, maxTags: 8 },
    measure: graphemeLength,
    connect: async () => undefined,
    close: async () => undefined,
    delete: async () => undefined,
    publish: async (post): Promise<PublishedPost> => {
      sent.push(post);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        feed: 'bluesky',
        id: `at://${sent.length}`,
        url: 'https://bsky.app',
        publishedAt: new Date(),
      };
    },
  };
}

describePostgres('Postgres feed stores', () => {
  let pool: pg.Pool;
  const tables: string[] = [];
  const table = (name: string) => {
    const unique = `${name}_${Date.now()}_${tables.length}`;
    tables.push(unique);
    return unique;
  };

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_POSTGRES_URL });
  });

  afterAll(async () => {
    for (const name of tables) await pool.query(`DROP TABLE IF EXISTS ${name}`);
    await pool.end();
  });

  it('keeps tokens with their lifetimes, shared between store instances', async () => {
    const name = table('feed_tokens');
    const first = new PostgresTokenStore({ client: pool, table: name });
    const second = new PostgresTokenStore({ client: pool, table: name });
    await Promise.all([first.get('warm-up'), second.get('warm-up')]);
    await first.set('threads', { value: 'token-1', issuedAt: 1, expiresAt: 2 });
    expect(await second.get('threads')).toEqual({ value: 'token-1', issuedAt: 1, expiresAt: 2 });
    await second.set('threads', { value: 'token-2', issuedAt: 3 });
    expect(await first.get('threads')).toEqual({ value: 'token-2', issuedAt: 3 });
    await first.delete('threads');
    expect(await second.get('threads')).toBeUndefined();
  });

  it('adds a job once per key and keeps attachment bytes', async () => {
    const store = new PostgresPublishStore({ client: pool, table: table('feed_jobs') });
    const first = await store.add(job('a', 100, 'story-1'));
    const again = await store.add(job('b', 100, 'story-1'));
    expect(again.id).toBe(first.id);
    const stored = await store.get('a');
    expect([...(stored?.post.images?.[0]?.image.buffer ?? [])]).toEqual([1, 2, 3]);
    expect((await store.list()).map((j) => j.id)).toEqual(['a']);
  });

  it('splits due jobs between workers that claim at the same time', async () => {
    const name = table('feed_jobs');
    const workers = [0, 1, 2].map(() => new PostgresPublishStore({ client: pool, table: name }));
    await workers[0].list();
    for (let i = 0; i < 12; i++) await workers[0].add(job(`job-${i}`, 100 + i));
    const claims = await Promise.all(
      workers.map((store) => store.claimDue(10_000, { limit: 5, ttl: 60_000 }))
    );
    const ids = claims.flat().map((j) => j.id);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    const held = claims[0][0].id;
    expect(await workers[1].claim(held, 60_000)).toBe(false);
    expect(await workers[0].claim(held, 60_000)).toBe(true);
    expect(await workers[1].remove(held)).toBe(false);
    await workers[0].release(held);
    expect(await workers[1].remove(held)).toBe(true);
  });

  it('publishes a post once when two publishers run the same due job', async () => {
    const name = table('feed_jobs');
    const sent: FeedPost[] = [];
    const publishers = [0, 1].map(
      () =>
        new FeedPublisher({
          feeds: [countingFeed(sent)],
          store: new PostgresPublishStore({ client: pool, table: name }),
        })
    );
    const scheduled = await publishers[0].publish(
      { text: 'Once only' },
      { publishAt: Date.now() + 100 }
    );
    expect(scheduled.pending).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await Promise.all(publishers.map((publisher) => publisher.tick()));
    expect(sent).toHaveLength(1);
    const done = await publishers[1].get(scheduled.job.id);
    expect(done?.deliveries[0]).toMatchObject({ status: 'published', attempts: 1 });
    expect(await publishers[1].list({ pending: true })).toEqual([]);
  });
});
