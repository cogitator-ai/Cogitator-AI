import { z } from 'zod';
import type { A2ATask, TaskState } from './types.js';
import { A2AError, invalidParams } from './errors.js';
import { compareTasksNewestFirst, taskTime } from './ownership.js';

/** Tasks per page of `ListTasks` when the client sets no `pageSize`. */
export const DEFAULT_PAGE_SIZE = 50;

/** The largest `pageSize` of `ListTasks`. */
export const MAX_PAGE_SIZE = 100;

/** A query of A2A 1.0 `ListTasks` in the internal form. */
export interface ListTasksPageQuery {
  contextId?: string;
  state?: TaskState;
  /** 1 to 100 (default: 50) */
  pageSize?: number;
  /** The `nextPageToken` of the previous page */
  pageToken?: string;
  /** The last N messages of each task's history; 0 leaves the history out */
  historyLength?: number;
  /** Only tasks whose status changed after this ISO 8601 time */
  statusTimestampAfter?: string;
  /** Include each task's artifacts (default: false) */
  includeArtifacts?: boolean;
}

/** One page of A2A 1.0 `ListTasks` in the internal form. */
export interface ListTasksPage {
  tasks: A2ATask[];
  /** The cursor of the next page, `''` on the last one */
  nextPageToken: string;
  pageSize: number;
  /** How many tasks the query matches across all pages */
  totalSize: number;
}

const cursorSchema = z.object({
  v: z.literal(1),
  t: z.number().finite(),
  id: z.string().min(1),
});

interface Cursor {
  t: number;
  id: string;
}

/** The cursor after a task: base64url of `{ v: 1, t, id }`, its status time and id. */
export function encodePageToken(task: A2ATask): string {
  return Buffer.from(JSON.stringify({ v: 1, t: taskTime(task), id: task.id })).toString(
    'base64url'
  );
}

function invalidPageToken(): A2AError {
  const description = 'is not a page token this server issued';
  return new A2AError(invalidParams(`pageToken: ${description}`), {
    fieldViolations: [{ field: 'pageToken', description }],
  });
}

/** The cursor a page token holds, or `InvalidParamsError` on `pageToken`. */
export function decodePageToken(token: string): Cursor {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw invalidPageToken();
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
    );
    if (!parsed.success) throw invalidPageToken();
    return { t: parsed.data.t, id: parsed.data.id };
  } catch (error) {
    if (error instanceof A2AError) throw error;
    throw invalidPageToken();
  }
}

/** Whether a task comes after the cursor in the list order (newest first, then id descending). */
function isAfter(task: A2ATask, cursor: Cursor): boolean {
  const time = taskTime(task);
  return time < cursor.t || (time === cursor.t && task.id < cursor.id);
}

/**
 * One page of tasks by keyset pagination: the tasks after the cursor in the list order, so a page
 * never repeats or skips a task that did not change while the client paged. `tasks` are all the
 * tasks the query matches, in any order.
 */
export function paginateTasks(
  tasks: readonly A2ATask[],
  query: Pick<ListTasksPageQuery, 'pageSize' | 'pageToken' | 'statusTimestampAfter'>
): { tasks: A2ATask[]; nextPageToken: string; pageSize: number; totalSize: number } {
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
  const after = query.statusTimestampAfter ? Date.parse(query.statusTimestampAfter) : undefined;
  const matching = tasks
    .filter((task) => after === undefined || taskTime(task) > after)
    .sort(compareTasksNewestFirst);
  const cursor = query.pageToken ? decodePageToken(query.pageToken) : undefined;
  const remaining = cursor ? matching.filter((task) => isAfter(task, cursor)) : matching;
  const page = remaining.slice(0, pageSize);
  const last = page.at(-1);
  return {
    tasks: page,
    nextPageToken: last && remaining.length > page.length ? encodePageToken(last) : '',
    pageSize,
    totalSize: matching.length,
  };
}

const configCursorSchema = z.object({ v: z.literal(1), c: z.string().min(1) });

/**
 * One page of push notification configs by keyset pagination over their ids: the configs after
 * the cursor in id order, `pageSize` 1 to 100 (0 or none: 50), `nextPageToken` empty on the last
 * page. The cursor is base64url of `{ v: 1, c }`, the last id of the page.
 */
export function paginatePushConfigs<T extends { id?: string }>(
  configs: readonly T[],
  query: { pageSize?: number; pageToken?: string }
): { configs: T[]; nextPageToken: string } {
  const pageSize = query.pageSize || DEFAULT_PAGE_SIZE;
  const sorted = [...configs].sort((a, b) => {
    const left = a.id ?? '';
    const right = b.id ?? '';
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const after = query.pageToken ? decodeConfigToken(query.pageToken) : undefined;
  const remaining =
    after === undefined ? sorted : sorted.filter((config) => (config.id ?? '') > after);
  const page = remaining.slice(0, pageSize);
  const last = page.at(-1);
  return {
    configs: page,
    nextPageToken:
      last && remaining.length > page.length
        ? Buffer.from(JSON.stringify({ v: 1, c: last.id ?? '' })).toString('base64url')
        : '',
  };
}

function decodeConfigToken(token: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw invalidPageToken();
  try {
    const parsed = configCursorSchema.safeParse(
      JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
    );
    if (!parsed.success) throw invalidPageToken();
    return parsed.data.c;
  } catch (error) {
    if (error instanceof A2AError) throw error;
    throw invalidPageToken();
  }
}
