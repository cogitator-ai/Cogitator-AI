import type { A2ATask, TaskFilter, TaskStore } from './types.js';
import { isTerminalState } from './types.js';
import { isTaskVisibleTo, taskTime } from './ownership.js';

export interface InMemoryTaskStoreConfig {
  maxSize?: number;
}

export class InMemoryTaskStore implements TaskStore {
  private tasks = new Map<string, A2ATask>();
  private maxSize: number;

  constructor(config?: InMemoryTaskStoreConfig) {
    this.maxSize = config?.maxSize ?? 10_000;
  }

  async create(task: A2ATask): Promise<void> {
    this.tasks.set(task.id, structuredClone(task));
    this.evictIfNeeded();
  }

  async get(taskId: string): Promise<A2ATask | null> {
    const task = this.tasks.get(taskId);
    return task ? structuredClone(task) : null;
  }

  async update(taskId: string, update: Partial<A2ATask>): Promise<void> {
    const existing = this.tasks.get(taskId);
    if (!existing) return;
    this.tasks.set(taskId, structuredClone({ ...existing, ...update }));
  }

  async list(filter?: TaskFilter): Promise<A2ATask[]> {
    let tasks = Array.from(this.tasks.values());

    if (filter?.contextId) {
      tasks = tasks.filter((t) => t.contextId === filter.contextId);
    }
    if (filter?.visibleTo !== undefined) {
      const userId = filter.visibleTo;
      tasks = tasks.filter((t) => isTaskVisibleTo(t, userId));
    }
    if (filter?.state) {
      tasks = tasks.filter((t) => t.status.state === filter.state);
    }

    tasks.sort((a, b) => {
      const ta = taskTime(a);
      const tb = taskTime(b);
      return tb - ta;
    });

    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? tasks.length;
    tasks = tasks.slice(offset, offset + limit);

    return tasks.map((t) => structuredClone(t));
  }

  async delete(taskId: string): Promise<void> {
    this.tasks.delete(taskId);
  }

  /**
   * Evict the oldest finished task; fall back to the oldest task overall only
   * when every stored task is still active.
   */
  private evictIfNeeded(): void {
    while (this.tasks.size > this.maxSize) {
      let oldestFinished: { id: string; time: number } | null = null;
      let oldestAny: { id: string; time: number } | null = null;
      for (const [id, task] of this.tasks) {
        const time = taskTime(task);
        if (!oldestAny || time < oldestAny.time) oldestAny = { id, time };
        if (isTerminalState(task.status.state) && (!oldestFinished || time < oldestFinished.time)) {
          oldestFinished = { id, time };
        }
      }
      const victim = oldestFinished ?? oldestAny;
      if (!victim) return;
      this.tasks.delete(victim.id);
    }
  }
}
