import { nanoid } from 'nanoid';
import type {
  MemoryAdapter,
  MemoryEntry,
  Thread,
  MemoryResult,
  MemoryProvider,
  MemoryQueryOptions,
  ListThreadsOptions,
  ThreadPage,
} from '@cogitator-ai/types';

export class MockMemoryAdapter implements MemoryAdapter {
  readonly provider: MemoryProvider = 'memory';

  private threads = new Map<string, Thread>();
  private entries = new Map<string, MemoryEntry[]>();
  private _connected = false;
  private _calls: Array<{ method: string; args: unknown[] }> = [];

  async connect(): Promise<MemoryResult<void>> {
    this._calls.push({ method: 'connect', args: [] });
    this._connected = true;
    return { success: true, data: undefined };
  }

  async disconnect(): Promise<MemoryResult<void>> {
    this._calls.push({ method: 'disconnect', args: [] });
    this._connected = false;
    return { success: true, data: undefined };
  }

  isConnected(): boolean {
    return this._connected;
  }

  async createThread(
    agentId: string,
    metadata?: Record<string, unknown>,
    threadId?: string
  ): Promise<MemoryResult<Thread>> {
    this._calls.push({ method: 'createThread', args: [agentId, metadata, threadId] });
    if (threadId === '') {
      return { success: false, error: 'createThread threadId must be a non-empty string' };
    }

    const thread: Thread = {
      id: threadId ?? `thread_${nanoid(8)}`,
      agentId,
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: metadata ?? {},
    };

    this.threads.set(thread.id, thread);
    this.entries.set(thread.id, []);

    return { success: true, data: thread };
  }

  async getThread(threadId: string): Promise<MemoryResult<Thread | null>> {
    this._calls.push({ method: 'getThread', args: [threadId] });
    const thread = this.threads.get(threadId) ?? null;
    return { success: true, data: thread };
  }

  async updateThread(
    threadId: string,
    metadata: Record<string, unknown>
  ): Promise<MemoryResult<Thread>> {
    this._calls.push({ method: 'updateThread', args: [threadId, metadata] });

    const thread = this.threads.get(threadId);
    if (!thread) {
      return { success: false, error: `Thread ${threadId} not found` };
    }

    thread.metadata = { ...thread.metadata, ...metadata };
    thread.updatedAt = new Date();

    return { success: true, data: thread };
  }

  async deleteThread(threadId: string): Promise<MemoryResult<void>> {
    this._calls.push({ method: 'deleteThread', args: [threadId] });
    this.threads.delete(threadId);
    this.entries.delete(threadId);
    return { success: true, data: undefined };
  }

  async listThreads(options: ListThreadsOptions = {}): Promise<MemoryResult<ThreadPage>> {
    this._calls.push({ method: 'listThreads', args: [options] });
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return { success: false, error: `listThreads limit must be from 1 to 500, got ${limit}` };
    }
    const start = options.cursor === undefined ? 0 : Number(options.cursor);
    if (!Number.isInteger(start) || start < 0) {
      return { success: false, error: 'listThreads cursor is not valid' };
    }
    const sign = options.order === 'asc' ? 1 : -1;
    const matching = [...this.threads.values()]
      .filter(
        (thread) =>
          (options.agentId === undefined || thread.agentId === options.agentId) &&
          (!options.updatedAfter || thread.updatedAt >= options.updatedAfter) &&
          Object.entries(options.metadata ?? {}).every(
            ([key, value]) => thread.metadata[key] === value
          )
      )
      .sort(
        (a, b) => sign * (a.updatedAt.getTime() - b.updatedAt.getTime() || a.id.localeCompare(b.id))
      );
    const threads = matching.slice(start, start + limit);
    return {
      success: true,
      data: {
        threads,
        ...(start + limit < matching.length && { nextCursor: String(start + limit) }),
      },
    };
  }

  async addEntry(
    entry: Omit<MemoryEntry, 'id' | 'createdAt'> & { id?: string }
  ): Promise<MemoryResult<MemoryEntry>> {
    this._calls.push({ method: 'addEntry', args: [entry] });

    const memoryEntry: MemoryEntry = {
      id: entry.id ?? `entry_${nanoid(8)}`,
      threadId: entry.threadId,
      message: entry.message,
      tokenCount: entry.tokenCount ?? 0,
      createdAt: new Date(),
      toolCalls: entry.toolCalls,
      toolResults: entry.toolResults,
      metadata: entry.metadata,
    };

    const threadEntries = this.entries.get(entry.threadId) ?? [];
    threadEntries.push(memoryEntry);
    this.entries.set(entry.threadId, threadEntries);

    return { success: true, data: memoryEntry };
  }

  async getEntries(options: MemoryQueryOptions): Promise<MemoryResult<MemoryEntry[]>> {
    this._calls.push({ method: 'getEntries', args: [options] });

    let entries = this.entries.get(options.threadId) ?? [];

    if (options.before) {
      entries = entries.filter((e) => e.createdAt < options.before!);
    }

    if (options.after) {
      entries = entries.filter((e) => e.createdAt > options.after!);
    }

    if (options.limit) {
      entries = entries.slice(-options.limit);
    }

    return { success: true, data: entries };
  }

  async getEntry(entryId: string): Promise<MemoryResult<MemoryEntry | null>> {
    this._calls.push({ method: 'getEntry', args: [entryId] });

    for (const threadEntries of this.entries.values()) {
      const entry = threadEntries.find((e) => e.id === entryId);
      if (entry) {
        return { success: true, data: entry };
      }
    }

    return { success: true, data: null };
  }

  async deleteEntry(entryId: string): Promise<MemoryResult<void>> {
    this._calls.push({ method: 'deleteEntry', args: [entryId] });

    for (const [threadId, threadEntries] of this.entries.entries()) {
      const index = threadEntries.findIndex((e) => e.id === entryId);
      if (index !== -1) {
        threadEntries.splice(index, 1);
        this.entries.set(threadId, threadEntries);
        break;
      }
    }

    return { success: true, data: undefined };
  }

  async clearThread(threadId: string): Promise<MemoryResult<void>> {
    this._calls.push({ method: 'clearThread', args: [threadId] });
    this.entries.set(threadId, []);
    return { success: true, data: undefined };
  }

  getCalls(): Array<{ method: string; args: unknown[] }> {
    return [...this._calls];
  }

  getCallsFor(method: string): Array<{ method: string; args: unknown[] }> {
    return this._calls.filter((c) => c.method === method);
  }

  reset(): void {
    this.threads.clear();
    this.entries.clear();
    this._calls = [];
    this._connected = false;
  }
}

export function createMockMemoryAdapter(): MockMemoryAdapter {
  return new MockMemoryAdapter();
}
