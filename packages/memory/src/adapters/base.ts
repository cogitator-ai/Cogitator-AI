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
} from '@cogitator/types';

export abstract class BaseMemoryAdapter implements MemoryAdapter {
  abstract readonly provider: MemoryProvider;

  abstract createThread(
    agentId: string,
    metadata?: Record<string, unknown>
  ): Promise<MemoryResult<Thread>>;

  abstract getThread(threadId: string): Promise<MemoryResult<Thread | null>>;

  abstract updateThread(
    threadId: string,
    metadata: Record<string, unknown>
  ): Promise<MemoryResult<Thread>>;

  abstract deleteThread(threadId: string): Promise<MemoryResult<void>>;

  abstract addEntry(
    entry: Omit<MemoryEntry, 'id' | 'createdAt'>
  ): Promise<MemoryResult<MemoryEntry>>;

  abstract getEntries(
    options: MemoryQueryOptions
  ): Promise<MemoryResult<MemoryEntry[]>>;

  abstract getEntry(entryId: string): Promise<MemoryResult<MemoryEntry | null>>;

  abstract deleteEntry(entryId: string): Promise<MemoryResult<void>>;

  abstract clearThread(threadId: string): Promise<MemoryResult<void>>;

  abstract connect(): Promise<MemoryResult<void>>;

  abstract disconnect(): Promise<MemoryResult<void>>;

  protected generateId(prefix: string): string {
    return `${prefix}_${nanoid(12)}`;
  }

  protected success<T>(data: T): MemoryResult<T> {
    return { success: true, data };
  }

  protected failure(error: string): MemoryResult<never> {
    return { success: false, error };
  }
}
