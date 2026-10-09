import { nanoid } from 'nanoid';
import type {
  FeedChannel,
  FeedLimits,
  FeedPost,
  FeedPublishOptions,
  PublishedPost,
} from '@cogitator-ai/types';
import { assertImage } from '../../feeds/attachments';
import { FeedError } from '../../feeds/errors';
import { threadsLength } from '../../feeds/text';
import { threadsAccountOf, type ThreadsAccount, type ThreadsAccountConfig } from './account';
import type { ThreadsParams } from './client';

export type ThreadsFeedConfig = ({ account: ThreadsAccount } | ThreadsAccountConfig) & {
  /** How long to wait for Threads to get a post ready, in ms (default five minutes). */
  containerTimeout?: number;
  /** The waits between readiness checks, in ms. The last one repeats. */
  pollDelays?: readonly number[];
  /** Checks the 24-hour publishing quota before each post (default true). */
  checkQuota?: boolean;
};

/** What a Threads post accepts. */
export const THREADS_LIMITS: FeedLimits & { maxLinks: number; maxTopicTagLength: number } = {
  maxLength: 500,
  maxImages: 20,
  maxImageBytes: 8_000_000,
  maxLinks: 5,
  maxTags: 1,
  maxTopicTagLength: 50,
};

const URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;
const KEY_PATTERN = /^(\d{1,15})\.([\w-]{8,64})$/u;
const HOUR = 60 * 60_000;
/** How much earlier than its key a lookup starts, for clocks that disagree. */
const CLOCK_SKEW = 60_000;
/** How long after the oldest post leaves the quota window a retry waits. */
const QUOTA_MARGIN = 60_000;
const QUOTA_WINDOW = 86_400;
const LOOKUP_PAGES = 4;
const QUOTA_PAGES = 12;

interface Container {
  id: string;
}

interface ContainerStatus {
  status?: 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED' | 'PUBLISHED';
  error_message?: string;
}

/** A post as `/{user-id}/threads` and `/{user-id}/replies` list it. */
interface ListedPost {
  id: string;
  text?: string;
  timestamp?: string;
  permalink?: string;
  replied_to?: { id: string };
}

interface Page<T> {
  data?: T[];
  paging?: { cursors?: { before?: string; after?: string }; next?: string; previous?: string };
}

interface PublishingLimit {
  data?: Array<{
    quota_usage?: number;
    config?: { quota_total?: number; quota_duration?: number };
    reply_quota_usage?: number;
    reply_config?: { quota_total?: number; quota_duration?: number };
  }>;
}

/** Text as compared between a post and the one Threads lists: trimmed, whitespace runs as one space. */
function normalized(text: string | undefined): string {
  return (text ?? '').trim().replace(/\s+/gu, ' ');
}

function dateOf(timestamp: string | undefined): Date | undefined {
  const time = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
  return Number.isFinite(time) ? new Date(time) : undefined;
}

/** When a key from `ThreadsFeed.idempotencyKey()` was made, in ms since the epoch. */
function keyTime(key: string): number {
  const match = KEY_PATTERN.exec(key);
  const time = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(time)) {
    throw new FeedError(
      'threads',
      'invalid_post',
      `"${key}" is not an idempotency key from ThreadsFeed.idempotencyKey()`
    );
  }
  return time;
}

/** The query of the page after `page`, or none when it was the last. */
function nextQuery<T>(page: Page<T>, query: ThreadsParams): ThreadsParams | undefined {
  const count = page.data?.length ?? 0;
  if (count === 0) return undefined;
  const { cursors, next } = page.paging ?? {};
  if (!next && typeof query.limit === 'number' && count < query.limit) return undefined;
  if (cursors?.after && cursors.after !== query.after) return { ...query, after: cursors.after };
  if (!next) return undefined;
  try {
    const params = [...new URL(next).searchParams].filter(([name]) => name !== 'access_token');
    return params.length > 0 ? { ...query, ...Object.fromEntries(params) } : undefined;
  } catch {
    return undefined;
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('The publication was aborted');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortError(signal));
      },
      { once: true }
    );
  });
}

/**
 * Publishes posts to a Threads account in the two steps Threads asks for: a
 * media container, then its publication once Threads says it is ready.
 * Text posts carry a link card and a topic tag. One image or a carousel of
 * up to twenty is published from public URLs, since Threads fetches images
 * itself. Replies go under the post they answer. The account's token is
 * renewed before it expires.
 *
 * Threads takes no client-chosen ids, so a publication with an idempotency
 * key first looks for a post an earlier attempt made: one of the account's
 * posts (or replies) since the key was made, with the same text (and the same
 * parent for a reply). A full quota fails with `quota_exceeded` and a
 * `retryAfter` of when its oldest post leaves the window.
 */
export class ThreadsFeed implements FeedChannel {
  readonly type = 'threads';
  readonly limits: FeedLimits = THREADS_LIMITS;
  readonly account: ThreadsAccount;
  private readonly timeout: number;
  private readonly delays: readonly number[];
  private readonly checkQuota: boolean;

  constructor(config: ThreadsFeedConfig) {
    this.account = threadsAccountOf(config);
    this.timeout = config.containerTimeout ?? 5 * 60_000;
    this.delays = config.pollDelays?.length
      ? config.pollDelays
      : [1000, 2000, 4000, 8000, 15000, 30000];
    this.checkQuota = config.checkQuota ?? true;
  }

  measure(text: string): number {
    return threadsLength(text);
  }

  async connect(): Promise<void> {
    await this.account.connect();
  }

  /** A key of the time it is made and a random part, see `FeedPublishOptions`. */
  idempotencyKey(): string {
    return `${Date.now()}.${nanoid()}`;
  }

  async publish(post: FeedPost, options: FeedPublishOptions = {}): Promise<PublishedPost> {
    const topicTag = this.validate(post);
    const { signal, idempotencyKey } = options;
    if (idempotencyKey !== undefined) {
      const earlier = await this.findEarlier(post, keyTime(idempotencyKey), signal);
      if (earlier) return earlier;
    }
    if (this.checkQuota) await this.assertQuota(Boolean(post.replyTo), signal);
    const user = this.account.userId;
    const shared: ThreadsParams = {
      ...(topicTag && { topic_tag: topicTag }),
      ...(post.replyTo && { reply_to_id: post.replyTo }),
    };
    const images = post.images ?? [];
    let container: Container;
    if (images.length === 0) {
      container = await this.account.post<Container>(
        `${user}/threads`,
        {
          media_type: 'TEXT',
          text: post.text,
          ...(post.link && { link_attachment: post.link.url }),
          ...shared,
        },
        signal
      );
    } else if (images.length === 1) {
      container = await this.account.post<Container>(
        `${user}/threads`,
        {
          media_type: 'IMAGE',
          image_url: images[0].image.url,
          ...(post.text && { text: post.text }),
          ...(images[0].alt && { alt_text: images[0].alt }),
          ...shared,
        },
        signal
      );
    } else {
      const children: string[] = [];
      for (const image of images) {
        const item = await this.account.post<Container>(
          `${user}/threads`,
          {
            media_type: 'IMAGE',
            image_url: image.image.url,
            is_carousel_item: true,
            ...(image.alt && { alt_text: image.alt }),
          },
          signal
        );
        await this.ready(item.id, signal);
        children.push(item.id);
      }
      container = await this.account.post<Container>(
        `${user}/threads`,
        {
          media_type: 'CAROUSEL',
          children: children.join(','),
          ...(post.text && { text: post.text }),
          ...shared,
        },
        signal
      );
    }
    await this.ready(container.id, signal);
    const published = await this.account.post<Container>(
      `${user}/threads_publish`,
      { creation_id: container.id },
      signal
    );
    let url = '';
    try {
      const details = await this.account.get<{ permalink?: string }>(published.id, {
        fields: 'permalink',
      });
      url = details.permalink ?? '';
    } catch (error) {
      console.warn(`[threads] Published ${published.id} but could not read its permalink:`, error);
    }
    return { feed: this.type, id: published.id, url, publishedAt: new Date() };
  }

  async delete(id: string): Promise<void> {
    await this.account.delete(id);
  }

  async close(): Promise<void> {
    this.account.close();
  }

  /** Checks the post against Threads' rules and returns its topic tag. */
  private validate(post: FeedPost): string | undefined {
    const invalid = (message: string) => new FeedError('threads', 'invalid_post', message);
    const length = threadsLength(post.text);
    if (length > THREADS_LIMITS.maxLength) {
      throw invalid(`The text is ${length} long, Threads takes ${THREADS_LIMITS.maxLength}`);
    }
    const images = post.images ?? [];
    if (images.length > 0 && post.link) {
      throw invalid('Threads shows either images or a link card: put the link in the text');
    }
    if (images.length > THREADS_LIMITS.maxImages) {
      throw invalid(
        `The post has ${images.length} images, Threads takes ${THREADS_LIMITS.maxImages}`
      );
    }
    if (images.length === 0 && !post.text.trim()) throw invalid('The post is empty');
    for (const [index, image] of images.entries()) {
      assertImage('threads', image.image, `Image ${index + 1}`);
      if (!image.image.url) {
        throw invalid(
          `Image ${index + 1} has no url: Threads fetches images itself, so each needs a public URL`
        );
      }
    }
    const links = new Set(
      [...post.text.matchAll(URL_PATTERN), ...(post.link ? [[post.link.url]] : [])].map((match) =>
        match[0].replace(/[.,;:!?)]+$/u, '')
      )
    );
    if (links.size > THREADS_LIMITS.maxLinks) {
      throw invalid(`The post has ${links.size} links, Threads takes ${THREADS_LIMITS.maxLinks}`);
    }
    const tag = post.tags?.[0]?.replace(/^#/, '');
    if (tag === undefined) return undefined;
    if (tag.length < 1 || threadsLength(tag) > THREADS_LIMITS.maxTopicTagLength) {
      throw invalid(
        `The topic tag "${tag}" must be 1 to ${THREADS_LIMITS.maxTopicTagLength} characters`
      );
    }
    if (/[.&]/u.test(tag)) throw invalid(`The topic tag "${tag}" cannot hold "." or "&"`);
    return tag;
  }

  private async assertQuota(reply: boolean, signal?: AbortSignal): Promise<void> {
    const limit = await this.account.get<PublishingLimit>(
      `${this.account.userId}/threads_publishing_limit`,
      { fields: 'quota_usage,config,reply_quota_usage,reply_config' },
      signal
    );
    const entry = limit.data?.[0];
    const usage = reply ? entry?.reply_quota_usage : entry?.quota_usage;
    const config = reply ? entry?.reply_config : entry?.config;
    const total = config?.quota_total;
    if (usage === undefined || total === undefined || usage < total) return;
    const window = config?.quota_duration ?? QUOTA_WINDOW;
    const retryAfter = await this.quotaFreesIn(reply, window, signal);
    throw new FeedError(
      'threads',
      'quota_exceeded',
      `The account used its ${total} ${reply ? 'replies' : 'posts'} for the last ${Math.round(window / 3600)} hours, one frees up in about ${Math.ceil(retryAfter / 60_000)} min`,
      { retryAfter }
    );
  }

  /**
   * How long until the oldest post (or reply) inside the quota window of
   * `window` seconds leaves it, plus a margin. An hour when that cannot be
   * found out.
   */
  private async quotaFreesIn(
    reply: boolean,
    window: number,
    signal?: AbortSignal
  ): Promise<number> {
    const now = Date.now();
    const start = now - window * 1000;
    let oldest: number | undefined;
    try {
      const pages = this.pages<ListedPost>(
        `${this.account.userId}/${reply ? 'replies' : 'threads'}`,
        { since: Math.floor(start / 1000), fields: 'timestamp', limit: 100 },
        QUOTA_PAGES,
        signal
      );
      for await (const posts of pages) {
        for (const listed of posts) {
          const time = dateOf(listed.timestamp)?.getTime();
          if (time !== undefined && time >= start && (oldest === undefined || time < oldest)) {
            oldest = time;
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      return HOUR;
    }
    if (oldest === undefined) return HOUR;
    return Math.max(0, oldest + window * 1000 - now) + QUOTA_MARGIN;
  }

  /**
   * The post an earlier attempt with the same key made: the account's posts
   * (or replies to `post.replyTo`) since `since`, less the clock skew, with
   * the same text.
   */
  private async findEarlier(
    post: FeedPost,
    since: number,
    signal?: AbortSignal
  ): Promise<PublishedPost | undefined> {
    const parent = post.replyTo;
    const text = normalized(post.text);
    const pages = this.pages<ListedPost>(
      `${this.account.userId}/${parent ? 'replies' : 'threads'}`,
      {
        since: Math.floor((since - CLOCK_SKEW) / 1000),
        fields: `id,text,timestamp,permalink${parent ? ',replied_to' : ''}`,
        limit: 50,
      },
      LOOKUP_PAGES,
      signal
    );
    for await (const posts of pages) {
      const match = posts.find(
        (listed) =>
          normalized(listed.text) === text && (!parent || listed.replied_to?.id === parent)
      );
      if (match) {
        return {
          feed: this.type,
          id: match.id,
          url: match.permalink ?? '',
          publishedAt: dateOf(match.timestamp) ?? new Date(),
        };
      }
    }
    return undefined;
  }

  /** The items of a listing, page by page, following its cursors for `maxPages` at most. */
  private async *pages<T>(
    path: string,
    params: ThreadsParams,
    maxPages: number,
    signal?: AbortSignal
  ): AsyncGenerator<T[]> {
    let query: ThreadsParams | undefined = params;
    for (let page = 0; page < maxPages && query; page++) {
      const response: Page<T> = await this.account.get<Page<T>>(path, query, signal);
      yield response.data ?? [];
      query = nextQuery(response, query);
    }
  }

  private async ready(id: string, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.timeout;
    for (let attempt = 0; ; attempt++) {
      const { status, error_message } = await this.account.get<ContainerStatus>(
        id,
        { fields: 'status,error_message' },
        signal
      );
      if (status === 'FINISHED' || status === 'PUBLISHED') return;
      if (status === 'ERROR' || status === 'EXPIRED') {
        throw new FeedError(
          'threads',
          'invalid_post',
          `Threads could not prepare the post (${status}${error_message ? `: ${error_message}` : ''})`
        );
      }
      const wait = this.delays[Math.min(attempt, this.delays.length - 1)];
      if (Date.now() + wait > deadline) {
        throw new FeedError(
          'threads',
          'unavailable',
          `Threads did not get the post ready within ${Math.round(this.timeout / 1000)} s`
        );
      }
      await sleep(wait, signal);
    }
  }
}

/** A Threads feed. */
export function threadsFeed(config: ThreadsFeedConfig): ThreadsFeed {
  return new ThreadsFeed(config);
}
