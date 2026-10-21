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
} from '@cogitator-ai/types';

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
