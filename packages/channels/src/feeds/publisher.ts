import { nanoid } from 'nanoid';
import type { FeedChannel, FeedPost, PublishedPost } from '@cogitator-ai/types';
import { FeedError } from './errors';
import {
  type FeedDelivery,
  MemoryPublishStore,
  type PublishJob,
  type PublishStore,
} from './publish-store';
import { fitText } from './text';

export interface FeedRetryOptions {
  /** Attempts per feed before it fails for good (default 5). */
  maxAttempts?: number;
  /** The wait before the second attempt, doubled for each one after, in ms (default 60 000). */
  baseDelay?: number;
  /** The longest wait between attempts, in ms (default one hour). */
  maxDelay?: number;
}

export interface FeedPublishedEvent {
  job: PublishJob;
  feed: string;
  post: PublishedPost;
}

export interface FeedFailedEvent {
  job: PublishJob;
  feed: string;
  error: Error;
  /** Whether the feed gave up: no attempt follows. */
  final: boolean;
}

export interface FeedPublisherOptions {
  feeds: FeedChannel[];
  /** Where jobs are kept (default in memory: scheduled and retried posts do not survive a restart). */
  store?: PublishStore;
  retry?: FeedRetryOptions;
  /** How often a started publisher looks for due jobs, in ms (default 15 000). */
  pollInterval?: number;
  /** How long a worker holds a job it publishes, in ms (default five minutes). */
  claimTtl?: number;
  /**
   * A text longer than a feed takes: `truncate` (default) cuts it at a word
   * with an ellipsis for that feed, `fail` fails that feed.
   */
  overflow?: 'truncate' | 'fail';
  /** Goes through every step but publishing. */
  dryRun?: boolean;
  onPublished?: (event: FeedPublishedEvent) => void | Promise<void>;
  onFailed?: (event: FeedFailedEvent) => void | Promise<void>;
  /** The clock, for tests. */
  now?: () => number;
}

export interface PublishOptions {
  /** The feeds to publish to, by type (default every feed of the publisher). */
  feeds?: string[];
  /** Publishing twice with the same key publishes once: the second call returns the first job. */
  key?: string;
  /** When to publish; a time in the future schedules the post. */
  publishAt?: Date | number;
}

export interface PublishOutcome {
  job: PublishJob;
  /** Whether the post waits for its time, or for another attempt, rather than being done. */
  pending: boolean;
  /** Whether a job with the same key existed, which is what `job` is. */
  duplicate: boolean;
}

const DEFAULT_RETRY: Required<FeedRetryOptions> = {
  maxAttempts: 5,
  baseDelay: 60_000,
  maxDelay: 60 * 60_000,
};

/**
 * Publishes posts to several feeds: now or at a time, each feed tried and
 * retried on its own, each outcome saved as soon as it is known. A post that
 * reached a feed is not sent there again when the job runs after a crash,
 * and a key makes the whole publication idempotent.
 */
export class FeedPublisher {
  private readonly feeds = new Map<string, FeedChannel>();
  private readonly store: PublishStore;
  private readonly retry: Required<FeedRetryOptions>;
  private readonly pollInterval: number;
  private readonly claimTtl: number;
  private readonly now: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;

  constructor(private readonly options: FeedPublisherOptions) {
    if (options.feeds.length === 0) throw new Error('FeedPublisher needs at least one feed');
    for (const feed of options.feeds) {
      if (this.feeds.has(feed.type)) {
        throw new Error(`FeedPublisher got two feeds of type "${feed.type}"`);
      }
      this.feeds.set(feed.type, feed);
    }
    this.now = options.now ?? Date.now;
    this.store = options.store ?? new MemoryPublishStore(this.now);
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    this.pollInterval = options.pollInterval ?? 15_000;
    this.claimTtl = options.claimTtl ?? 5 * 60_000;
  }

  /** Publishes `post` now, or schedules it with `publishAt`. */
  async publish(post: FeedPost, options: PublishOptions = {}): Promise<PublishOutcome> {
    const feeds = options.feeds ?? [...this.feeds.keys()];
    if (feeds.length === 0) throw new Error('No feed to publish to');
    for (const feed of feeds) {
      if (!this.feeds.has(feed)) {
        throw new Error(
          `Unknown feed "${feed}": the publisher has ${[...this.feeds.keys()].join(', ')}`
        );
      }
    }
    const now = this.now();
    const publishAt =
      options.publishAt === undefined
        ? now
        : typeof options.publishAt === 'number'
          ? options.publishAt
          : options.publishAt.getTime();
    const job: PublishJob = {
      id: `feedjob_${nanoid(12)}`,
      ...(options.key ? { key: options.key } : {}),
      post,
      createdAt: now,
      deliveries: [...new Set(feeds)].map((feed) => ({
        feed,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: publishAt,
      })),
    };
    const stored = await this.store.add(job);
    const duplicate = stored.id !== job.id;
    if (duplicate || publishAt > now || !(await this.store.claim(stored.id, this.claimTtl))) {
      return { job: stored, pending: stored.deliveries.some(isWaiting), duplicate };
    }
    try {
      const done = await this.process(stored);
      return { job: done, pending: done.deliveries.some(isWaiting), duplicate };
    } finally {
      await this.store.release(stored.id);
    }
  }

  /** Looks for due jobs every `pollInterval` until `stop()`: scheduled posts and retries. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.pollInterval);
    this.timer.unref?.();
    void this.tick();
  }

  /** Stops looking for due jobs and waits for the jobs being published. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.ticking;
  }

  /** Publishes the jobs that are due now, once; `start()` does this on a timer. */
  async tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      try {
        const jobs = await this.store.claimDue(this.now(), { limit: 10, ttl: this.claimTtl });
        for (const job of jobs) {
          try {
            await this.process(job);
          } finally {
            await this.store.release(job.id);
          }
        }
      } catch (error) {
        console.error('[feeds] Publishing due jobs failed:', error);
      }
    })().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  async get(id: string): Promise<PublishJob | undefined> {
    return this.store.get(id);
  }

  async list(filter?: { pending?: boolean }): Promise<PublishJob[]> {
    return this.store.list(filter);
  }

  /** Drops a job before it is published; `false` when it is missing or being published. */
  async cancel(id: string): Promise<boolean> {
    return this.store.remove(id);
  }

  private async process(job: PublishJob): Promise<PublishJob> {
    for (const delivery of job.deliveries) {
      if (delivery.status !== 'pending' || delivery.nextAttemptAt > this.now()) continue;
      await this.attempt(job, delivery);
      await this.store.save(job);
    }
    return job;
  }

  private async attempt(job: PublishJob, delivery: FeedDelivery): Promise<void> {
    const feed = this.feeds.get(delivery.feed);
    delivery.attempts += 1;
    try {
      if (!feed) throw new FeedError(delivery.feed, 'unknown', 'The publisher has no such feed');
      const published = await this.send(feed, job.post);
      delivery.status = 'published';
      delivery.post = {
        id: published.id,
        url: published.url,
        publishedAt: published.publishedAt.getTime(),
      };
      delete delivery.error;
      await this.notify(() =>
        this.options.onPublished?.({ job, feed: delivery.feed, post: published })
      );
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      const retry =
        error instanceof FeedError && error.retryable && delivery.attempts < this.retry.maxAttempts;
      delivery.error = {
        code: error instanceof FeedError ? error.code : 'unknown',
        message: error.message,
      };
      if (retry) {
        delivery.nextAttemptAt =
          this.now() + Math.max(error.retryAfter ?? 0, this.backoff(delivery.attempts));
      } else {
        delivery.status = 'failed';
      }
      await this.notify(() =>
        this.options.onFailed?.({ job, feed: delivery.feed, error, final: !retry })
      );
    }
  }

  private async send(feed: FeedChannel, post: FeedPost): Promise<PublishedPost> {
    let text = post.text;
    if (feed.measure(text) > feed.limits.maxLength) {
      if (this.options.overflow === 'fail') {
        throw new FeedError(
          feed.type,
          'invalid_post',
          `The text is ${feed.measure(text)} long, the feed takes ${feed.limits.maxLength}`
        );
      }
      text = fitText(text, feed.limits.maxLength, (value) => feed.measure(value));
    }
    if (this.options.dryRun) {
      return {
        feed: feed.type,
        id: `dry-run:${nanoid(8)}`,
        url: '',
        publishedAt: new Date(this.now()),
      };
    }
    return feed.publish(text === post.text ? post : { ...post, text });
  }

  private backoff(attempts: number): number {
    return Math.min(this.retry.baseDelay * 2 ** (attempts - 1), this.retry.maxDelay);
  }

  private async notify(hook: () => void | Promise<void>): Promise<void> {
    try {
      await hook();
    } catch (error) {
      console.error('[feeds] A publisher hook failed:', error);
    }
  }
}

function isWaiting(delivery: FeedDelivery): boolean {
  return delivery.status === 'pending';
}
