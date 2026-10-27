/**
 * Timer stores of the core: in memory, and a JSON file that several processes share (the CLI
 * changes a schedule while a runtime polls it). The Redis and Postgres stores that claim timers
 * for many workers are in `@cogitator-ai/workflows`
 */

import type { TimerEntry, TimerStore } from '@cogitator-ai/types';
import { nanoid } from 'nanoid';
import { join } from 'node:path';
import { SharedJsonFile } from './json-file';

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

function byFiresAt(a: TimerEntry, b: TimerEntry): number {
  return a.firesAt - b.firesAt;
}

function matchesQuery(timer: TimerEntry, options: TimerQueryOptions): boolean {
  if (options.workflowId && timer.workflowId !== options.workflowId) return false;
  if (options.runId && timer.runId !== options.runId) return false;
  if (options.nodeId && timer.nodeId !== options.nodeId) return false;
  if (options.firesBefore !== undefined && timer.firesAt > options.firesBefore) return false;
  if (options.firesAfter !== undefined && timer.firesAt < options.firesAfter) return false;
  if (options.status === 'pending' && (timer.fired || timer.cancelled)) return false;
  if (options.status === 'fired' && !timer.fired) return false;
  if (options.status === 'cancelled' && !timer.cancelled) return false;
  return true;
}

function page(results: TimerEntry[], options: TimerQueryOptions): TimerEntry[] {
  let paged = results.sort(byFiresAt);
  if (options.offset) paged = paged.slice(options.offset);
  if (options.limit) paged = paged.slice(0, options.limit);
  return paged;
}

function matchesFilter(timer: TimerEntry, filter?: { enabled?: boolean; type?: string }): boolean {
  if (filter?.enabled !== undefined && (timer.enabled ?? true) !== filter.enabled) return false;
  return !filter?.type || timer.type === filter.type;
}

function emit(callbacks: readonly FireCallback[], timer: TimerEntry): void {
  for (const callback of callbacks) {
    try {
      callback(timer);
    } catch {}
  }
}

/**
 * Timers in memory, for one process
 */
export class InMemoryTimerStore implements TimerStore {
  private timers = new Map<string, TimerEntry>();
  private fireCallbacks: FireCallback[] = [];

  async schedule(
    entry: Omit<TimerEntry, 'id' | 'cancelled' | 'fired' | 'createdAt'>
  ): Promise<string> {
    const id = `timer_${nanoid(12)}`;
    this.timers.set(id, { ...entry, id, cancelled: false, fired: false, createdAt: Date.now() });
    return id;
  }

  async get(id: string): Promise<TimerEntry | null> {
    return this.timers.get(id) ?? null;
  }

  async cancel(id: string): Promise<void> {
    const timer = this.timers.get(id);
    if (timer && !timer.cancelled && !timer.fired) timer.cancelled = true;
  }

  async getByWorkflow(workflowId: string): Promise<TimerEntry[]> {
    return [...this.timers.values()].filter((t) => t.workflowId === workflowId).sort(byFiresAt);
  }

  async getByRun(runId: string): Promise<TimerEntry[]> {
    return [...this.timers.values()].filter((t) => t.runId === runId).sort(byFiresAt);
  }

  async getPending(): Promise<TimerEntry[]> {
    return [...this.timers.values()].filter((t) => !t.cancelled && !t.fired).sort(byFiresAt);
  }

  async getOverdue(): Promise<TimerEntry[]> {
    const now = Date.now();
    return [...this.timers.values()]
      .filter((t) => !t.cancelled && !t.fired && t.firesAt <= now)
      .sort(byFiresAt);
  }

  async markFired(id: string): Promise<void> {
    const timer = this.timers.get(id);
    if (timer && !timer.cancelled && !timer.fired) {
      timer.fired = true;
      emit(this.fireCallbacks, timer);
    }
  }

  /** Removes fired and cancelled timers created more than `olderThan` ms ago */
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
      if (idx !== -1) this.fireCallbacks.splice(idx, 1);
    };
  }

  async update(id: string, patch: Partial<TimerEntry>): Promise<void> {
    const timer = this.timers.get(id);
    if (timer) Object.assign(timer, patch, { id });
  }

  async list(filter?: { enabled?: boolean; type?: string }): Promise<TimerEntry[]> {
    return [...this.timers.values()].filter((t) => matchesFilter(t, filter)).sort(byFiresAt);
  }

  async query(options: TimerQueryOptions = {}): Promise<TimerEntry[]> {
    return page(
      [...this.timers.values()].filter((t) => matchesQuery(t, options)),
      options
    );
  }

  async count(options: TimerQueryOptions = {}): Promise<number> {
    return (await this.query(options)).length;
  }

  async clear(): Promise<void> {
    this.timers.clear();
  }
}

function parseTimers(value: unknown): TimerEntry[] {
  if (!Array.isArray(value)) throw new Error('A timer store file holds an array of timers');
  return value as TimerEntry[];
}

/**
 * Timers in `<directory>/timers.json`. Every change locks the file and writes it whole, and a
 * read sees changes other processes made, so the CLI and one runtime can share it. It does not
 * claim timers: two runtimes polling one file both run what is due (routines still start once,
 * through the claims of their store)
 */
export class FileTimerStore implements TimerStore {
  private readonly file: SharedJsonFile<TimerEntry[]>;
  private fireCallbacks: FireCallback[] = [];

  constructor(directory: string) {
    this.file = new SharedJsonFile(join(directory, 'timers.json'), {
      empty: () => [],
      parse: parseTimers,
    });
  }

  /** The file the timers are kept in */
  get path(): string {
    return this.file.path;
  }

  private async all(): Promise<TimerEntry[]> {
    return (await this.file.read()).map((timer) => ({ ...timer }));
  }

  private change<R>(id: string, change: (timer: TimerEntry) => R): Promise<R | undefined> {
    return this.file.update((timers) => {
      const timer = timers.find((candidate) => candidate.id === id);
      return timer ? change(timer) : undefined;
    });
  }

  async schedule(
    entry: Omit<TimerEntry, 'id' | 'cancelled' | 'fired' | 'createdAt'>
  ): Promise<string> {
    const id = `timer_${nanoid(12)}`;
    await this.file.update((timers) => {
      timers.push({ ...entry, id, cancelled: false, fired: false, createdAt: Date.now() });
    });
    return id;
  }

  async get(id: string): Promise<TimerEntry | null> {
    return (await this.all()).find((timer) => timer.id === id) ?? null;
  }

  async cancel(id: string): Promise<void> {
    await this.change(id, (timer) => {
      if (!timer.cancelled && !timer.fired) timer.cancelled = true;
    });
  }

  async getByWorkflow(workflowId: string): Promise<TimerEntry[]> {
    return (await this.all()).filter((t) => t.workflowId === workflowId).sort(byFiresAt);
  }

  async getByRun(runId: string): Promise<TimerEntry[]> {
    return (await this.all()).filter((t) => t.runId === runId).sort(byFiresAt);
  }

  async getPending(): Promise<TimerEntry[]> {
    return (await this.all()).filter((t) => !t.cancelled && !t.fired).sort(byFiresAt);
  }

  async getOverdue(): Promise<TimerEntry[]> {
    const now = Date.now();
    return (await this.all())
      .filter((t) => !t.cancelled && !t.fired && t.firesAt <= now)
      .sort(byFiresAt);
  }

  async markFired(id: string): Promise<void> {
    const fired = await this.change(id, (timer) => {
      if (timer.cancelled || timer.fired) return undefined;
      timer.fired = true;
      return { ...timer };
    });
    if (fired) emit(this.fireCallbacks, fired);
  }

  /** Removes fired and cancelled timers created more than `olderThan` ms ago */
  async cleanup(olderThan: number): Promise<number> {
    const cutoff = Date.now() - olderThan;
    const stale = (await this.all()).some(
      (timer) => (timer.fired || timer.cancelled) && timer.createdAt < cutoff
    );
    if (!stale) return 0;
    return this.file.update((timers) => {
      const kept = timers.filter(
        (timer) => !((timer.fired || timer.cancelled) && timer.createdAt < cutoff)
      );
      const count = timers.length - kept.length;
      timers.splice(0, timers.length, ...kept);
      return count;
    });
  }

  onFire(callback: FireCallback): () => void {
    this.fireCallbacks.push(callback);
    return () => {
      const idx = this.fireCallbacks.indexOf(callback);
      if (idx !== -1) this.fireCallbacks.splice(idx, 1);
    };
  }

  async update(id: string, patch: Partial<TimerEntry>): Promise<void> {
    await this.change(id, (timer) => {
      Object.assign(timer, patch, { id });
    });
  }

  async list(filter?: { enabled?: boolean; type?: string }): Promise<TimerEntry[]> {
    return (await this.all()).filter((t) => matchesFilter(t, filter)).sort(byFiresAt);
  }

  async query(options: TimerQueryOptions = {}): Promise<TimerEntry[]> {
    return page(
      (await this.all()).filter((t) => matchesQuery(t, options)),
      options
    );
  }

  async count(options: TimerQueryOptions = {}): Promise<number> {
    return (await this.query(options)).length;
  }

  async clear(): Promise<void> {
    await this.file.update((timers) => {
      timers.splice(0, timers.length);
    });
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
