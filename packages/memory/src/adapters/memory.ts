/**
 * In-memory adapter - default, zero dependencies
 */

import type {
  ListThreadsOptions,
  Thread,
  ThreadPage,
  MemoryEntry,
  MemoryQueryOptions,
  MemoryResult,
  InMemoryAdapterConfig,
  MemoryProvider,
  NewMemoryEntry,
} from '@cogitator-ai/types';
import { BranchingMemoryAdapter, entryTypeWanted, withoutToolCalls } from './base';
import { MEMORY_ENTRY_FORMAT } from '@cogitator-ai/types';
import {
  compareForListing,
  isAfterCursor,
  matchesListing,
  threadListing,
  threadPage,
} from './thread-listing';

/**
 * A copy of `value` that shares nothing with it: a structured clone, or for a value it cannot
 * clone (one holding functions) the JSON form the database adapters would store, functions left
 * out. Values that are not even JSON (a cycle with a function in it) make it throw.
 */
function storable<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

function copyThread(thread: Thread): Thread {
  return {
    ...thread,
    metadata: structuredClone(thread.metadata),
    createdAt: new Date(thread.createdAt),
    updatedAt: new Date(thread.updatedAt),
  };
}

function copyEntry(entry: MemoryEntry): MemoryEntry {
  return { ...structuredClone(entry), createdAt: new Date(entry.createdAt) };
}

export class InMemoryAdapter extends BranchingMemoryAdapter {
  readonly provider: MemoryProvider = 'memory';

  private threads = new Map<string, Thread>();
  private entries = new Map<string, MemoryEntry>();
  private threadEntries = new Map<string, string[]>();
  private maxEntries: number;
  private seq = 0;

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
    metadata: Record<string, unknown> = {},
    threadId?: string
  ): Promise<MemoryResult<Thread>> {
    const idProblem = this.threadIdProblem(threadId);
    if (idProblem) return this.failure(idProblem);
    const copied = this.stored(metadata, 'thread metadata');
    if (!copied.success) return copied;
    const id = threadId ?? this.generateId('thread');
    const now = new Date();
    const existing = this.threads.get(id);

    const thread: Thread = {
      id,
      agentId,
      metadata: copied.data,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.activeLeafId !== undefined && { activeLeafId: existing.activeLeafId }),
    };
    this.threads.set(id, thread);
    if (!this.threadEntries.has(id)) {
      this.threadEntries.set(id, []);
    }
    return this.success(copyThread(thread));
  }

  private stored<T>(value: T, what: string): MemoryResult<T> {
    try {
      return this.success(storable(value));
    } catch (error) {
      return this.failure(
        `Cannot store the ${what}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async getThread(threadId: string): Promise<MemoryResult<Thread | null>> {
    const thread = this.threads.get(threadId);
    return this.success(thread ? copyThread(thread) : null);
  }

  async listThreads(options?: ListThreadsOptions): Promise<MemoryResult<ThreadPage>> {
    const listing = threadListing(options);
    if (typeof listing === 'string') return this.failure(listing);
    const ordered = [...this.threads.values()]
      .filter((thread) => matchesListing(thread, listing) && isAfterCursor(thread, listing))
      .sort(compareForListing(listing))
      .slice(0, listing.limit + 1)
      .map(copyThread);
    return this.success(threadPage(ordered, listing));
  }

  async updateThread(
    threadId: string,
    metadata: Record<string, unknown>
  ): Promise<MemoryResult<Thread>> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return this.failure(`Thread not found: ${threadId}`);
    }
    const copied = this.stored(metadata, 'thread metadata');
    if (!copied.success) return copied;
    thread.metadata = { ...thread.metadata, ...copied.data };
    thread.updatedAt = new Date();
    return this.success(copyThread(thread));
  }

  async deleteThread(threadId: string): Promise<MemoryResult<void>> {
    return this.reported(await this.dropThread(threadId), () => ({
      type: 'thread-deleted',
      threadId,
    }));
  }

  private async dropThread(threadId: string): Promise<MemoryResult<void>> {
    const entryIds = this.threadEntries.get(threadId) ?? [];
    for (const id of entryIds) {
      this.entries.delete(id);
    }
    this.threads.delete(threadId);
    this.threadEntries.delete(threadId);
    return this.success(undefined);
  }

  async addEntry(entry: NewMemoryEntry): Promise<MemoryResult<MemoryEntry>> {
    return this.reported(await this.storeEntry(entry), (stored) => ({
      type: 'entry-added',
      entry: stored,
    }));
  }

  private async storeEntry(entry: NewMemoryEntry): Promise<MemoryResult<MemoryEntry>> {
    const thread = this.threads.get(entry.threadId);
    if (!thread) return this.failure(`Thread not found: ${entry.threadId}`);
    if (entry.parentId) {
      const parent = this.entries.get(entry.parentId);
      if (parent?.threadId !== entry.threadId) {
        return this.failure(`Parent entry ${entry.parentId} is not in thread ${entry.threadId}`);
      }
    }
    const copied = this.stored(entry, 'entry');
    if (!copied.success) return copied;
    const evicted = this.makeRoom(entry.threadId, entry.parentId ?? thread.activeLeafId);

    const { activate, parentId: askedParent, ...fields } = copied.data;
    const full: MemoryEntry = {
      ...fields,
      id: this.generateId('entry'),
      createdAt: this.entryTimestamp(entry),
      type: fields.type ?? (fields.message?.role === 'tool' ? 'tool_result' : 'message'),
      parentId: askedParent === undefined ? (thread.activeLeafId ?? null) : askedParent,
      seq: ++this.seq,
      formatVersion: MEMORY_ENTRY_FORMAT,
    };

    this.entries.set(full.id, full);
    const threadList = this.threadEntries.get(entry.threadId) ?? [];
    threadList.push(full.id);
    this.threadEntries.set(entry.threadId, threadList);
    if (activate !== false) thread.activeLeafId = full.id;

    for (const entryId of evicted) this.report({ type: 'entry-deleted', entryId });
    return this.success(copyEntry(full));
  }

  /**
   * Keeps a thread under `maxEntries`: the oldest entry of a branch that is not active goes
   * first, then the oldest of the active branch, whose next entry becomes the first. `parentId`,
   * the entry the next one goes after, and the active leaf stay. Synchronous, so the room made
   * and the entry added go together: the ids it evicted, to report once the entry is in.
   */
  private makeRoom(threadId: string, parentId: string | undefined): string[] {
    const ids = this.threadEntries.get(threadId) ?? [];
    const evicted: string[] = [];
    if (ids.length < this.maxEntries) return evicted;
    const active = new Set<string>();
    let current = this.threads.get(threadId)?.activeLeafId;
    while (current && !active.has(current)) {
      active.add(current);
      current = this.entries.get(current)?.parentId ?? undefined;
    }
    const leaf = this.threads.get(threadId)?.activeLeafId;
    while (ids.length >= this.maxEntries) {
      const evictable = ids.filter((id) => id !== parentId && id !== leaf);
      const victim = evictable.find((id) => !active.has(id)) ?? evictable[0];
      if (!victim) break;
      this.spliceOut(victim);
      evicted.push(victim);
    }
    return evicted;
  }

  protected async setActiveLeaf(
    threadId: string,
    leafId: string | null
  ): Promise<MemoryResult<Thread>> {
    const thread = this.threads.get(threadId);
    if (!thread) return this.failure(`Thread not found: ${threadId}`);
    if (leafId !== null && this.entries.get(leafId)?.threadId !== threadId) {
      return this.failure(`Entry ${leafId} is not in thread ${threadId}`);
    }
    if (leafId === null) delete thread.activeLeafId;
    else thread.activeLeafId = leafId;
    return this.success(copyThread(thread));
  }

  async getEntries(options: MemoryQueryOptions): Promise<MemoryResult<MemoryEntry[]>> {
    const limitProblem = this.entryLimitProblem(options.limit);
    if (limitProblem) return this.failure(limitProblem);
    const entryIds = this.threadEntries.get(options.threadId) ?? [];
    let entries = entryIds
      .map((id) => this.entries.get(id))
      .filter((e): e is MemoryEntry => e !== undefined)
      .map(copyEntry);

    if (options.before) {
      entries = entries.filter((e) => e.createdAt < options.before!);
    }
    if (options.after) {
      entries = entries.filter((e) => e.createdAt > options.after!);
    }
    entries = entries.filter((e) => entryTypeWanted(e.type, options.types));
    if (!options.includeToolCalls) entries = entries.map(withoutToolCalls);

    entries.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    if (options.limit && entries.length > options.limit) {
      entries = entries.slice(-options.limit);
    }

    return this.success(entries);
  }

  async getEntry(entryId: string): Promise<MemoryResult<MemoryEntry | null>> {
    const entry = this.entries.get(entryId);
    return this.success(entry ? copyEntry(entry) : null);
  }

  async deleteEntry(entryId: string): Promise<MemoryResult<void>> {
    return this.reported(await this.removeEntry(entryId), () => ({
      type: 'entry-deleted',
      entryId,
    }));
  }

  /** Deletes an entry and splices it out of its branch: its children go after its parent */
  private async removeEntry(entryId: string): Promise<MemoryResult<void>> {
    this.spliceOut(entryId);
    return this.success(undefined);
  }

  private spliceOut(entryId: string): void {
    const entry = this.entries.get(entryId);
    if (entry) {
      const threadList = this.threadEntries.get(entry.threadId);
      if (threadList) {
        const idx = threadList.indexOf(entryId);
        if (idx !== -1) threadList.splice(idx, 1);
        for (const id of threadList) {
          const child = this.entries.get(id);
          if (child?.parentId === entryId) child.parentId = entry.parentId ?? null;
        }
      }
      const thread = this.threads.get(entry.threadId);
      if (thread?.activeLeafId === entryId) {
        if (entry.parentId) thread.activeLeafId = entry.parentId;
        else delete thread.activeLeafId;
      }
      this.entries.delete(entryId);
    }
  }

  async clearThread(threadId: string): Promise<MemoryResult<void>> {
    return this.reported(await this.emptyThread(threadId), () => ({
      type: 'thread-cleared',
      threadId,
    }));
  }

  private async emptyThread(threadId: string): Promise<MemoryResult<void>> {
    const entryIds = this.threadEntries.get(threadId) ?? [];
    for (const id of entryIds) {
      this.entries.delete(id);
    }
    this.threadEntries.set(threadId, []);
    const thread = this.threads.get(threadId);
    if (thread) delete thread.activeLeafId;
    return this.success(undefined);
  }

  get stats() {
    return {
      threads: this.threads.size,
      entries: this.entries.size,
    };
  }
}
