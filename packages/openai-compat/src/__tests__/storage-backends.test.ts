import { describe, it, expect, vi, beforeEach } from 'vitest';

const redisState = vi.hoisted(() => ({
  data: new Map<string, string>(),
  setCalls: [] as unknown[][],
  constructed: [] as unknown[],
}));

const pgState = vi.hoisted(() => ({
  queries: [] as string[],
  failOn: null as string | null,
  ended: 0,
}));

vi.mock('ioredis', () => {
  class Redis {
    constructor(options: unknown) {
      redisState.constructed.push(options);
    }
    async get(key: string) {
      return redisState.data.get(key) ?? null;
    }
    async set(key: string, value: string, ...args: unknown[]) {
      redisState.setCalls.push([key, ...args]);
      redisState.data.set(key, value);
      return 'OK';
    }
    async del(key: string) {
      return redisState.data.delete(key) ? 1 : 0;
    }
    async scan(cursor: string, _match: string, pattern: string) {
      const prefix = pattern.replace(/\*$/, '');
      const keys = [...redisState.data.keys()].filter((k) => k.startsWith(prefix));
      return cursor === '0' ? ['7', keys.slice(0, 1)] : ['0', keys.slice(1)];
    }
    async mget(...keys: string[]) {
      return keys.map((k) => redisState.data.get(k) ?? null);
    }
    async quit() {
      return 'OK';
    }
  }
  return { Redis, default: Redis };
});

vi.mock('pg', () => {
  class Pool {
    async query(text: string) {
      pgState.queries.push(text);
      if (pgState.failOn && text.includes(pgState.failOn)) {
        throw new Error('permission denied');
      }
      return { rows: [], rowCount: 0 };
    }
    async end() {
      pgState.ended++;
    }
  }
  return { Pool, default: { Pool } };
});

const { RedisThreadStorage, PostgresThreadStorage, InMemoryThreadStorage } =
  await import('../client/storage');
const { ThreadManager } = await import('../client/thread-manager');
type StoredThread = import('../client/thread-manager').StoredThread;
type ThreadStorage = import('../client/storage').ThreadStorage;

beforeEach(() => {
  redisState.data.clear();
  redisState.setCalls.length = 0;
  redisState.constructed.length = 0;
  pgState.queries.length = 0;
  pgState.failOn = null;
  pgState.ended = 0;
});

describe('RedisThreadStorage (ESM loading)', () => {
  it('connects through a dynamic import of ioredis', async () => {
    const storage = new RedisThreadStorage({ url: 'redis://cache:6379' });
    await storage.connect();
    expect(redisState.constructed).toEqual(['redis://cache:6379']);
  });

  it('writes with EX when ttl > 0 and without expiry when ttl is 0', async () => {
    const expiring = new RedisThreadStorage({ ttl: 60 });
    await expiring.connect();
    await expiring.saveAssistant('a1', {
      id: 'a1',
      name: null,
      model: 'm',
      instructions: null,
      tools: [],
      metadata: {},
      created_at: 1,
    });

    const persistent = new RedisThreadStorage({ ttl: 0 });
    await persistent.connect();
    await persistent.saveAssistant('a2', {
      id: 'a2',
      name: null,
      model: 'm',
      instructions: null,
      tools: [],
      metadata: {},
      created_at: 1,
    });

    expect(redisState.setCalls[0]).toEqual(['cogitator:openai:assistant:a1', 'EX', 60]);
    expect(redisState.setCalls[1]).toEqual(['cogitator:openai:assistant:a2']);
  });

  it('lists entries with SCAN + MGET across cursor pages', async () => {
    const storage = new RedisThreadStorage();
    await storage.connect();
    for (const id of ['t1', 't2', 't3']) {
      await storage.saveThread(id, {
        thread: { id, object: 'thread', created_at: 1, metadata: {} },
        messages: [],
      });
    }

    const threads = await storage.listThreads();
    expect(threads.map((t) => t.thread.id).sort()).toEqual(['t1', 't2', 't3']);
  });
});

describe('PostgresThreadStorage (ESM loading)', () => {
  it('connects through a dynamic import of pg and creates the table', async () => {
    const storage = new PostgresThreadStorage({ connectionString: 'postgres://x' });
    await storage.connect();
    expect(pgState.queries[0]).toContain('CREATE TABLE IF NOT EXISTS public.openai_compat_data');
  });

  it('releases the pool when schema creation fails', async () => {
    pgState.failOn = 'CREATE INDEX';
    const storage = new PostgresThreadStorage({ connectionString: 'postgres://x' });

    await expect(storage.connect()).rejects.toThrow('permission denied');
    expect(pgState.ended).toBe(1);
    await expect(storage.loadThread('t')).rejects.toThrow('not connected');
  });
});

class CloningStorage extends InMemoryThreadStorage {
  async loadThread(id: string): Promise<StoredThread | null> {
    const thread = await super.loadThread(id);
    return thread ? structuredClone(thread) : null;
  }
  async saveThread(id: string, thread: StoredThread): Promise<void> {
    await super.saveThread(id, structuredClone(thread));
  }
}

describe('ThreadManager with shared remote-like storage', () => {
  it('does not serve stale threads to another instance', async () => {
    const storage: ThreadStorage = new CloningStorage();
    const instanceA = new ThreadManager(storage);
    const instanceB = new ThreadManager(storage);

    const thread = await instanceA.createThread();
    await instanceB.getThread(thread.id);
    await instanceA.addMessage(thread.id, { role: 'user', content: 'from A' });

    const seenByB = await instanceB.listMessages(thread.id);
    expect(seenByB).toHaveLength(1);

    await instanceA.deleteThread(thread.id);
    expect(await instanceB.getThread(thread.id)).toBeUndefined();
  });

  it('serializes concurrent writes to one thread (no lost updates)', async () => {
    const manager = new ThreadManager(new CloningStorage());
    const thread = await manager.createThread();

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        manager.addMessage(thread.id, { role: 'user', content: `m${i}` })
      )
    );

    expect(await manager.listMessages(thread.id, { order: 'asc' })).toHaveLength(10);
  });

  it('lists messages newest-first even within the same second', async () => {
    const manager = new ThreadManager();
    const thread = await manager.createThread();
    await manager.addMessage(thread.id, { role: 'user', content: 'first' });
    await manager.addAssistantMessage(thread.id, 'second', 'asst', 'run');

    const desc = await manager.listMessages(thread.id);
    expect(desc.map((m) => m.role)).toEqual(['assistant', 'user']);
  });

  it('ignores undefined fields when updating assistants', async () => {
    const manager = new ThreadManager();
    const assistant = await manager.createAssistant({ model: 'm', name: 'keep' });

    const updated = await manager.updateAssistant(assistant.id, {
      name: undefined,
      instructions: 'new',
    });

    expect(updated?.name).toBe('keep');
    expect(updated?.instructions).toBe('new');
  });

  it('inlines uploaded image files as base64 for the LLM', async () => {
    const manager = new ThreadManager();
    const thread = await manager.createThread();
    const file = await manager.addFile(Buffer.from('png-bytes'), 'chart.png', 'vision');
    await manager.addMessage(thread.id, {
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image_file', image_file: { file_id: file.id } },
      ],
    });

    const [message] = await manager.getMessagesForLLM(thread.id);
    expect(message.images).toEqual([
      { data: Buffer.from('png-bytes').toString('base64'), mimeType: 'image/png' },
    ]);
  });
});

describe('OpenAIAdapter storage option', () => {
  it('persists threads in the provided storage', async () => {
    const { OpenAIAdapter } = await import('../client/openai-adapter');
    const storage = new CloningStorage();
    const adapter = new OpenAIAdapter({} as ConstructorParameters<typeof OpenAIAdapter>[0], {
      storage,
    });

    const thread = await adapter.createThread({ team: 'core' });

    expect((await storage.loadThread(thread.id))?.thread.metadata).toEqual({ team: 'core' });
  });
});
