import type { A2ATask, TaskFilter, TaskStore } from './types.js';

export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
  setex?(key: string, seconds: number, value: string): Promise<unknown>;
  scan?(cursor: number | string, ...args: string[]): Promise<[string, string[]]>;
  mget?(...keys: string[]): Promise<(string | null)[]>;
  eval?(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

export interface RedisTaskStoreConfig {
  client: RedisClientLike;
  keyPrefix?: string;
  ttl?: number;
}

const ATOMIC_UPDATE_SCRIPT = `
local key = KEYS[1]
local existing = redis.call('GET', key)
if not existing then return 0 end
local task = cjson.decode(existing)
local update = cjson.decode(ARGV[1])
for k, v in pairs(update) do task[k] = v end
local result = cjson.encode(task)
local ttl = tonumber(ARGV[2])
if ttl and ttl > 0 then
  redis.call('SETEX', key, ttl, result)
else
  redis.call('SET', key, result)
end
return 1
`;

export class RedisTaskStore implements TaskStore {
  private client: RedisClientLike;
  private prefix: string;
  private ttl?: number;

  constructor(config: RedisTaskStoreConfig) {
    this.client = config.client;
    this.prefix = config.keyPrefix ?? 'a2a:task:';
    this.ttl = config.ttl;
    if (this.ttl && !this.client.setex) {
      throw new Error('RedisTaskStore: ttl requires client.setex support');
    }
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
    const key = this.prefix + taskId;
    const updateJson = JSON.stringify(update);
    const ttlArg = String(this.ttl ?? 0);

    if (this.client.eval) {
      const result = await this.client.eval(ATOMIC_UPDATE_SCRIPT, 1, key, updateJson, ttlArg);
      if (result === 0) return;
      return;
    }

    const existing = await this.get(taskId);
    if (!existing) return;
    const updated = { ...existing, ...update };
    const json = JSON.stringify(updated);
    if (this.ttl && this.client.setex) {
      await this.client.setex(key, this.ttl, json);
    } else {
      await this.client.set(key, json);
    }
  }

  async list(filter?: TaskFilter): Promise<A2ATask[]> {
    const keys = await this.scanKeys(this.prefix + '*');
    if (keys.length === 0) return [];

    const tasks: A2ATask[] = [];
    if (this.client.mget) {
      const values = await this.client.mget(...keys);
      for (const data of values) {
        if (data) tasks.push(JSON.parse(data) as A2ATask);
      }
    } else {
      const results = await Promise.all(keys.map((key) => this.client.get(key)));
      for (const data of results) {
        if (data) tasks.push(JSON.parse(data) as A2ATask);
      }
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

  private async scanKeys(pattern: string): Promise<string[]> {
    if (this.client.scan) {
      const keys: string[] = [];
      let cursor: string | number = 0;
      do {
        const [nextCursor, batch] = await this.client.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          '100'
        );
        keys.push(...batch);
        cursor = typeof nextCursor === 'string' ? parseInt(nextCursor, 10) : nextCursor;
      } while (cursor !== 0);
      return keys;
    }
    return this.client.keys(pattern);
  }
}
