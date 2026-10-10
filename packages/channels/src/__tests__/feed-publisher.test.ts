import { describe, expect, it, vi } from 'vitest';
import type { FeedChannel, FeedPost, PublishedPost } from '@cogitator-ai/types';
import { FeedError } from '../feeds/errors';
import { FeedPublisher, type FeedFailedEvent } from '../feeds/publisher';
import { MemoryPublishStore, type PublishJob } from '../feeds/publish-store';
import { graphemeLength } from '../feeds/text';

interface FakeFeed extends FeedChannel {
  sent: FeedPost[];
  keys: Array<string | undefined>;
  retries: Array<boolean | undefined>;
  failWith: Error[];
  /** Runs inside each publish call, before it succeeds or fails. */
  during?: () => Promise<void>;
}

function fakeFeed(type: string, maxLength = 300, maxBytes?: number): FakeFeed {
  let issued = 0;
  const feed: FakeFeed = {
    type,
    sent: [],
    keys: [],
    retries: [],
    failWith: [],
    limits: {
      maxLength,
      ...(maxBytes !== undefined && { maxBytes }),
      maxImages: 4,
      maxImageBytes: 1_000_000,
      maxTags: 8,
    },
    measure: graphemeLength,
    connect: async () => undefined,
    close: async () => undefined,
    delete: async () => undefined,
    idempotencyKey: () => `${type}-key-${++issued}`,
    publish: async (post, options): Promise<PublishedPost> => {
      feed.keys.push(options?.idempotencyKey);
      feed.retries.push(options?.retry);
      await feed.during?.();
      const error = feed.failWith.shift();
      if (error) throw error;
      feed.sent.push(post);
      return {
        feed: type,
        id: `${type}-${feed.sent.length}`,
        url: `https://${type}.example/${feed.sent.length}`,
        publishedAt: new Date(0),
      };
    },
  };
  return feed;
}

function setup(
  options: { maxLength?: number; overflow?: 'truncate' | 'fail'; dryRun?: boolean } = {}
) {
  let clock = 1_000_000;
  const now = () => clock;
  const bluesky = fakeFeed('bluesky', options.maxLength ?? 300);
  const threads = fakeFeed('threads', 500);
  const failed: FeedFailedEvent[] = [];
  const published: string[] = [];
  const publisher = new FeedPublisher({
    feeds: [bluesky, threads],
    store: new MemoryPublishStore(now),
    now,
    retry: { maxAttempts: 3, baseDelay: 1_000, maxDelay: 10_000 },
    ...(options.overflow && { overflow: options.overflow }),
    ...(options.dryRun && { dryRun: true }),
    onPublished: ({ feed }) => void published.push(feed),
    onFailed: (event) => void failed.push(event),
  });
  return {
    publisher,
    bluesky,
    threads,
    failed,
    published,
    advance: (ms: number) => {
      clock += ms;
    },
    now,
  };
}

describe('FeedPublisher', () => {
  it('publishes to every feed and saves each outcome', async () => {
    const { publisher, bluesky, threads, published } = setup();
    const outcome = await publisher.publish({ text: 'Hello feeds' });
    expect(outcome.pending).toBe(false);
    expect(outcome.duplicate).toBe(false);
    expect(bluesky.sent).toEqual([{ text: 'Hello feeds' }]);
    expect(threads.sent).toEqual([{ text: 'Hello feeds' }]);
    expect(published).toEqual(['bluesky', 'threads']);
    const stored = await publisher.get(outcome.job.id);
    expect(stored?.deliveries.map((d) => [d.feed, d.status, d.post?.url])).toEqual([
      ['bluesky', 'published', 'https://bluesky.example/1'],
      ['threads', 'published', 'https://threads.example/1'],
    ]);
  });

  it('fits the text to each feed, or fails that feed when asked to', async () => {
    const long = `${'word '.repeat(80)}end`;
    const fits = setup({ maxLength: 50 });
    await fits.publisher.publish({ text: long });
    expect(graphemeLength(fits.bluesky.sent[0].text)).toBeLessThanOrEqual(50);
    expect(fits.bluesky.sent[0].text.endsWith('…')).toBe(true);
    expect(fits.threads.sent[0].text).toBe(long);

    const strict = setup({ maxLength: 50, overflow: 'fail' });
    const outcome = await strict.publisher.publish({ text: long });
    expect(strict.bluesky.sent).toEqual([]);
    expect(strict.threads.sent).toHaveLength(1);
    expect(outcome.job.deliveries[0]).toMatchObject({
      status: 'failed',
      error: { code: 'invalid_post' },
    });
    expect(strict.failed[0]).toMatchObject({ feed: 'bluesky', final: true });
  });

  it('retries a feed that can succeed later, after the wait it asked for, without resending the others', async () => {
    const { publisher, bluesky, threads, failed, advance } = setup();
    bluesky.failWith.push(
      new FeedError('bluesky', 'rate_limited', 'slow down', { retryAfter: 5_000 })
    );
    const outcome = await publisher.publish({ text: 'Retry me' });
    expect(outcome.pending).toBe(true);
    expect(threads.sent).toHaveLength(1);
    expect(failed).toMatchObject([{ feed: 'bluesky', final: false }]);

    await publisher.tick();
    expect(bluesky.sent).toEqual([]);

    advance(5_000);
    await publisher.tick();
    expect(bluesky.sent).toEqual([{ text: 'Retry me' }]);
    expect(threads.sent).toHaveLength(1);
    const done = await publisher.get(outcome.job.id);
    expect(done?.deliveries.map((d) => [d.status, d.attempts])).toEqual([
      ['published', 2],
      ['published', 1],
    ]);
  });

  it('gives up after the last attempt and at once on an error retrying cannot fix', async () => {
    const { publisher, bluesky, threads, failed, advance } = setup();
    for (let i = 0; i < 3; i++)
      bluesky.failWith.push(new FeedError('bluesky', 'unavailable', 'down'));
    threads.failWith.push(new FeedError('threads', 'auth', 'bad token'));
    const outcome = await publisher.publish({ text: 'Doomed' });
    advance(1_000);
    await publisher.tick();
    advance(2_000);
    await publisher.tick();
    const done = await publisher.get(outcome.job.id);
    expect(done?.deliveries.map((d) => [d.feed, d.status, d.attempts])).toEqual([
      ['bluesky', 'failed', 3],
      ['threads', 'failed', 1],
    ]);
    expect(
      failed
        .filter((event) => event.final)
        .map((event) => event.feed)
        .sort()
    ).toEqual(['bluesky', 'threads']);
  });

  it('publishes once per key', async () => {
    const { publisher, bluesky } = setup();
    const first = await publisher.publish({ text: 'Once' }, { key: 'story-42' });
    const second = await publisher.publish({ text: 'Once' }, { key: 'story-42' });
    expect(second.duplicate).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(bluesky.sent).toHaveLength(1);
  });

  it('schedules a post for later and publishes it when it is due', async () => {
    const { publisher, bluesky, advance, now } = setup();
    const outcome = await publisher.publish({ text: 'Later' }, { publishAt: now() + 60_000 });
    expect(outcome.pending).toBe(true);
    await publisher.tick();
    expect(bluesky.sent).toEqual([]);
    advance(60_000);
    await publisher.tick();
    expect(bluesky.sent).toEqual([{ text: 'Later' }]);
  });

  it('cancels a scheduled post before it goes out', async () => {
    const { publisher, bluesky, advance, now } = setup();
    const outcome = await publisher.publish({ text: 'Never' }, { publishAt: now() + 1_000 });
    expect(await publisher.cancel(outcome.job.id)).toBe(true);
    advance(1_000);
    await publisher.tick();
    expect(bluesky.sent).toEqual([]);
  });

  it('publishes to the feeds asked for only', async () => {
    const { publisher, bluesky, threads } = setup();
    await publisher.publish({ text: 'Only Threads' }, { feeds: ['threads'] });
    expect(bluesky.sent).toEqual([]);
    expect(threads.sent).toHaveLength(1);
    await expect(publisher.publish({ text: 'x' }, { feeds: ['mastodon'] })).rejects.toThrow(
      'Unknown feed "mastodon"'
    );
  });

  it('goes through every step but publishing in a dry run', async () => {
    const { publisher, bluesky, published } = setup({ dryRun: true });
    const outcome = await publisher.publish({ text: 'Dry' });
    expect(bluesky.sent).toEqual([]);
    expect(published).toEqual(['bluesky', 'threads']);
    expect(outcome.job.deliveries[0].post?.id).toMatch(/^dry-run:/);
  });

  it('keeps one idempotency key per delivery from before its first attempt until it is published', async () => {
    const { publisher, bluesky, threads, advance } = setup();
    let saved: PublishJob | undefined;
    bluesky.during = async () => {
      saved ??= (await publisher.list())[0];
    };
    bluesky.failWith.push(new FeedError('bluesky', 'unavailable', 'lost the answer'));
    const outcome = await publisher.publish({ text: 'Exactly once' });
    expect(saved?.deliveries[0]?.idempotencyKey).toBe('bluesky-key-1');
    advance(1_000);
    await publisher.tick();
    expect(bluesky.keys).toEqual(['bluesky-key-1', 'bluesky-key-1']);
    expect(bluesky.retries).toEqual([false, true]);
    expect(threads.keys).toEqual(['threads-key-1']);
    const done = await publisher.get(outcome.job.id);
    expect(done?.deliveries.map((d) => [d.status, d.idempotencyKey])).toEqual([
      ['published', undefined],
      ['published', undefined],
    ]);
  });

  it('waits for a full quota without spending attempts on it', async () => {
    const { publisher, threads, advance } = setup();
    for (let i = 0; i < 5; i++) {
      threads.failWith.push(
        new FeedError('threads', 'quota_exceeded', 'quota used', { retryAfter: 3_600_000 })
      );
    }
    const outcome = await publisher.publish({ text: 'Tomorrow maybe' }, { feeds: ['threads'] });
    for (let i = 0; i < 5; i++) {
      const job = await publisher.get(outcome.job.id);
      expect(job?.deliveries[0]).toMatchObject({ status: 'pending', attempts: 0 });
      advance(3_600_000);
      await publisher.tick();
    }
    const done = await publisher.get(outcome.job.id);
    expect(done?.deliveries[0]).toMatchObject({ status: 'published', attempts: 1 });
  });

  it('cuts a text to a limit in bytes as well', async () => {
    const bluesky = fakeFeed('bluesky', 300, 100);
    const publisher = new FeedPublisher({ feeds: [bluesky] });
    await publisher.publish({ text: `${'🙂 '.repeat(60)}end` });
    const sent = bluesky.sent[0]?.text ?? '';
    expect(new TextEncoder().encode(sent).length).toBeLessThanOrEqual(100);
    expect(sent.endsWith('…')).toBe(true);
  });

  it('keeps dry runs apart from real publications with the same key', async () => {
    const store = new MemoryPublishStore();
    const bluesky = fakeFeed('bluesky');
    await new FeedPublisher({ feeds: [bluesky], store, dryRun: true }).publish(
      { text: 'Rehearsal' },
      { key: 'launch' }
    );
    const real = await new FeedPublisher({ feeds: [bluesky], store }).publish(
      { text: 'Rehearsal' },
      { key: 'launch' }
    );
    expect(real.duplicate).toBe(false);
    expect(bluesky.sent).toHaveLength(1);
  });

  it('extends its claim while a slow feed publishes, so no other worker takes the job', async () => {
    const store = new MemoryPublishStore();
    const bluesky = fakeFeed('bluesky');
    const publisher = new FeedPublisher({ feeds: [bluesky], store, claimTtl: 60 });
    let takenOver: boolean | undefined;
    bluesky.during = async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const [job] = await store.list();
      takenOver = job ? await store.claim(job.id, { owner: 'other-worker', ttl: 60 }) : undefined;
    };
    const outcome = await publisher.publish({ text: 'Slow' });
    expect(takenOver).toBe(false);
    expect(outcome.job.deliveries[0]?.status).toBe('published');
    expect((await store.get(outcome.job.id))?.deliveries[0]?.status).toBe('published');
  });

  it('stops, without overwriting, once another worker took the job over', async () => {
    class LosingStore extends MemoryPublishStore {
      lose = false;
      override async save(job: PublishJob, owner: string): Promise<boolean> {
        return this.lose ? false : super.save(job, owner);
      }
    }
    const store = new LosingStore();
    const bluesky = fakeFeed('bluesky');
    const threads = fakeFeed('threads');
    bluesky.during = async () => {
      store.lose = true;
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const publisher = new FeedPublisher({ feeds: [bluesky, threads], store });
    await publisher.publish({ text: 'Contested' });
    expect(bluesky.sent).toHaveLength(1);
    expect(threads.sent).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('another worker took it over'));
    warn.mockRestore();
  });

  it('refuses feeds it cannot tell apart', () => {
    expect(() => new FeedPublisher({ feeds: [] })).toThrow('at least one feed');
    expect(() => new FeedPublisher({ feeds: [fakeFeed('x'), fakeFeed('x')] })).toThrow(
      'two feeds of type "x"'
    );
  });

  it('polls for due jobs once started, until stopped', async () => {
    vi.useFakeTimers();
    try {
      const { publisher } = setup();
      const tick = vi.spyOn(publisher, 'tick');
      publisher.start();
      await vi.advanceTimersByTimeAsync(45_000);
      expect(tick).toHaveBeenCalledTimes(4);
      await publisher.stop();
      await vi.advanceTimersByTimeAsync(45_000);
      expect(tick).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps going when a hook throws', async () => {
    const bluesky = fakeFeed('bluesky');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const publisher = new FeedPublisher({
      feeds: [bluesky],
      onPublished: () => {
        throw new Error('hook broke');
      },
    });
    const outcome = await publisher.publish({ text: 'Still saved' });
    expect(outcome.job.deliveries[0].status).toBe('published');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
