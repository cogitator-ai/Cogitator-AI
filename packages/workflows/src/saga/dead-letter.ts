/**
 * Dead Letter Queue (DLQ) for failed workflow nodes
 *
 * Features:
 * - Multiple storage backends (memory, file)
 * - Failed node tracking with full context
 * - Retry capability
 * - Expiration/cleanup
 * - Query and filtering
 */

import type { DeadLetterEntry, WorkflowState } from '@cogitator/types';
import { nanoid } from 'nanoid';
import { promises as fs } from 'fs';
import { join } from 'path';

/**
 * Extended dead letter entry (alias for DeadLetterEntry, for backwards compat)
 */
export type ExtendedDeadLetterEntry = DeadLetterEntry;

/**
 * DLQ query filters
 */
export interface DLQFilters {
  workflowId?: string;
  workflowName?: string;
  nodeId?: string;
  minAttempts?: number;
  maxAttempts?: number;
  createdAfter?: number;
  createdBefore?: number;
  tags?: string[];
  limit?: number;
  offset?: number;
}

/**
 * Abstract DLQ implementation
 */
export abstract class BaseDLQ {
  abstract add(entry: DeadLetterEntry): Promise<string>;
  abstract get(id: string): Promise<DeadLetterEntry | null>;
  abstract list(filters?: DLQFilters): Promise<DeadLetterEntry[]>;
  abstract retry(id: string): Promise<boolean>;
  abstract remove(id: string): Promise<boolean>;
  abstract count(filters?: DLQFilters): Promise<number>;
  abstract clear(): Promise<void>;
}

/**
 * In-memory Dead Letter Queue
 */
export class InMemoryDLQ extends BaseDLQ {
  private entries: Map<string, DeadLetterEntry> = new Map();
  private defaultTTL: number;
  private cleanupInterval?: ReturnType<typeof setInterval>;

  constructor(options: { defaultTTL?: number; cleanupIntervalMs?: number } = {}) {
    super();
    this.defaultTTL = options.defaultTTL ?? 7 * 24 * 60 * 60 * 1000;

    if (options.cleanupIntervalMs) {
      this.cleanupInterval = setInterval(
        () => void this.cleanup(),
        options.cleanupIntervalMs
      );
    }
  }

  async add(entry: DeadLetterEntry): Promise<string> {
    const id = `dlq_${nanoid(12)}`;
    const now = Date.now();

    const extended: DeadLetterEntry = {
      ...entry,
      id,
      createdAt: now,
      expiresAt: now + this.defaultTTL,
    };

    this.entries.set(id, extended);
    return id;
  }

  async get(id: string): Promise<DeadLetterEntry | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;

    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.entries.delete(id);
      return null;
    }

    return entry;
  }

  async list(filters: DLQFilters = {}): Promise<DeadLetterEntry[]> {
    const now = Date.now();
    let results: DeadLetterEntry[] = [];

    for (const entry of this.entries.values()) {
      if (entry.expiresAt && entry.expiresAt < now) continue;

      if (filters.workflowId && entry.workflowId !== filters.workflowId) continue;
      if (filters.workflowName && entry.workflowName !== filters.workflowName) continue;
      if (filters.nodeId && entry.nodeId !== filters.nodeId) continue;
      if (filters.minAttempts !== undefined && entry.attempts < filters.minAttempts) continue;
      if (filters.maxAttempts !== undefined && entry.attempts > filters.maxAttempts) continue;
      if (filters.createdAfter !== undefined && entry.createdAt < filters.createdAfter) continue;
      if (filters.createdBefore !== undefined && entry.createdAt > filters.createdBefore) continue;
      if (filters.tags && !filters.tags.every((t) => entry.tags?.includes(t))) continue;

      results.push(entry);
    }

    results.sort((a, b) => b.createdAt - a.createdAt);

    if (filters.offset) {
      results = results.slice(filters.offset);
    }
    if (filters.limit) {
      results = results.slice(0, filters.limit);
    }

    return results;
  }

  async retry(id: string): Promise<boolean> {
    const entry = await this.get(id);
    if (!entry) return false;

    entry.attempts++;
    entry.lastAttempt = Date.now();

    return true;
  }

  async remove(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }

  async count(filters: DLQFilters = {}): Promise<number> {
    const results = await this.list(filters);
    return results.length;
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }

  /**
   * Cleanup expired entries
   */
  private async cleanup(): Promise<void> {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [id, entry] of this.entries) {
      if (entry.expiresAt && entry.expiresAt < now) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      this.entries.delete(id);
    }
  }

  /**
   * Stop cleanup interval
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
  }
}

/**
 * File-based Dead Letter Queue
 */
export class FileDLQ extends BaseDLQ {
  private directory: string;
  private defaultTTL: number;
  private initialized = false;

  constructor(
    directory: string,
    options: { defaultTTL?: number } = {}
  ) {
    super();
    this.directory = directory;
    this.defaultTTL = options.defaultTTL ?? 7 * 24 * 60 * 60 * 1000;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    try {
      await fs.mkdir(this.directory, { recursive: true });
    } catch {
    }
    this.initialized = true;
  }

  private getFilePath(id: string): string {
    return join(this.directory, `${id}.json`);
  }

  async add(entry: DeadLetterEntry): Promise<string> {
    await this.ensureInitialized();

    const id = `dlq_${nanoid(12)}`;
    const now = Date.now();

    const extended: DeadLetterEntry = {
      ...entry,
      id,
      createdAt: now,
      expiresAt: now + this.defaultTTL,
    };

    const filePath = this.getFilePath(id);
    await fs.writeFile(filePath, JSON.stringify(extended, null, 2));

    return id;
  }

  async get(id: string): Promise<DeadLetterEntry | null> {
    await this.ensureInitialized();

    try {
      const filePath = this.getFilePath(id);
      const content = await fs.readFile(filePath, 'utf-8');
      const entry = JSON.parse(content) as DeadLetterEntry;

      if (entry.expiresAt && entry.expiresAt < Date.now()) {
        await this.remove(id);
        return null;
      }

      return entry;
    } catch {
      return null;
    }
  }

  async list(filters: DLQFilters = {}): Promise<DeadLetterEntry[]> {
    await this.ensureInitialized();

    const now = Date.now();
    let results: DeadLetterEntry[] = [];

    try {
      const files = await fs.readdir(this.directory);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const filePath = join(this.directory, file);
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const entry = JSON.parse(content) as DeadLetterEntry;

          if (entry.expiresAt && entry.expiresAt < now) {
            await fs.unlink(filePath).catch(() => {});
            continue;
          }

          if (filters.workflowId && entry.workflowId !== filters.workflowId) continue;
          if (filters.workflowName && entry.workflowName !== filters.workflowName) continue;
          if (filters.nodeId && entry.nodeId !== filters.nodeId) continue;
          if (filters.minAttempts !== undefined && entry.attempts < filters.minAttempts) continue;
          if (filters.maxAttempts !== undefined && entry.attempts > filters.maxAttempts) continue;
          if (filters.createdAfter !== undefined && entry.createdAt < filters.createdAfter) continue;
          if (filters.createdBefore !== undefined && entry.createdAt > filters.createdBefore) continue;
          if (filters.tags && !filters.tags.every((t) => entry.tags?.includes(t))) continue;

          results.push(entry);
        } catch {
        }
      }
    } catch {
    }

    results.sort((a, b) => b.createdAt - a.createdAt);

    if (filters.offset) {
      results = results.slice(filters.offset);
    }
    if (filters.limit) {
      results = results.slice(0, filters.limit);
    }

    return results;
  }

  async retry(id: string): Promise<boolean> {
    const entry = await this.get(id);
    if (!entry) return false;

    entry.attempts++;
    entry.lastAttempt = Date.now();

    const filePath = this.getFilePath(id);
    await fs.writeFile(filePath, JSON.stringify(entry, null, 2));

    return true;
  }

  async remove(id: string): Promise<boolean> {
    try {
      await fs.unlink(this.getFilePath(id));
      return true;
    } catch {
      return false;
    }
  }

  async count(filters: DLQFilters = {}): Promise<number> {
    const results = await this.list(filters);
    return results.length;
  }

  async clear(): Promise<void> {
    await this.ensureInitialized();

    try {
      const files = await fs.readdir(this.directory);
      await Promise.all(
        files
          .filter((f) => f.endsWith('.json'))
          .map((f) => fs.unlink(join(this.directory, f)).catch(() => {}))
      );
    } catch {
    }
  }
}

/**
 * Create DLQ entry from error
 */
export function createDLQEntry(
  nodeId: string,
  workflowId: string,
  workflowName: string,
  state: WorkflowState,
  error: Error,
  options: {
    input?: unknown;
    attempts?: number;
    maxAttempts?: number;
    tags?: string[];
    metadata?: Record<string, unknown>;
  } = {}
): DeadLetterEntry {
  return {
    id: '',
    nodeId,
    workflowId,
    workflowName,
    state,
    input: options.input,
    error: {
      name: error.name,
      message: error.message,
      stack: error.stack,
    },
    attempts: options.attempts ?? 1,
    maxAttempts: options.maxAttempts ?? 1,
    lastAttempt: Date.now(),
    createdAt: Date.now(),
    tags: options.tags,
    metadata: options.metadata,
  };
}

/**
 * Create an in-memory DLQ
 */
export function createInMemoryDLQ(
  options?: { defaultTTL?: number; cleanupIntervalMs?: number }
): InMemoryDLQ {
  return new InMemoryDLQ(options);
}

/**
 * Create a file-based DLQ
 */
export function createFileDLQ(
  directory: string,
  options?: { defaultTTL?: number }
): FileDLQ {
  return new FileDLQ(directory, options);
}
