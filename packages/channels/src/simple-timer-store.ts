import type { TimerEntry, TimerStore } from '@cogitator-ai/types';

let counter = 0;
function nextId(): string {
  return `timer_${++counter}_${Date.now()}`;
}

export class SimpleTimerStore implements TimerStore {
  private timers = new Map<string, TimerEntry>();
  private callbacks: ((entry: TimerEntry) => void)[] = [];

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
    return id;
  }

  async cancel(id: string): Promise<void> {
    const entry = this.timers.get(id);
    if (entry) entry.cancelled = true;
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
    return count;
  }

  onFire(callback: (entry: TimerEntry) => void): () => void {
    this.callbacks.push(callback);
    return () => {
      const idx = this.callbacks.indexOf(callback);
      if (idx >= 0) this.callbacks.splice(idx, 1);
    };
  }
}
