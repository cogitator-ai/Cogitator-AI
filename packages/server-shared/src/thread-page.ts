import type { MemoryAdapter, MemoryEntry, Message, Thread } from '@cogitator-ai/types';
import type { ParseResult } from './validation.js';

/**
 * Reading a thread one page at a time, newest messages first: `GET /threads/:id?limit=50`
 * answers the last 50 messages and a `nextCursor`, and `?limit=50&cursor=<nextCursor>` the 50
 * before them, until an answer has no `nextCursor`.
 */

/** The most messages one page may ask for */
export const MAX_THREAD_PAGE_LIMIT = 1000;

/** What a request asks of a thread: all of it, or a page */
export interface ThreadPageQuery {
  /** Messages on the page, the newest of what is left. Without it the rest of the thread */
  limit?: number;
  /** Where the page ends: the `nextCursor` of the page after it */
  cursor?: string;
}

/** A thread, or a page of it, as the server answers it */
export interface ThreadPage {
  id: string;
  /** The messages of the page, oldest first */
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  /** The cursor of the page before this one, absent when this page holds the thread's start */
  nextCursor?: string;
}

/**
 * Where a page ends: the time of its oldest entry and how many entries of that time the pages
 * so far hold. Entries of one time keep the order they were added in (the memory contract), so
 * the newest `n` of them are the ones already sent.
 */
interface Cursor {
  t: number;
  n: number;
}

/** The latest time a `Date` holds, in ms */
const MAX_DATE_MS = 8_640_000_000_000_000;

/**
 * Most entries of one time a cursor may say were sent, so a forged one cannot make a page read
 * the whole thread: live writes keep entries of one time to a few, a bulk import to thousands
 */
const MAX_CURSOR_TIES = 100_000;

/** base64url of UTF-8 text, with the globals every runtime has (edge ones have no `Buffer`) */
function toBase64Url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(raw: string): string {
  const binary = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function encodeCursor(cursor: Cursor): string {
  return toBase64Url(JSON.stringify(cursor));
}

function decodeCursor(raw: string): Cursor | undefined {
  try {
    const value: unknown = JSON.parse(fromBase64Url(raw));
    if (typeof value !== 'object' || value === null) return undefined;
    const { t, n } = value as Partial<Cursor>;
    if (typeof t !== 'number' || !Number.isSafeInteger(t) || Math.abs(t) >= MAX_DATE_MS) {
      return undefined;
    }
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > MAX_CURSOR_TIES) {
      return undefined;
    }
    return { t, n };
  } catch {
    return undefined;
  }
}

function single(value: unknown): unknown {
  return Array.isArray(value) ? value[value.length - 1] : value;
}

/**
 * The page a request's query asks for, from `limit` (a whole number from 1 to
 * {@link MAX_THREAD_PAGE_LIMIT}) and `cursor` (a `nextCursor` the server gave)
 */
export function parseThreadPageQuery(query: {
  limit?: unknown;
  cursor?: unknown;
}): ParseResult<ThreadPageQuery> {
  const limitRaw = single(query.limit);
  const cursor = single(query.cursor);
  const page: ThreadPageQuery = {};
  if (limitRaw !== undefined && limitRaw !== '') {
    const limit = typeof limitRaw === 'number' ? limitRaw : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_THREAD_PAGE_LIMIT) {
      return {
        ok: false,
        message: `limit must be a whole number from 1 to ${MAX_THREAD_PAGE_LIMIT}`,
      };
    }
    page.limit = limit;
  }
  if (cursor !== undefined && cursor !== '') {
    if (typeof cursor !== 'string' || decodeCursor(cursor) === undefined) {
      return { ok: false, message: 'cursor is not one this server gave' };
    }
    page.cursor = cursor;
  }
  return { ok: true, value: page };
}

/**
 * The page of a thread a query asks for. Entries that share the time of a page's oldest entry
 * are counted, so no message is skipped or sent twice across pages. `thread` (what
 * the access check read) gives the thread's own times, without it they are those of its first
 * and last entries.
 *
 * @throws Error when the memory cannot read the thread
 */
export async function readThreadPage(
  memory: Pick<MemoryAdapter, 'getEntries'>,
  threadId: string,
  query: ThreadPageQuery = {},
  thread?: Pick<Thread, 'createdAt' | 'updatedAt'> | null
): Promise<ThreadPage> {
  const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
  const fetchLimit = query.limit === undefined ? undefined : query.limit + (cursor?.n ?? 0) + 1;
  const result = await memory.getEntries({
    threadId,
    ...(cursor && { before: new Date(cursor.t + 1) }),
    ...(fetchLimit !== undefined && { limit: fetchLimit }),
  });
  if (!result.success) throw new Error(result.error);

  const older = cursor ? withoutSent(result.data, cursor) : result.data;
  const more = query.limit !== undefined && older.length > query.limit;
  const page: MemoryEntry[] = more ? older.slice(older.length - query.limit!) : older;

  const first = result.data[0];
  const newest = cursor ? await newestEntryTime(memory, threadId) : result.data.at(-1)?.createdAt;
  const updatedAt = Math.max(thread?.updatedAt.getTime() ?? 0, newest?.getTime() ?? 0);
  return {
    id: threadId,
    messages: page.map((entry) => entry.message),
    createdAt: (thread?.createdAt ?? first?.createdAt ?? new Date()).getTime(),
    updatedAt: updatedAt > 0 ? updatedAt : Date.now(),
    ...(more && { nextCursor: encodeCursor(nextCursorOf(page, cursor)) }),
  };
}

/**
 * The entries the pages so far did not send: those of the cursor's time come last (they are the
 * newest read), and the newest `n` of them were sent
 */
function withoutSent(entries: readonly MemoryEntry[], cursor: Cursor): MemoryEntry[] {
  let atTime = 0;
  for (
    let at = entries.length - 1;
    at >= 0 && entries[at]!.createdAt.getTime() === cursor.t;
    at--
  ) {
    atTime++;
  }
  return entries.slice(0, entries.length - Math.min(cursor.n, atTime));
}

/**
 * When the thread last got an entry: adding entries does not move `updatedAt` of the thread
 * record, so the thread was last updated by its newest entry or the record, whichever is later
 */
async function newestEntryTime(
  memory: Pick<MemoryAdapter, 'getEntries'>,
  threadId: string
): Promise<Date | undefined> {
  const result = await memory.getEntries({ threadId, limit: 1 });
  if (!result.success) throw new Error(result.error);
  return result.data.at(-1)?.createdAt;
}

/** The cursor that ends the page before `page`: its oldest time and the entries of it sent */
function nextCursorOf(page: readonly MemoryEntry[], previous: Cursor | undefined): Cursor {
  const t = page[0]!.createdAt.getTime();
  const onPage = page.filter((entry) => entry.createdAt.getTime() === t).length;
  return {
    t,
    n: Math.min(onPage + (previous && previous.t === t ? previous.n : 0), MAX_CURSOR_TIES),
  };
}
