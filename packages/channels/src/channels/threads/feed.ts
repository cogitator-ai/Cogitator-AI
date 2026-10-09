import type { FeedChannel, FeedLimits, FeedPost, PublishedPost } from '@cogitator-ai/types';
import { assertImage } from '../../feeds/attachments';
import { FeedError } from '../../feeds/errors';
import { threadsLength } from '../../feeds/text';
import { threadsAccountOf, type ThreadsAccount, type ThreadsAccountConfig } from './account';
import type { ThreadsParams } from './client';

export type ThreadsFeedConfig = ({ account: ThreadsAccount } | ThreadsAccountConfig) & {
  /** How long to wait for Threads to get a post ready, in ms (default five minutes). */
  containerTimeout?: number;
  /** The waits between readiness checks, in ms; the last repeats. */
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

interface Container {
  id: string;
}

interface ContainerStatus {
  status?: 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED' | 'PUBLISHED';
  error_message?: string;
}

interface PublishingLimit {
  data?: Array<{
    quota_usage?: number;
    config?: { quota_total?: number; quota_duration?: number };
    reply_quota_usage?: number;
    reply_config?: { quota_total?: number; quota_duration?: number };
  }>;
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
 * Text posts carry a link card and a topic tag; one image or a carousel of
 * up to twenty is published from public URLs, since Threads fetches images
 * itself; replies go under the post they answer. The account's token is
 * renewed before it expires.
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

  async publish(post: FeedPost, options: { signal?: AbortSignal } = {}): Promise<PublishedPost> {
    const topicTag = this.validate(post);
    const { signal } = options;
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
    const total = reply ? entry?.reply_config?.quota_total : entry?.config?.quota_total;
    if (usage !== undefined && total !== undefined && usage >= total) {
      throw new FeedError(
        'threads',
        'quota_exceeded',
        `The account used its ${total} ${reply ? 'replies' : 'posts'} for the last 24 hours`
      );
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
