/**
 * In-memory adapter - default, zero dependencies
 */

import type {
  Thread,
  MemoryEntry,
  MemoryQueryOptions,
  MemoryResult,
  InMemoryAdapterConfig,
  MemoryProvider,
} from '@cogitator/types';
import { BaseMemoryAdapter } from './base.js';

export class InMemoryAdapter extends BaseMemoryAdapter {
  readonly provider: MemoryProvider = 'memory';

  private threads = new Map<string, Thread>();
  private entries = new Map<string, MemoryEntry>();
  private threadEntries = new Map<string, string[]>();
  private maxEntries: number;

  constructor(config: InMemoryAdapterConfig = { provider: 'memory' }) {
    super();
    this.maxEntries = config.maxEntries ?? 10000;
  }

  async connect(): Promise<MemoryResult<void>> {
    return this.success(undefined);
  }

  async disconnect(): Promise<MemoryResult<void>> {
    this.threads.clear();
    this.entries.clear();
    this.threadEntries.clear();
    return this.success(undefined);
  }

  async createThread(
    agentId: string,
    metadata: Record<string, unknown> = {}
  ): Promise<MemoryResult<Thread>> {
    const thread: Thread = {
      id: this.generateId('thread'),
      agentId,
      metadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.threads.set(thread.id, thread);
    this.threadEntries.set(thread.id, []);
    return this.success(thread);
  }

  async getThread(threadId: string): Promise<MemoryResult<Thread | null>> {
    return this.success(this.threads.get(threadId) ?? null);
  }

  async updateThread(
    threadId: string,
    metadata: Record<string, unknown>
  ): Promise<MemoryResult<Thread>> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return this.failure(`Thread not found: ${threadId}`);
    }
    thread.metadata = { ...thread.metadata, ...metadata };
    thread.updatedAt = new Date();
    return this.success(thread);
  }

  async deleteThread(threadId: string): Promise<MemoryResult<void>> {
    const entryIds = this.threadEntries.get(threadId) ?? [];
    for (const id of entryIds) {
      this.entries.delete(id);
    }
    this.threads.delete(threadId);
    this.threadEntries.delete(threadId);
    return this.success(undefined);
  }

  async addEntry(
    entry: Omit<MemoryEntry, 'id' | 'createdAt'>
  ): Promise<MemoryResult<MemoryEntry>> {
    // Enforce max entries limit with LRU eviction
    if (this.entries.size >= this.maxEntries) {
      const oldestId = this.entries.keys().next().value;
      if (oldestId) {
        await this.deleteEntry(oldestId);
      }
    }

    const full: MemoryEntry = {
      ...entry,
      id: this.generateId('entry'),
      createdAt: new Date(),
    };

    this.entries.set(full.id, full);
    const threadList = this.threadEntries.get(entry.threadId) ?? [];
    threadList.push(full.id);
    this.threadEntries.set(entry.threadId, threadList);

    return this.success(full);
  }

  async getEntries(
    options: MemoryQueryOptions
  ): Promise<MemoryResult<MemoryEntry[]>> {
    const entryIds = this.threadEntries.get(options.threadId) ?? [];
    let entries = entryIds
      .map((id) => this.entries.get(id))
      .filter((e): e is MemoryEntry => e !== undefined);

    // Apply filters
    if (options.before) {
      entries = entries.filter((e) => e.createdAt < options.before!);
    }
    if (options.after) {
      entries = entries.filter((e) => e.createdAt > options.after!);
    }
    if (!options.includeToolCalls) {
      entries = entries.map((e) => ({
        ...e,
        toolCalls: undefined,
        toolResults: undefined,
      }));
    }

    // Sort by createdAt ascending (chronological)
    entries.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    // Apply limit from the end (most recent)
    if (options.limit && entries.length > options.limit) {
      entries = entries.slice(-options.limit);
    }

    return this.success(entries);
  }

  async getEntry(entryId: string): Promise<MemoryResult<MemoryEntry | null>> {
    return this.success(this.entries.get(entryId) ?? null);
  }

  async deleteEntry(entryId: string): Promise<MemoryResult<void>> {
    const entry = this.entries.get(entryId);
    if (entry) {
      const threadList = this.threadEntries.get(entry.threadId);
      if (threadList) {
        const idx = threadList.indexOf(entryId);
        if (idx !== -1) threadList.splice(idx, 1);
      }
      this.entries.delete(entryId);
    }
    return this.success(undefined);
  }

  async clearThread(threadId: string): Promise<MemoryResult<void>> {
    const entryIds = this.threadEntries.get(threadId) ?? [];
    for (const id of entryIds) {
      this.entries.delete(id);
    }
    this.threadEntries.set(threadId, []);
    return this.success(undefined);
  }

  // For testing: get internal state
  get stats() {
    return {
      threads: this.threads.size,
      entries: this.entries.size,
    };
  }
}
