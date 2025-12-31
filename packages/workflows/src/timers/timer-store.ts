/**
 * Timer Store implementations for workflow timers
 *
 * Features:
 * - In-memory and file-based storage
 * - Timer persistence across restarts
 * - Efficient lookup by due time
 * - Cancellation support
 * - Fire event callbacks
 */

import type { TimerEntry, TimerStore } from '@cogitator-ai/types';
import { nanoid } from 'nanoid';
import { promises as fs } from 'fs';
import { join } from 'path';

/**
 * Timer query options
 */
export interface TimerQueryOptions {
  workflowId?: string;
  runId?: string;
  nodeId?: string;
  status?: 'pending' | 'fired' | 'cancelled';
  firesBefore?: number;
  firesAfter?: number;
  limit?: number;
  offset?: number;
}

type FireCallback = (entry: TimerEntry) => void;

/**
 * In-memory timer store
 */
export class InMemoryTimerStore implements TimerStore {
  private timers = new Map<string, TimerEntry>();
  private fireCallbacks: FireCallback[] = [];

  async schedule(
    entry: Omit<TimerEntry, 'id' | 'cancelled' | 'fired' | 'createdAt'>
  ): Promise<string> {
    const id = `timer_${nanoid(12)}`;

    const timer: TimerEntry = {
      ...entry,
      id,
      cancelled: false,
      fired: false,
      createdAt: Date.now(),
    };

    this.timers.set(id, timer);
    return id;
  }

  async get(id: string): Promise<TimerEntry | null> {
    return this.timers.get(id) ?? null;
  }

  async cancel(id: string): Promise<void> {
    const timer = this.timers.get(id);
    if (timer && !timer.cancelled && !timer.fired) {
      timer.cancelled = true;
    }
  }

  async getByWorkflow(workflowId: string): Promise<TimerEntry[]> {
    const results: TimerEntry[] = [];
    for (const timer of this.timers.values()) {
      if (timer.workflowId === workflowId) {
        results.push(timer);
      }
    }
    return results.sort((a, b) => a.firesAt - b.firesAt);
  }

  async getByRun(runId: string): Promise<TimerEntry[]> {
    const results: TimerEntry[] = [];
    for (const timer of this.timers.values()) {
      if (timer.runId === runId) {
        results.push(timer);
      }
    }
    return results.sort((a, b) => a.firesAt - b.firesAt);
  }

  async getPending(): Promise<TimerEntry[]> {
    const results: TimerEntry[] = [];
    for (const timer of this.timers.values()) {
      if (!timer.cancelled && !timer.fired) {
        results.push(timer);
      }
    }
    return results.sort((a, b) => a.firesAt - b.firesAt);
  }

  async getOverdue(): Promise<TimerEntry[]> {
    const now = Date.now();
    const results: TimerEntry[] = [];
    for (const timer of this.timers.values()) {
      if (!timer.cancelled && !timer.fired && timer.firesAt <= now) {
        results.push(timer);
      }
    }
    return results.sort((a, b) => a.firesAt - b.firesAt);
  }

  async markFired(id: string): Promise<void> {
    const timer = this.timers.get(id);
    if (timer && !timer.cancelled && !timer.fired) {
      timer.fired = true;
      for (const callback of this.fireCallbacks) {
        try {
          callback(timer);
        } catch {
        }
      }
    }
  }

  async cleanup(olderThan: number): Promise<number> {
    const cutoff = Date.now() - olderThan;
    let count = 0;

    for (const [id, timer] of this.timers) {
      if ((timer.fired || timer.cancelled) && timer.createdAt < cutoff) {
        this.timers.delete(id);
        count++;
      }
    }

    return count;
  }

  onFire(callback: FireCallback): () => void {
    this.fireCallbacks.push(callback);
    return () => {
      const idx = this.fireCallbacks.indexOf(callback);
      if (idx !== -1) {
        this.fireCallbacks.splice(idx, 1);
      }
    };
  }

  /**
   * List timers with filtering
   */
  async list(options: TimerQueryOptions = {}): Promise<TimerEntry[]> {
    let results: TimerEntry[] = [];

    for (const timer of this.timers.values()) {
      if (options.workflowId && timer.workflowId !== options.workflowId) continue;
      if (options.runId && timer.runId !== options.runId) continue;
      if (options.nodeId && timer.nodeId !== options.nodeId) continue;
      if (options.firesBefore !== undefined && timer.firesAt > options.firesBefore) continue;
      if (options.firesAfter !== undefined && timer.firesAt < options.firesAfter) continue;

      if (options.status) {
        if (options.status === 'pending' && (timer.fired || timer.cancelled)) continue;
        if (options.status === 'fired' && !timer.fired) continue;
        if (options.status === 'cancelled' && !timer.cancelled) continue;
      }

      results.push(timer);
    }

    results.sort((a, b) => a.firesAt - b.firesAt);

    if (options.offset) {
      results = results.slice(options.offset);
    }
    if (options.limit) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  /**
   * Count timers matching options
   */
  async count(options: TimerQueryOptions = {}): Promise<number> {
    const list = await this.list(options);
    return list.length;
  }

  /**
   * Clear all timers
   */
  async clear(): Promise<void> {
    this.timers.clear();
  }
}

/**
 * File-based timer store for persistence
 */
export class FileTimerStore implements TimerStore {
  private directory: string;
  private indexFile: string;
  private initialized = false;
  private cache = new Map<string, TimerEntry>();
  private fireCallbacks: FireCallback[] = [];

  constructor(directory: string) {
    this.directory = directory;
    this.indexFile = join(directory, 'timers.json');
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    try {
      await fs.mkdir(this.directory, { recursive: true });

      try {
        const content = await fs.readFile(this.indexFile, 'utf-8');
        const timers = JSON.parse(content) as TimerEntry[];
        for (const timer of timers) {
          this.cache.set(timer.id, timer);
        }
      } catch {
      }
    } catch {
    }

    this.initialized = true;
  }

  private async persist(): Promise<void> {
    const timers = Array.from(this.cache.values());
    await fs.writeFile(this.indexFile, JSON.stringify(timers, null, 2));
  }

  async schedule(
    entry: Omit<TimerEntry, 'id' | 'cancelled' | 'fired' | 'createdAt'>
  ): Promise<string> {
    await this.ensureInitialized();

    const id = `timer_${nanoid(12)}`;

    const timer: TimerEntry = {
      ...entry,
      id,
      cancelled: false,
      fired: false,
      createdAt: Date.now(),
    };

    this.cache.set(id, timer);
    await this.persist();
    return id;
  }

  async get(id: string): Promise<TimerEntry | null> {
    await this.ensureInitialized();
    return this.cache.get(id) ?? null;
  }

  async cancel(id: string): Promise<void> {
    await this.ensureInitialized();

    const timer = this.cache.get(id);
    if (timer && !timer.cancelled && !timer.fired) {
      timer.cancelled = true;
      await this.persist();
    }
  }

  async getByWorkflow(workflowId: string): Promise<TimerEntry[]> {
    await this.ensureInitialized();

    const results: TimerEntry[] = [];
    for (const timer of this.cache.values()) {
      if (timer.workflowId === workflowId) {
        results.push(timer);
      }
    }
    return results.sort((a, b) => a.firesAt - b.firesAt);
  }

  async getByRun(runId: string): Promise<TimerEntry[]> {
    await this.ensureInitialized();

    const results: TimerEntry[] = [];
    for (const timer of this.cache.values()) {
      if (timer.runId === runId) {
        results.push(timer);
      }
    }
    return results.sort((a, b) => a.firesAt - b.firesAt);
  }

  async getPending(): Promise<TimerEntry[]> {
    await this.ensureInitialized();

    const results: TimerEntry[] = [];
    for (const timer of this.cache.values()) {
      if (!timer.cancelled && !timer.fired) {
        results.push(timer);
      }
    }
    return results.sort((a, b) => a.firesAt - b.firesAt);
  }

  async getOverdue(): Promise<TimerEntry[]> {
    await this.ensureInitialized();

    const now = Date.now();
    const results: TimerEntry[] = [];
    for (const timer of this.cache.values()) {
      if (!timer.cancelled && !timer.fired && timer.firesAt <= now) {
        results.push(timer);
      }
    }
    return results.sort((a, b) => a.firesAt - b.firesAt);
  }

  async markFired(id: string): Promise<void> {
    await this.ensureInitialized();

    const timer = this.cache.get(id);
    if (timer && !timer.cancelled && !timer.fired) {
      timer.fired = true;
      await this.persist();

      for (const callback of this.fireCallbacks) {
        try {
          callback(timer);
        } catch {
        }
      }
    }
  }

  async cleanup(olderThan: number): Promise<number> {
    await this.ensureInitialized();

    const cutoff = Date.now() - olderThan;
    let count = 0;

    for (const [id, timer] of this.cache) {
      if ((timer.fired || timer.cancelled) && timer.createdAt < cutoff) {
        this.cache.delete(id);
        count++;
      }
    }

    if (count > 0) {
      await this.persist();
    }

    return count;
  }

  onFire(callback: FireCallback): () => void {
    this.fireCallbacks.push(callback);
    return () => {
      const idx = this.fireCallbacks.indexOf(callback);
      if (idx !== -1) {
        this.fireCallbacks.splice(idx, 1);
      }
    };
  }

  async list(options: TimerQueryOptions = {}): Promise<TimerEntry[]> {
    await this.ensureInitialized();

    let results: TimerEntry[] = [];

    for (const timer of this.cache.values()) {
      if (options.workflowId && timer.workflowId !== options.workflowId) continue;
      if (options.runId && timer.runId !== options.runId) continue;
      if (options.nodeId && timer.nodeId !== options.nodeId) continue;
      if (options.firesBefore !== undefined && timer.firesAt > options.firesBefore) continue;
      if (options.firesAfter !== undefined && timer.firesAt < options.firesAfter) continue;

      if (options.status) {
        if (options.status === 'pending' && (timer.fired || timer.cancelled)) continue;
        if (options.status === 'fired' && !timer.fired) continue;
        if (options.status === 'cancelled' && !timer.cancelled) continue;
      }

      results.push(timer);
    }

    results.sort((a, b) => a.firesAt - b.firesAt);

    if (options.offset) {
      results = results.slice(options.offset);
    }
    if (options.limit) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  async count(options: TimerQueryOptions = {}): Promise<number> {
    const list = await this.list(options);
    return list.length;
  }

  async clear(): Promise<void> {
    await this.ensureInitialized();
    this.cache.clear();
    await this.persist();
  }
}

/**
 * Create an in-memory timer store
 */
export function createInMemoryTimerStore(): InMemoryTimerStore {
  return new InMemoryTimerStore();
}

/**
 * Create a file-based timer store
 */
export function createFileTimerStore(directory: string): FileTimerStore {
  return new FileTimerStore(directory);
}
