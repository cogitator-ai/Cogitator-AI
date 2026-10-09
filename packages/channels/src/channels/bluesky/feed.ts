import type { AppBskyFeedPost, Agent, BlobRef } from '@atproto/api';
import type {
  FeedChannel,
  FeedLimits,
  FeedPost,
  FeedPublishOptions,
  PublishedPost,
} from '@cogitator-ai/types';
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
  maxBytes: number;
  maxThumbBytes: number;
  maxTagLength: number;
} = {
  maxLength: 300,
  maxBytes: 3000,
  maxImages: 4,
  maxImageBytes: 2_000_000,
  maxThumbBytes: 1_000_000,
  maxTags: 8,
  maxTagLength: 64,
};

const encoder = new TextEncoder();
const POST_COLLECTION = 'app.bsky.feed.post';
const TID_CHARS = '234567abcdefghijklmnopqrstuvwxyz';
const TID_PATTERN = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;
const MAX_REFS = 500;

let lastTidMicros = 0;

/**
 * A new record key in the TID format of the AT Protocol: the time in
 * microseconds and a random clock id, in sortable base32.
 */
function nextTid(): string {
  lastTidMicros = Math.max(Date.now() * 1000, lastTidMicros + 1);
  let value = (BigInt(lastTidMicros) << 10n) | BigInt(Math.floor(Math.random() * 1024));
  let tid = '';
  for (let index = 0; index < 13; index++) {
    tid = TID_CHARS.charAt(Number(value & 31n)) + tid;
    value >>= 5n;
  }
  return tid;
}

interface StrongRef {
  uri: string;
  cid: string;
}

interface PublishedRef extends StrongRef {
  reply?: AppBskyFeedPost.ReplyRef;
}

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
 * thread. With an idempotency key the post gets that key as its record key,
 * so a second attempt finds the post the first one made.
 */
export class BlueskyFeed implements FeedChannel {
  readonly type = 'bluesky';
  readonly limits: FeedLimits = BLUESKY_LIMITS;
  readonly account: BlueskyAccount;
  private readonly fetchImpl?: typeof fetch;
  private readonly refs = new Map<string, { cid: string; root: StrongRef }>();

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

  /** A new record key in the TID format, which `publish` gives the post. */
  idempotencyKey(): string {
    return nextTid();
  }

  async publish(post: FeedPost, options: FeedPublishOptions = {}): Promise<PublishedPost> {
    this.validate(post);
    const { signal, idempotencyKey: rkey } = options;
    if (rkey !== undefined && !TID_PATTERN.test(rkey)) {
      throw new FeedError(
        'bluesky',
        'invalid_post',
        `"${rkey}" is not a key from BlueskyFeed.idempotencyKey()`
      );
    }
    signal?.throwIfAborted();
    const connection = connectionOf(this.account);
    const created = await connection.use(async (agent): Promise<PublishedRef> => {
      const did = agent.did;
      if (!did) throw new FeedError('bluesky', 'auth', 'The Bluesky session has no DID');
      if (rkey) {
        const existing = await this.findRecord(agent, did, rkey);
        if (existing) return existing;
      }
      const { record, reply } = await this.record(agent, post);
      signal?.throwIfAborted();
      try {
        const response = await agent.com.atproto.repo.createRecord({
          repo: did,
          collection: POST_COLLECTION,
          ...(rkey && { rkey }),
          record: { ...record, createdAt: new Date().toISOString() },
        });
        return {
          uri: response.data.uri,
          cid: response.data.cid,
          ...(reply && { reply }),
        };
      } catch (error) {
        throw blueskyError(error, 'Publishing the post');
      }
    });
    this.remember(created.uri, created.cid, created.reply?.root);
    return {
      feed: this.type,
      id: created.uri,
      url: blueskyPostUrl(created.uri),
      publishedAt: new Date(),
    };
  }

  async delete(id: string): Promise<void> {
    await connectionOf(this.account).use(async (agent) => {
      try {
        await agent.deletePost(id);
      } catch (error) {
        throw blueskyError(error, 'Deleting the post');
      }
    });
    this.refs.delete(id);
  }

  async close(): Promise<void> {}

  private validate(post: FeedPost): void {
    const invalid = (message: string) => new FeedError('bluesky', 'invalid_post', message);
    const length = graphemeLength(post.text);
    if (length > BLUESKY_LIMITS.maxLength) {
      throw invalid(`The text is ${length} graphemes, Bluesky takes ${BLUESKY_LIMITS.maxLength}`);
    }
    const bytes = encoder.encode(post.text).length;
    if (bytes > BLUESKY_LIMITS.maxBytes) {
      throw invalid(`The text is ${bytes} bytes, Bluesky takes ${BLUESKY_LIMITS.maxBytes}`);
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

  /** The post record for `post`: text with facets, embed, reply, tags and languages. */
  private async record(
    agent: Agent,
    post: FeedPost
  ): Promise<{
    record: Omit<AppBskyFeedPost.Record, 'createdAt'>;
    reply?: AppBskyFeedPost.ReplyRef;
  }> {
    const { RichText } = await loadAtproto();
    const rich = new RichText({ text: post.text });
    try {
      await rich.detectFacets(agent);
    } catch (error) {
      throw blueskyError(error, 'Resolving the mentions of the post');
    }
    const embed = await this.embed(agent, post);
    const reply = post.replyTo ? await this.replyRef(agent, post.replyTo) : undefined;
    const tags = (post.tags ?? []).map((tag) => tag.replace(/^#/, '')).filter(Boolean);
    return {
      record: {
        $type: POST_COLLECTION,
        text: rich.text,
        ...(rich.facets?.length ? { facets: rich.facets } : {}),
        ...(post.langs?.length ? { langs: post.langs } : {}),
        ...(tags.length ? { tags } : {}),
        ...(embed ? { embed } : {}),
        ...(reply ? { reply } : {}),
      },
      ...(reply && { reply }),
    };
  }

  /** The account's post under `rkey`, from its own PDS, which knows a post as soon as it exists. */
  private async findRecord(
    agent: Agent,
    did: string,
    rkey: string
  ): Promise<PublishedRef | undefined> {
    try {
      const response = await agent.com.atproto.repo.getRecord({
        repo: did,
        collection: POST_COLLECTION,
        rkey,
      });
      if (!response.data.cid) return undefined;
      const root = replyRootOf(response.data.value);
      const parent = replyParentOf(response.data.value);
      return {
        uri: response.data.uri,
        cid: response.data.cid,
        ...(root && parent && { reply: { root, parent } }),
      };
    } catch (error) {
      const failure = blueskyError(error, 'Looking for the post of an earlier attempt');
      if (failure.code === 'not_found') return undefined;
      throw failure;
    }
  }

  /**
   * Where a reply to `uri` goes: from the posts this feed published, from the
   * account's own PDS for its other posts, otherwise from the AppView. A post
   * published a moment ago is not on the AppView yet, so a thread of replies
   * never waits for it.
   */
  private async replyRef(agent: Agent, uri: string): Promise<AppBskyFeedPost.ReplyRef> {
    const known = this.refs.get(uri);
    if (known) return { root: known.root, parent: { uri, cid: known.cid } };
    const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri);
    if (match?.[1] && match[2] && match[1] === agent.did) {
      const own = await this.findRecord(agent, match[1], match[2]);
      if (!own) throw new FeedError('bluesky', 'not_found', `No post ${uri} to reply to`);
      const parent = { uri: own.uri, cid: own.cid };
      return { root: own.reply?.root ?? parent, parent };
    }
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

  /** Keeps where a published post sits, so replies to it need no lookup. */
  private remember(uri: string, cid: string, root: StrongRef | undefined): void {
    this.refs.set(uri, { cid, root: root ?? { uri, cid } });
    if (this.refs.size > MAX_REFS) {
      const oldest = this.refs.keys().next().value;
      if (oldest !== undefined) this.refs.delete(oldest);
    }
  }
}

function strongRefAt(record: unknown, field: 'root' | 'parent'): StrongRef | undefined {
  if (typeof record !== 'object' || record === null || !('reply' in record)) return undefined;
  const reply = record.reply;
  if (typeof reply !== 'object' || reply === null || !(field in reply)) return undefined;
  const ref: unknown = (reply as Record<string, unknown>)[field];
  if (
    typeof ref === 'object' &&
    ref !== null &&
    'uri' in ref &&
    'cid' in ref &&
    typeof ref.uri === 'string' &&
    typeof ref.cid === 'string'
  ) {
    return { uri: ref.uri, cid: ref.cid };
  }
  return undefined;
}

/** The root a post record replies under, where it is a reply. */
function replyRootOf(record: unknown): StrongRef | undefined {
  return strongRefAt(record, 'root');
}

/** The post a post record answers, where it is a reply. */
function replyParentOf(record: unknown): StrongRef | undefined {
  return strongRefAt(record, 'parent');
}

/** A Bluesky feed. */
export function blueskyFeed(config: BlueskyFeedConfig): BlueskyFeed {
  return new BlueskyFeed(config);
}
