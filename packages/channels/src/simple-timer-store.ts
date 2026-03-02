import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TimerEntry, TimerStore } from '@cogitator-ai/types';

let counter = 0;
function nextId(): string {
  return `timer_${++counter}_${Date.now()}`;
}

export interface TimerStoreOptions {
  persistPath?: string;
}

export class SimpleTimerStore implements TimerStore {
  private timers = new Map<string, TimerEntry>();
  private callbacks: ((entry: TimerEntry) => void)[] = [];
  private readonly persistPath: string | null;

  constructor(opts?: TimerStoreOptions) {
    this.persistPath = opts?.persistPath ?? null;
    if (this.persistPath) {
      this.loadFromDisk();
    }
  }

  async schedule(
    entry: Omit<TimerEntry, 'id' | 'cancelled' | 'fired' | 'createdAt'>
  ): Promise<string> {
    const id = nextId();
    const full: TimerEntry = {
      ...entry,
      id,
      cancelled: false,
      fired: false,
      createdAt: Date.now(),
    };
    this.timers.set(id, full);
    this.saveToDisk();
    return id;
  }

  async cancel(id: string): Promise<void> {
    const entry = this.timers.get(id);
    if (entry) {
      entry.cancelled = true;
      this.saveToDisk();
    }
  }

  async get(id: string): Promise<TimerEntry | null> {
    return this.timers.get(id) ?? null;
  }

  async getByWorkflow(workflowId: string): Promise<TimerEntry[]> {
    return [...this.timers.values()].filter((t) => t.workflowId === workflowId);
  }

  async getByRun(runId: string): Promise<TimerEntry[]> {
    return [...this.timers.values()].filter((t) => t.runId === runId);
  }

  async getPending(): Promise<TimerEntry[]> {
    return [...this.timers.values()].filter((t) => !t.cancelled && !t.fired);
  }

  async getOverdue(): Promise<TimerEntry[]> {
    const now = Date.now();
    return [...this.timers.values()].filter((t) => !t.cancelled && !t.fired && t.firesAt <= now);
  }

  async markFired(id: string): Promise<void> {
    const entry = this.timers.get(id);
    if (entry) {
      entry.fired = true;
      this.saveToDisk();
      for (const cb of this.callbacks) cb(entry);
    }
  }

  async cleanup(olderThan: number): Promise<number> {
    let count = 0;
    for (const [id, entry] of this.timers) {
      if ((entry.fired || entry.cancelled) && entry.createdAt < olderThan) {
        this.timers.delete(id);
        count++;
      }
    }
    if (count > 0) this.saveToDisk();
    return count;
  }

  async update(id: string, patch: Partial<TimerEntry>): Promise<void> {
    const entry = this.timers.get(id);
    if (!entry) return;
    Object.assign(entry, patch);
    this.saveToDisk();
  }

  async list(filter?: { enabled?: boolean; type?: string }): Promise<TimerEntry[]> {
    let entries = [...this.timers.values()];
    if (filter?.enabled !== undefined) {
      entries = entries.filter((e) => (e.enabled ?? true) === filter.enabled);
    }
    if (filter?.type) {
      entries = entries.filter((e) => e.type === filter.type);
    }
    return entries;
  }

  onFire(callback: (entry: TimerEntry) => void): () => void {
    this.callbacks.push(callback);
    return () => {
      const idx = this.callbacks.indexOf(callback);
      if (idx >= 0) this.callbacks.splice(idx, 1);
    };
  }

  private saveToDisk(): void {
    if (!this.persistPath) return;
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const data = [...this.timers.values()];
      const tmpPath = join(dir, `.timer-store-${Date.now()}.tmp`);
      writeFileSync(tmpPath, JSON.stringify(data));
      renameSync(tmpPath, this.persistPath);
    } catch {}
  }

  private loadFromDisk(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = readFileSync(this.persistPath, 'utf-8');
      const entries = JSON.parse(raw) as TimerEntry[];
      for (const entry of entries) {
        this.timers.set(entry.id, entry);
        const numPart = /^timer_(\d+)/.exec(entry.id);
        if (numPart) counter = Math.max(counter, Number(numPart[1]));
      }
    } catch {}
  }
}
