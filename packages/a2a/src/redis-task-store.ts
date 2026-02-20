import type { A2ATask, TaskFilter, TaskStore } from './types.js';

export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  keys(pattern: string): Promise<string[]>;
  setex?(key: string, seconds: number, value: string): Promise<void>;
}

export interface RedisTaskStoreConfig {
  client: RedisClientLike;
  keyPrefix?: string;
  ttl?: number;
}

export class RedisTaskStore implements TaskStore {
  private client: RedisClientLike;
  private prefix: string;
  private ttl?: number;

  constructor(config: RedisTaskStoreConfig) {
    this.client = config.client;
    this.prefix = config.keyPrefix ?? 'a2a:task:';
    this.ttl = config.ttl;
  }

  async create(task: A2ATask): Promise<void> {
    const key = this.prefix + task.id;
    const json = JSON.stringify(task);
    if (this.ttl && this.client.setex) {
      await this.client.setex(key, this.ttl, json);
    } else {
      await this.client.set(key, json);
    }
  }

  async get(taskId: string): Promise<A2ATask | null> {
    const data = await this.client.get(this.prefix + taskId);
    if (!data) return null;
    return JSON.parse(data) as A2ATask;
  }

  async update(taskId: string, update: Partial<A2ATask>): Promise<void> {
    const existing = await this.get(taskId);
    if (!existing) return;
    const updated = { ...existing, ...update };
    const key = this.prefix + taskId;
    const json = JSON.stringify(updated);
    if (this.ttl && this.client.setex) {
      await this.client.setex(key, this.ttl, json);
    } else {
      await this.client.set(key, json);
    }
  }

  async list(filter?: TaskFilter): Promise<A2ATask[]> {
    const keys = await this.client.keys(this.prefix + '*');
    if (keys.length === 0) return [];

    const tasks: A2ATask[] = [];
    for (const key of keys) {
      const data = await this.client.get(key);
      if (data) tasks.push(JSON.parse(data) as A2ATask);
    }

    let filtered = tasks;
    if (filter?.contextId) {
      filtered = filtered.filter((t) => t.contextId === filter.contextId);
    }
    if (filter?.state) {
      filtered = filtered.filter((t) => t.status.state === filter.state);
    }

    filtered.sort((a, b) => {
      const ta = new Date(a.status.timestamp).getTime();
      const tb = new Date(b.status.timestamp).getTime();
      return tb - ta;
    });

    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? filtered.length;
    return filtered.slice(offset, offset + limit);
  }

  async delete(taskId: string): Promise<void> {
    await this.client.del(this.prefix + taskId);
  }
}
