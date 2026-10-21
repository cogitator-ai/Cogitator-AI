/**
 * Base memory adapter - abstract class for all adapters
 */

import { nanoid } from 'nanoid';
import type {
  MemoryAdapter,
  MemoryProvider,
  MemoryResult,
  Thread,
  MemoryEntry,
  MemoryQueryOptions,
  NewMemoryEntry,
  ListThreadsOptions,
  ThreadPage,
  MemoryChange,
  MemoryChangeListener,
  MemoryEntryType,
  PathQueryOptions,
  EntryRedaction,
  ToolCall,
} from '@cogitator-ai/types';
import { CONVERSATION_ENTRY_TYPES } from '@cogitator-ai/types';

const MAX_TRACKED_THREADS = 10_000;

export abstract class BaseMemoryAdapter implements MemoryAdapter {
  abstract readonly provider: MemoryProvider;

  abstract createThread(
    agentId: string,
    metadata?: Record<string, unknown>,
    threadId?: string
  ): Promise<MemoryResult<Thread>>;

  abstract getThread(threadId: string): Promise<MemoryResult<Thread | null>>;

  abstract updateThread(
    threadId: string,
    metadata: Record<string, unknown>
  ): Promise<MemoryResult<Thread>>;

  abstract deleteThread(threadId: string): Promise<MemoryResult<void>>;

  abstract listThreads(options?: ListThreadsOptions): Promise<MemoryResult<ThreadPage>>;

  abstract addEntry(entry: NewMemoryEntry): Promise<MemoryResult<MemoryEntry>>;

  abstract getEntries(options: MemoryQueryOptions): Promise<MemoryResult<MemoryEntry[]>>;

  abstract getEntry(entryId: string): Promise<MemoryResult<MemoryEntry | null>>;

  abstract deleteEntry(entryId: string): Promise<MemoryResult<void>>;

  abstract clearThread(threadId: string): Promise<MemoryResult<void>>;

  abstract connect(): Promise<MemoryResult<void>>;

  abstract disconnect(): Promise<MemoryResult<void>>;

  private lastEntryTimes = new Map<string, number>();

  protected generateId(prefix: string): string {
    return `${prefix}_${nanoid(12)}`;
  }

  /**
   * Creation time for a new entry, strictly increasing per thread within this process so
   * entries saved in the same millisecond (e.g. a user message and its reply) keep their order.
   */
  protected nextEntryTimestamp(threadId: string): Date {
    const now = Date.now();
    const last = this.lastEntryTimes.get(threadId) ?? 0;
    const timestamp = now > last ? now : last + 1;

    this.lastEntryTimes.delete(threadId);
    this.lastEntryTimes.set(threadId, timestamp);
    if (this.lastEntryTimes.size > MAX_TRACKED_THREADS) {
      const oldest = this.lastEntryTimes.keys().next().value;
      if (oldest !== undefined) this.lastEntryTimes.delete(oldest);
    }

    return new Date(timestamp);
  }

  /** Creation time of a new entry: the `createdAt` it asks for, or the next {@link nextEntryTimestamp}. */
  protected entryTimestamp(entry: NewMemoryEntry): Date {
    return entry.createdAt ? new Date(entry.createdAt) : this.nextEntryTimestamp(entry.threadId);
  }

  /**
   * Why `limit` of `getEntries` cannot be served, if it cannot: a limit is a whole number, `0`
   * meaning every entry, like no limit.
   */
  protected entryLimitProblem(limit: number | undefined): string | undefined {
    if (limit === undefined || (Number.isInteger(limit) && limit >= 0)) return undefined;
    return `getEntries limit must be a whole number of 0 or more, got ${limit}`;
  }

  /** Why `threadId` cannot name a new thread, if it cannot: an id is a non-empty string */
  protected threadIdProblem(threadId: string | undefined): string | undefined {
    if (threadId === undefined || (typeof threadId === 'string' && threadId.length > 0)) {
      return undefined;
    }
    return 'createThread threadId must be a non-empty string';
  }

  protected success<T>(data: T): MemoryResult<T> {
    return { success: true, data };
  }

  protected failure(error: string): MemoryResult<never> {
    return { success: false, error };
  }
}

/**
 * A memory adapter that reports what it changes (`onChange`), which the message index and other
 * listeners rely on. Every built-in adapter extends it. An adapter of your own extends it once
 * every write passes its result through {@link reported}: `addEntry`, `deleteEntry`,
 * `clearThread` and `deleteThread`, and entries or threads it drops on its own through
 * {@link report}. An adapter that reports nothing extends {@link BaseMemoryAdapter} instead, so
 * nobody takes its silence for no changes.
 */
export abstract class ChangeReportingMemoryAdapter extends BaseMemoryAdapter {
  private readonly changeListeners = new Set<MemoryChangeListener>();

  onChange(listener: MemoryChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /**
   * `result`, after telling the change listeners about the change it made when it succeeded. A
   * listener that throws is logged and does not fail the write.
   */
  protected reported<T>(
    result: MemoryResult<T>,
    change: (data: T) => MemoryChange
  ): MemoryResult<T> {
    if (result.success && this.changeListeners.size > 0) this.report(change(result.data));
    return result;
  }

  /**
   * `redactEntry` over a store: reads the entry, leaves it as {@link redactedEntry} says, writes
   * it back with `replace` and reports the change
   */
  protected async redactThrough(
    entryId: string,
    redaction: EntryRedaction,
    replace: (entry: MemoryEntry) => Promise<MemoryResult<void>>
  ): Promise<MemoryResult<MemoryEntry | null>> {
    const found = await this.getEntry(entryId);
    if (!found.success) return found;
    if (!found.data) return this.success(null);
    const redacted = redactedEntry(found.data, redaction);
    if (!redacted) {
      return this.failure(
        `Entry ${entryId} is a ${found.data.type ?? 'message'} entry, which cannot be redacted: delete it instead`
      );
    }
    const written = await replace(redacted);
    if (!written.success) return written;
    return this.reported(this.success<MemoryEntry | null>(redacted), () => ({
      type: 'entry-redacted',
      entryId,
      threadId: redacted.threadId,
    }));
  }

  /** Tells the change listeners about `change`; one that throws is logged */
  protected report(change: MemoryChange): void {
    for (const listener of this.changeListeners) {
      try {
        listener(change);
      } catch (error) {
        console.warn(`[${this.provider} memory] A change listener failed:`, error);
      }
    }
  }
}

/** Whether an entry of `type` (absent meaning `message`) is one `types` asks for */
export function entryTypeWanted(
  type: MemoryEntryType | undefined,
  types: readonly MemoryEntryType[] | 'all' | undefined
): boolean {
  if (types === 'all') return true;
  return (types ?? CONVERSATION_ENTRY_TYPES).includes(type ?? 'message');
}

/** What a redacted entry says in place of what it said */
export const REDACTED_TEXT = '[redacted]';

/**
 * `entry` with what it said replaced by {@link REDACTED_TEXT}: its text, the arguments of its tool
 * calls and the results of its tools, its role and the ids that tie calls to results kept, and
 * `metadata.redacted` recording `redaction`. Undefined for an entry that is no conversation
 * entry, such as a compaction.
 */
export function redactedEntry(
  entry: MemoryEntry,
  redaction: EntryRedaction
): MemoryEntry | undefined {
  if (!CONVERSATION_ENTRY_TYPES.includes(entry.type ?? 'message')) return undefined;
  const message = { ...entry.message, content: REDACTED_TEXT };
  if ('toolCalls' in message && Array.isArray(message.toolCalls)) {
    message.toolCalls = (message.toolCalls as ToolCall[]).map((call) => ({
      ...call,
      arguments: {},
    }));
  }
  return {
    ...entry,
    message,
    ...(entry.toolCalls && {
      toolCalls: entry.toolCalls.map((call) => ({ ...call, arguments: {} })),
    }),
    ...(entry.toolResults && {
      toolResults: entry.toolResults.map((result) => ({
        callId: result.callId,
        name: result.name,
        result: REDACTED_TEXT,
        ...(result.error !== undefined && { error: REDACTED_TEXT }),
      })),
    }),
    tokenCount: Math.min(entry.tokenCount, 4),
    metadata: {
      ...entry.metadata,
      redacted: {
        at: redaction.at.toISOString(),
        ...(redaction.reason !== undefined && { reason: redaction.reason }),
      },
    },
  };
}

/** An entry without the tool calls and results a read did not ask for */
export function withoutToolCalls(entry: MemoryEntry): MemoryEntry {
  const { toolCalls: _calls, toolResults: _results, ...rest } = entry;
  return rest;
}

/**
 * The most entries a path read walks: far beyond any real branch, it only ends a walk a damaged
 * store would make go round a cycle forever
 */
export const MAX_PATH_DEPTH = 1_000_000;

/**
 * An event of a copied entry pointing at the copies: a field holding the id of an entry copied
 * before it, such as the first kept entry of a compaction, names that entry's copy
 */
function withCopiedIds(
  event: Record<string, unknown>,
  copies: ReadonlyMap<string, string>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(event).map(([key, value]) => [
      key,
      typeof value === 'string' ? (copies.get(value) ?? value) : value,
    ])
  );
}

/**
 * A memory adapter whose threads are trees of entries (see `MemoryEntry.parentId`), with an
 * active leaf new entries go after. Every built-in adapter extends it. An adapter of your own
 * stores `parentId` and the leaf, chooses the parent in `addEntry` as `NewMemoryEntry`
 * describes, and implements {@link setActiveLeaf}: reading a path, rewinding, checking out and
 * forking then work from `getEntry` and `getThread`, and an adapter reads paths faster by
 * overriding {@link getPath}.
 */
export abstract class BranchingMemoryAdapter extends ChangeReportingMemoryAdapter {
  /**
   * Makes `leafId` the thread's active leaf, null for a thread with no entries. Fails, leaving the
   * leaf as it was, when `leafId` is not an entry of the thread at the moment of the write: a
   * checkout racing a delete must not leave the leaf on a deleted entry.
   */
  protected abstract setActiveLeaf(
    threadId: string,
    leafId: string | null
  ): Promise<MemoryResult<Thread>>;

  async getPath(options: PathQueryOptions): Promise<MemoryResult<MemoryEntry[]>> {
    const limitProblem = this.entryLimitProblem(options.limit);
    if (limitProblem) return this.failure(limitProblem);
    const start = await this.pathStart(options);
    if (!start.success) return start;
    const wanted: MemoryEntry[] = [];
    const seen = new Set<string>();
    let current = start.data;
    while (current && !seen.has(current)) {
      seen.add(current);
      const found = await this.getEntry(current);
      if (!found.success) return found;
      const entry = found.data;
      if (entry?.threadId !== options.threadId) break;
      if (entryTypeWanted(entry.type, options.types)) {
        wanted.push(options.includeToolCalls ? entry : withoutToolCalls(entry));
        if (options.limit && wanted.length >= options.limit) break;
      }
      current = entry.parentId ?? null;
    }
    return this.success(wanted.reverse());
  }

  /**
   * The entry a path read starts at, walking back: the parent of `before`, else the leaf asked
   * for, else the active leaf. Null for an empty path. The thread is read first in every case, so
   * an adapter that chains entries of older versions on reading a thread does it before the walk.
   */
  protected async pathStart(options: PathQueryOptions): Promise<MemoryResult<string | null>> {
    const thread = await this.getThread(options.threadId);
    if (!thread.success) return thread;
    if (!thread.data) return this.failure(`Thread not found: ${options.threadId}`);
    if (options.before !== undefined) {
      const before = await this.entryOf(options.threadId, options.before);
      if (!before.success) return before;
      return this.success(before.data.parentId ?? null);
    }
    if (options.leafId !== undefined) {
      const leaf = await this.entryOf(options.threadId, options.leafId);
      if (!leaf.success) return leaf;
      return this.success(leaf.data.id);
    }
    return this.success(thread.data.activeLeafId ?? null);
  }

  async rewind(threadId: string, toEntryId: string): Promise<MemoryResult<Thread>> {
    const target = await this.entryOf(threadId, toEntryId);
    if (!target.success) return target;
    const path = await this.getPath({ threadId, types: 'all' });
    if (!path.success) return path;
    if (!path.data.some((entry) => entry.id === toEntryId)) {
      return this.failure(
        `Entry ${toEntryId} is not on the active branch of thread ${threadId}: check it out instead`
      );
    }
    return this.setActiveLeaf(threadId, toEntryId);
  }

  async checkout(threadId: string, entryId: string): Promise<MemoryResult<Thread>> {
    const target = await this.entryOf(threadId, entryId);
    if (!target.success) return target;
    return this.setActiveLeaf(threadId, entryId);
  }

  async forkThread(
    threadId: string,
    atEntryId: string,
    newThreadId?: string
  ): Promise<MemoryResult<Thread>> {
    const source = await this.getThread(threadId);
    if (!source.success) return source;
    if (!source.data) return this.failure(`Thread not found: ${threadId}`);
    const path = await this.getPath({
      threadId,
      leafId: atEntryId,
      types: 'all',
      includeToolCalls: true,
    });
    if (!path.success) return path;
    const fork = await this.createThread(
      source.data.agentId,
      { ...source.data.metadata, forkedFrom: { threadId, entryId: atEntryId } },
      newThreadId
    );
    if (!fork.success) return fork;
    let parentId: string | null = null;
    const copies = new Map<string, string>();
    for (const entry of path.data) {
      const { id, threadId: _thread, seq: _seq, formatVersion: _format, ...copy } = entry;
      const added = await this.addEntry({
        ...copy,
        threadId: fork.data.id,
        parentId,
        metadata: { ...entry.metadata, forkOf: id },
        ...(entry.event && { event: withCopiedIds(entry.event, copies) }),
      });
      if (!added.success) return added;
      copies.set(id, added.data.id);
      parentId = added.data.id;
    }
    const forked = await this.getThread(fork.data.id);
    if (!forked.success) return forked;
    return forked.data
      ? this.success(forked.data)
      : this.failure(`Thread not found: ${fork.data.id}`);
  }

  /** The entry, when it is one of the thread's */
  private async entryOf(threadId: string, entryId: string): Promise<MemoryResult<MemoryEntry>> {
    const found = await this.getEntry(entryId);
    if (!found.success) return found;
    if (found.data?.threadId !== threadId) {
      return this.failure(`Entry ${entryId} is not in thread ${threadId}`);
    }
    return this.success(found.data);
  }
}
