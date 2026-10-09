/**
 * Feeds: posts published to a social network (Bluesky, Threads), next to the
 * conversations channels hold.
 */

import type { Attachment, ChannelType } from './channel';

/** A link a post shows as a card. */
export interface FeedLink {
  url: string;
  title?: string;
  description?: string;
  /**
   * The card's preview image. Bluesky uploads it with the post; Threads
   * builds the card from the page itself and ignores it.
   */
  image?: Attachment;
}

/** An image of a post with the text that describes it. */
export interface FeedImage {
  image: Attachment;
  /** Alt text for screen readers. */
  alt?: string;
  aspectRatio?: { width: number; height: number };
}

export interface FeedPost {
  text: string;
  link?: FeedLink;
  images?: FeedImage[];
  /**
   * Topics of the post. Threads takes the first as its topic tag; Bluesky
   * adds them as hashtags that are not in the text.
   */
  tags?: string[];
  /** Languages of the text, as BCP 47 tags. */
  langs?: string[];
  /** The id of a post of the same feed this post answers. */
  replyTo?: string;
}

export interface PublishedPost {
  feed: ChannelType;
  /** The id the feed knows the post by: an `at://` URI on Bluesky, a media id on Threads. */
  id: string;
  /** Where people see it. */
  url: string;
  publishedAt: Date;
}

/** What a feed accepts, for checking a post before it is sent. */
export interface FeedLimits {
  /** The longest text, in the unit `measure` counts. */
  maxLength: number;
  maxImages: number;
  /** The largest image, in bytes. */
  maxImageBytes: number;
  /** The most links a text may hold, where the feed limits them. */
  maxLinks?: number;
  /** The most tags a post may have. */
  maxTags: number;
}

/** A social feed a post can be published to. */
export interface FeedChannel {
  readonly type: ChannelType;
  readonly limits: FeedLimits;
  /** The length of `text` as the feed counts it. */
  measure(text: string): number;
  /** Connects: signs in, or loads and renews the token. Publishing connects too when needed. */
  connect(): Promise<void>;
  publish(post: FeedPost, options?: { signal?: AbortSignal }): Promise<PublishedPost>;
  delete(id: string): Promise<void>;
  /** Stops background work such as scheduled token renewal. */
  close(): Promise<void>;
}

/** A secret with its lifetime: an access token, or a serialized session. */
export interface StoredToken {
  value: string;
  /** When it was issued, in ms since the epoch. */
  issuedAt: number;
  /** When it stops working, in ms since the epoch, where it expires. */
  expiresAt?: number;
}

/** Where a feed keeps its token or session, so it survives restarts and renewals. */
export interface TokenStore {
  get(key: string): Promise<StoredToken | undefined>;
  set(key: string, token: StoredToken): Promise<void>;
  delete(key: string): Promise<void>;
}
