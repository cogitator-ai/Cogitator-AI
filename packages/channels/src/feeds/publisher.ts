import { nanoid } from 'nanoid';
import type { FeedChannel, FeedPost, PublishedPost } from '@cogitator-ai/types';
import { FeedError } from './errors';
import {
  type FeedDelivery,
  type JobClaim,
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
  /**
   * How long a claim on a job lasts, in ms (default five minutes). The
   * publisher extends it every third of that while it works on the job, so
   * this is how soon another worker takes over a job whose worker died.
   */
  claimTtl?: number;
  /**
   * A text longer than a feed takes: `truncate` (default) cuts it at a word
   * with an ellipsis for that feed, `fail` fails that feed.
   */
  overflow?: 'truncate' | 'fail';
  /** Goes through every step but publishing. Dry runs keep their keys apart from real ones. */
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
  /** When to publish. A time in the future schedules the post. */
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
 * retried on its own, each outcome saved as soon as it is known. Each
 * delivery keeps the feed's idempotency key from before its first attempt,
 * so an attempt after a crash or a lost answer finds the post instead of
 * publishing it twice, and a key makes the whole publication idempotent.
 */
export class FeedPublisher {
  private readonly feeds = new Map<string, FeedChannel>();
  private readonly store: PublishStore;
  private readonly retry: Required<FeedRetryOptions>;
  private readonly pollInterval: number;
  private readonly claimTtl: number;
  private readonly now: () => number;
  private readonly owner = `feedpub_${nanoid(12)}`;
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private stopping = false;

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
    const key = options.key && (this.options.dryRun ? `dry-run:${options.key}` : options.key);
    const job: PublishJob = {
      id: `feedjob_${nanoid(12)}`,
      ...(key ? { key } : {}),
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
    if (duplicate || publishAt > now || !(await this.store.claim(stored.id, this.claimOf()))) {
      return { job: stored, pending: stored.deliveries.some(isWaiting), duplicate };
    }
    const done = await this.run(stored);
    return { job: done, pending: done.deliveries.some(isWaiting), duplicate };
  }

  /** Looks for due jobs every `pollInterval` until `stop()`: scheduled posts and retries. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.pollInterval);
    void this.tick();
  }

  /** Stops looking for due jobs, letting the job being published finish, and waits for it. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.ticking;
  }

  /**
   * Publishes the jobs that are due now, one at a time, so a claim is taken
   * only when the job is about to be published. `start()` does this on a timer.
   */
  async tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.stopping = false;
    this.ticking = (async () => {
      const seen = new Set<string>();
      try {
        while (!this.stopping) {
          const job = await this.store.claimNext(this.now(), this.claimOf());
          if (!job) break;
          if (seen.has(job.id)) {
            await this.store.release(job.id, this.owner);
            break;
          }
          seen.add(job.id);
          await this.run(job);
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

  /** Drops a job before it is published, `false` when it is missing or being published. */
  async cancel(id: string): Promise<boolean> {
    return this.store.remove(id);
  }

  private claimOf(): JobClaim {
    return { owner: this.owner, ttl: this.claimTtl };
  }

  /** Publishes a job this publisher claimed, extending the claim while it works, then releases it. */
  private async run(job: PublishJob): Promise<PublishJob> {
    const lost = new AbortController();
    const heartbeat = setInterval(
      () => {
        this.store.extend(job.id, this.claimOf()).then(
          (held) => {
            if (!held) lost.abort(new Error(`Lost the claim on feed job ${job.id}`));
          },
          (error: unknown) => console.error('[feeds] Extending a job claim failed:', error)
        );
      },
      Math.max(1, Math.floor(this.claimTtl / 3))
    );
    heartbeat.unref?.();
    try {
      return await this.process(job, lost.signal);
    } finally {
      clearInterval(heartbeat);
      await this.store.release(job.id, this.owner);
    }
  }

  private async process(job: PublishJob, signal: AbortSignal): Promise<PublishJob> {
    for (const delivery of job.deliveries) {
      if (delivery.status !== 'pending' || delivery.nextAttemptAt > this.now()) continue;
      const feed = this.feeds.get(delivery.feed);
      const retry = delivery.idempotencyKey !== undefined;
      if (feed && !this.options.dryRun && !retry) {
        delivery.idempotencyKey = feed.idempotencyKey();
        if (!(await this.save(job, signal))) break;
      }
      await this.attempt(job, delivery, feed, retry, signal);
      if (!(await this.save(job, signal))) break;
    }
    return job;
  }

  /** Saves the job while the claim holds, `false` when another worker took it over. */
  private async save(job: PublishJob, signal: AbortSignal): Promise<boolean> {
    if (!signal.aborted && (await this.store.save(job, this.owner))) return true;
    console.warn(`[feeds] Lost the claim on feed job ${job.id}: another worker took it over`);
    return false;
  }

  private async attempt(
    job: PublishJob,
    delivery: FeedDelivery,
    feed: FeedChannel | undefined,
    retry: boolean,
    signal: AbortSignal
  ): Promise<void> {
    delivery.attempts += 1;
    try {
      if (!feed) throw new FeedError(delivery.feed, 'unknown', 'The publisher has no such feed');
      const published = await this.send(feed, job.post, delivery.idempotencyKey, retry, signal);
      delivery.status = 'published';
      delivery.post = {
        id: published.id,
        url: published.url,
        publishedAt: published.publishedAt.getTime(),
      };
      delete delivery.error;
      delete delivery.idempotencyKey;
      await this.notify(() =>
        this.options.onPublished?.({ job, feed: delivery.feed, post: published })
      );
    } catch (caught) {
      if (signal.aborted) return;
      const error = caught instanceof Error ? caught : new Error(String(caught));
      const quota = error instanceof FeedError && error.code === 'quota_exceeded';
      if (quota) delivery.attempts -= 1;
      const again =
        error instanceof FeedError &&
        error.retryable &&
        (quota || delivery.attempts < this.retry.maxAttempts);
      delivery.error = {
        code: error instanceof FeedError ? error.code : 'unknown',
        message: error.message,
      };
      if (again) {
        const wait = quota
          ? (error.retryAfter ?? this.retry.maxDelay)
          : Math.max(error.retryAfter ?? 0, this.backoff(delivery.attempts));
        delivery.nextAttemptAt = this.now() + wait;
      } else {
        delivery.status = 'failed';
      }
      await this.notify(() =>
        this.options.onFailed?.({ job, feed: delivery.feed, error, final: !again })
      );
    }
  }

  private async send(
    feed: FeedChannel,
    post: FeedPost,
    idempotencyKey: string | undefined,
    retry: boolean,
    signal: AbortSignal
  ): Promise<PublishedPost> {
    const measure = lengthOf(feed);
    const { maxLength } = feed.limits;
    let text = post.text;
    if (measure(text) > maxLength) {
      if (this.options.overflow === 'fail') {
        throw new FeedError(
          feed.type,
          'invalid_post',
          `The text is longer than ${feed.type} takes (${describeLimits(feed)})`
        );
      }
      text = fitText(text, maxLength, measure);
    }
    if (this.options.dryRun) {
      return {
        feed: feed.type,
        id: `dry-run:${nanoid(8)}`,
        url: '',
        publishedAt: new Date(this.now()),
      };
    }
    return feed.publish(text === post.text ? post : { ...post, text }, {
      signal,
      ...(idempotencyKey && { idempotencyKey, retry }),
    });
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

const encoder = new TextEncoder();

/**
 * The length of a text against `limits.maxLength`, folding in a limit in
 * bytes: a text fits when this is at most `maxLength` exactly when it fits
 * both, so one cut honors both limits.
 */
function lengthOf(feed: FeedChannel): (text: string) => number {
  const { maxLength, maxBytes } = feed.limits;
  if (maxBytes === undefined) return (text) => feed.measure(text);
  return (text) =>
    Math.max(feed.measure(text), Math.ceil((encoder.encode(text).length * maxLength) / maxBytes));
}

function describeLimits(feed: FeedChannel): string {
  const { maxLength, maxBytes } = feed.limits;
  return maxBytes === undefined ? `${maxLength}` : `${maxLength} and ${maxBytes} bytes`;
}
