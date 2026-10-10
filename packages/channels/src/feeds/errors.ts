export type FeedErrorCode =
  /** The credentials are wrong or lack a permission. */
  | 'auth'
  /** The token or session expired and cannot be renewed. */
  | 'token_expired'
  /** Too many requests: try again after `retryAfter`. */
  | 'rate_limited'
  /** The account used up its publishing quota for now. */
  | 'quota_exceeded'
  /** The post breaks a rule of the feed: too long, too many links, a bad tag or image. */
  | 'invalid_post'
  /** The post or account it refers to does not exist. */
  | 'not_found'
  /** The feed failed or did not answer: try again. */
  | 'unavailable'
  | 'unknown';

const RETRYABLE: ReadonlySet<FeedErrorCode> = new Set([
  'rate_limited',
  'quota_exceeded',
  'unavailable',
]);

/** A failure of a feed, with whether and when trying again can help. */
export class FeedError extends Error {
  readonly feed: string;
  readonly code: FeedErrorCode;
  /** The HTTP status, where the feed answered with one. */
  readonly status?: number;
  /** How long to wait before trying again, in ms, where the feed said. */
  readonly retryAfter?: number;

  constructor(
    feed: string,
    code: FeedErrorCode,
    message: string,
    options: { status?: number; retryAfter?: number; cause?: unknown } = {}
  ) {
    super(`[${feed}] ${message}`, { cause: options.cause });
    this.name = 'FeedError';
    this.feed = feed;
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter;
  }

  /** Whether publishing again later can succeed. */
  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }
}

/** The error code an HTTP status means, where the body says nothing more precise. */
export function feedErrorCode(status: number): FeedErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 413 || status === 422) return 'invalid_post';
  if (status >= 500) return 'unavailable';
  return 'unknown';
}

/**
 * How long a `Retry-After` header (seconds or an HTTP date) or a
 * `ratelimit-reset` header (epoch seconds) asks to wait, in ms.
 */
export function retryAfterOf(headers: Headers, now = Date.now()): number | undefined {
  const after = headers.get('retry-after');
  if (after) {
    const seconds = Number(after);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(after);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const reset = Number(headers.get('ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now);
  return undefined;
}
