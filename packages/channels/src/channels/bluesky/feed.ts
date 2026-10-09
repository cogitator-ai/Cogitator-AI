import type { AppBskyFeedPost, Agent, BlobRef } from '@atproto/api';
import type { FeedChannel, FeedLimits, FeedPost, PublishedPost } from '@cogitator-ai/types';
import { assertImage, attachmentBytes } from '../../feeds/attachments';
import { FeedError } from '../../feeds/errors';
import { graphemeLength } from '../../feeds/text';
import { accountOf, type BlueskyAccount } from './account';
import type { BlueskyConnectionConfig } from './config';
import { blueskyError, connectionOf, loadAtproto } from './connection';

/** A Bluesky feed config: an account to share with a `BlueskyChannel`, or its credentials. */
export type BlueskyFeedConfig = ({ account: BlueskyAccount } | BlueskyConnectionConfig) & {
  /** The fetch for downloading images given by URL. */
  fetch?: typeof fetch;
};

/** What a post record accepts, from the `app.bsky.feed.post` lexicon. */
export const BLUESKY_LIMITS: FeedLimits & {
  maxTextBytes: number;
  maxThumbBytes: number;
  maxTagLength: number;
} = {
  maxLength: 300,
  maxTextBytes: 3000,
  maxImages: 4,
  maxImageBytes: 2_000_000,
  maxThumbBytes: 1_000_000,
  maxTags: 8,
  maxTagLength: 64,
};

const encoder = new TextEncoder();

/** The public URL of a post from its `at://` URI. */
export function blueskyPostUrl(uri: string): string {
  const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri);
  if (!match) throw new FeedError('bluesky', 'invalid_post', `Not a Bluesky post URI: ${uri}`);
  return `https://bsky.app/profile/${match[1]}/post/${match[2]}`;
}

/**
 * Publishes posts to a Bluesky account: text with its links, mentions and
 * hashtags as facets, a link card with an uploaded preview or up to four
 * images with alt text, extra tags, languages, and replies placed in their
 * thread.
 */
export class BlueskyFeed implements FeedChannel {
  readonly type = 'bluesky';
  readonly limits: FeedLimits = BLUESKY_LIMITS;
  readonly account: BlueskyAccount;
  private readonly fetchImpl?: typeof fetch;

  constructor(config: BlueskyFeedConfig) {
    this.account = accountOf(config);
    if (config.fetch) this.fetchImpl = config.fetch;
  }

  measure(text: string): number {
    return graphemeLength(text);
  }

  async connect(): Promise<void> {
    await this.account.connect();
  }

  async publish(post: FeedPost, options: { signal?: AbortSignal } = {}): Promise<PublishedPost> {
    this.validate(post);
    options.signal?.throwIfAborted();
    const agent = await connectionOf(this.account).agent();
    const { RichText } = await loadAtproto();
    const rich = new RichText({ text: post.text });
    try {
      await rich.detectFacets(agent);
    } catch (error) {
      throw blueskyError(error, 'Resolving the mentions of the post');
    }
    const embed = await this.embed(agent, post);
    const reply = post.replyTo ? await this.replyRef(agent, post.replyTo) : undefined;
    options.signal?.throwIfAborted();
    const tags = (post.tags ?? []).map((tag) => tag.replace(/^#/, '')).filter(Boolean);
    const record: Partial<AppBskyFeedPost.Record> & Omit<AppBskyFeedPost.Record, 'createdAt'> = {
      $type: 'app.bsky.feed.post',
      text: rich.text,
      ...(rich.facets?.length ? { facets: rich.facets } : {}),
      ...(post.langs?.length ? { langs: post.langs } : {}),
      ...(tags.length ? { tags } : {}),
      ...(embed ? { embed } : {}),
      ...(reply ? { reply } : {}),
    };
    let created: { uri: string; cid: string };
    try {
      created = await agent.post(record);
    } catch (error) {
      throw blueskyError(error, 'Publishing the post');
    }
    return {
      feed: this.type,
      id: created.uri,
      url: blueskyPostUrl(created.uri),
      publishedAt: new Date(),
    };
  }

  async delete(id: string): Promise<void> {
    const agent = await connectionOf(this.account).agent();
    try {
      await agent.deletePost(id);
    } catch (error) {
      throw blueskyError(error, 'Deleting the post');
    }
  }

  async close(): Promise<void> {}

  private validate(post: FeedPost): void {
    const invalid = (message: string) => new FeedError('bluesky', 'invalid_post', message);
    const length = graphemeLength(post.text);
    if (length > BLUESKY_LIMITS.maxLength) {
      throw invalid(`The text is ${length} graphemes, Bluesky takes ${BLUESKY_LIMITS.maxLength}`);
    }
    const bytes = encoder.encode(post.text).length;
    if (bytes > BLUESKY_LIMITS.maxTextBytes) {
      throw invalid(`The text is ${bytes} bytes, Bluesky takes ${BLUESKY_LIMITS.maxTextBytes}`);
    }
    const images = post.images ?? [];
    if (images.length > BLUESKY_LIMITS.maxImages) {
      throw invalid(
        `The post has ${images.length} images, Bluesky takes ${BLUESKY_LIMITS.maxImages}`
      );
    }
    if (images.length > 0 && post.link) {
      throw invalid('Bluesky shows either images or a link card: put the link in the text');
    }
    if (!post.text.trim() && images.length === 0 && !post.link) {
      throw invalid('The post is empty');
    }
    for (const [index, image] of images.entries()) {
      assertImage('bluesky', image.image, `Image ${index + 1}`);
    }
    if (post.link?.image) assertImage('bluesky', post.link.image, 'The link preview');
    const tags = post.tags ?? [];
    if (tags.length > BLUESKY_LIMITS.maxTags) {
      throw invalid(`The post has ${tags.length} tags, Bluesky takes ${BLUESKY_LIMITS.maxTags}`);
    }
    for (const tag of tags) {
      if (graphemeLength(tag.replace(/^#/, '')) > BLUESKY_LIMITS.maxTagLength) {
        throw invalid(`The tag "${tag}" is longer than ${BLUESKY_LIMITS.maxTagLength} graphemes`);
      }
    }
  }

  private async upload(agent: Agent, bytes: Uint8Array, mimeType: string): Promise<BlobRef> {
    try {
      const response = await agent.uploadBlob(bytes, { encoding: mimeType });
      return response.data.blob;
    } catch (error) {
      throw blueskyError(error, 'Uploading an image');
    }
  }

  private async embed(agent: Agent, post: FeedPost): Promise<AppBskyFeedPost.Record['embed']> {
    if (post.images?.length) {
      const images = await Promise.all(
        post.images.map(async (image, index) => ({
          image: await this.upload(
            agent,
            await attachmentBytes('bluesky', image.image, {
              maxBytes: BLUESKY_LIMITS.maxImageBytes,
              what: `Image ${index + 1}`,
              ...(this.fetchImpl && { fetch: this.fetchImpl }),
            }),
            image.image.mimeType
          ),
          alt: image.alt ?? '',
          ...(image.aspectRatio ? { aspectRatio: image.aspectRatio } : {}),
        }))
      );
      return { $type: 'app.bsky.embed.images', images };
    }
    if (!post.link) return undefined;
    const thumb = post.link.image
      ? await this.upload(
          agent,
          await attachmentBytes('bluesky', post.link.image, {
            maxBytes: BLUESKY_LIMITS.maxThumbBytes,
            what: 'The link preview',
            ...(this.fetchImpl && { fetch: this.fetchImpl }),
          }),
          post.link.image.mimeType
        )
      : undefined;
    return {
      $type: 'app.bsky.embed.external',
      external: {
        uri: post.link.url,
        title: post.link.title ?? '',
        description: post.link.description ?? '',
        ...(thumb ? { thumb } : {}),
      },
    };
  }

  private async replyRef(agent: Agent, uri: string): Promise<AppBskyFeedPost.ReplyRef> {
    let parent: { uri: string; cid: string; record: unknown } | undefined;
    try {
      const response = await agent.getPosts({ uris: [uri] });
      parent = response.data.posts[0];
    } catch (error) {
      throw blueskyError(error, 'Loading the post to reply to');
    }
    if (!parent) throw new FeedError('bluesky', 'not_found', `No post ${uri} to reply to`);
    const root = replyRootOf(parent.record) ?? { uri: parent.uri, cid: parent.cid };
    return { root, parent: { uri: parent.uri, cid: parent.cid } };
  }
}

/** The root a post record replies under, where it is a reply. */
function replyRootOf(record: unknown): { uri: string; cid: string } | undefined {
  if (typeof record !== 'object' || record === null || !('reply' in record)) return undefined;
  const reply = record.reply;
  if (typeof reply !== 'object' || reply === null || !('root' in reply)) return undefined;
  const root = reply.root;
  if (
    typeof root === 'object' &&
    root !== null &&
    'uri' in root &&
    'cid' in root &&
    typeof root.uri === 'string' &&
    typeof root.cid === 'string'
  ) {
    return { uri: root.uri, cid: root.cid };
  }
  return undefined;
}

/** A Bluesky feed. */
export function blueskyFeed(config: BlueskyFeedConfig): BlueskyFeed {
  return new BlueskyFeed(config);
}
