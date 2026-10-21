import type { ListThreadsOptions, Thread, ThreadPage } from '@cogitator-ai/types';

export const DEFAULT_THREAD_PAGE = 50;
export const MAX_THREAD_PAGE = 500;

/** Where a page of `listThreads` starts: after the thread with this update time and id. */
export interface ThreadCursor {
  updatedAt: number;
  id: string;
}

/** A listing request with its limit, order and cursor checked. */
export interface ThreadListing {
  limit: number;
  order: 'asc' | 'desc';
  cursor?: ThreadCursor;
  agentId?: string;
  metadata: [string, string | number | boolean][];
  updatedAfter?: Date;
}

/** `cursor` as the opaque string `listThreads` hands out. */
export function encodeThreadCursor(cursor: ThreadCursor): string {
  return Buffer.from(JSON.stringify([cursor.updatedAt, cursor.id])).toString('base64url');
}

function decodeThreadCursor(text: string): ThreadCursor | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'number' &&
      Number.isFinite(value[0]) &&
      typeof value[1] === 'string'
    ) {
      return { updatedAt: value[0], id: value[1] };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

const METADATA_KEY = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * `options` checked and filled in, or the reason it cannot be served: a limit that is not a whole
 * number from 1 to {@link MAX_THREAD_PAGE}, a cursor `listThreads` did not hand out, a metadata
 * filter with a key that is not a plain name or a value that is not a string, number or boolean.
 */
export function threadListing(options: ListThreadsOptions = {}): ThreadListing | string {
  const limit = options.limit ?? DEFAULT_THREAD_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_THREAD_PAGE) {
    return `listThreads limit must be a whole number from 1 to ${MAX_THREAD_PAGE}, got ${limit}`;
  }
  const cursor = options.cursor === undefined ? undefined : decodeThreadCursor(options.cursor);
  if (options.cursor !== undefined && !cursor) return 'listThreads cursor is not valid';
  const metadata = Object.entries(options.metadata ?? {});
  for (const [key, value] of metadata) {
    if (!METADATA_KEY.test(key)) return `listThreads metadata key is not valid: ${key}`;
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      return `listThreads metadata value of ${key} must be a string, number or boolean`;
    }
  }
  if (options.updatedAfter && Number.isNaN(options.updatedAfter.getTime())) {
    return 'listThreads updatedAfter is not a valid date';
  }
  return {
    limit,
    order: options.order ?? 'desc',
    ...(cursor && { cursor }),
    ...(options.agentId !== undefined && { agentId: options.agentId }),
    metadata,
    ...(options.updatedAfter && { updatedAfter: options.updatedAfter }),
  };
}

/** Whether `thread` passes the filters of `listing`. */
export function matchesListing(thread: Thread, listing: ThreadListing): boolean {
  if (listing.agentId !== undefined && thread.agentId !== listing.agentId) return false;
  if (listing.updatedAfter && thread.updatedAt.getTime() < listing.updatedAfter.getTime()) {
    return false;
  }
  return listing.metadata.every(([key, value]) => thread.metadata[key] === value);
}

/** Orders threads by update time, then id, in the direction of `listing`. */
export function compareForListing(listing: ThreadListing): (a: Thread, b: Thread) => number {
  const sign = listing.order === 'asc' ? 1 : -1;
  return (a, b) =>
    sign *
    (a.updatedAt.getTime() - b.updatedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Whether `thread` comes after the cursor of `listing` in its order. */
export function isAfterCursor(thread: Thread, listing: ThreadListing): boolean {
  const { cursor } = listing;
  if (!cursor) return true;
  const time = thread.updatedAt.getTime();
  if (listing.order === 'asc') {
    return time > cursor.updatedAt || (time === cursor.updatedAt && thread.id > cursor.id);
  }
  return time < cursor.updatedAt || (time === cursor.updatedAt && thread.id < cursor.id);
}

/**
 * The page of `ordered` threads (already filtered, ordered and past the cursor): the first
 * `limit`, with a cursor when there is more. Pass one thread beyond the limit to know there is.
 */
export function threadPage(ordered: readonly Thread[], listing: ThreadListing): ThreadPage {
  const threads = ordered.slice(0, listing.limit);
  const last = threads.at(-1);
  return {
    threads,
    ...(ordered.length > listing.limit &&
      last && {
        nextCursor: encodeThreadCursor({ updatedAt: last.updatedAt.getTime(), id: last.id }),
      }),
  };
}
