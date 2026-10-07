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

  protected success<T>(data: T): MemoryResult<T> {
    return { success: true, data };
  }

  protected failure(error: string): MemoryResult<never> {
    return { success: false, error };
  }
}
