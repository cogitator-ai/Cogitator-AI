import { describe, it, expect, vi, beforeEach } from 'vitest';

const redisState = vi.hoisted(() => ({
  data: new Map<string, string>(),
  setCalls: [] as unknown[][],
  constructed: [] as unknown[],
}));

const pgState = vi.hoisted(() => ({
  queries: [] as string[],
  values: [] as unknown[][],
  selectRows: [] as unknown[],
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
    async query(text: string, values: unknown[] = []) {
      pgState.queries.push(text);
      pgState.values.push(values);
      if (pgState.failOn && text.includes(pgState.failOn)) {
        throw new Error('permission denied');
      }
      const rows = text.trimStart().startsWith('SELECT') ? pgState.selectRows : [];
      return { rows, rowCount: rows.length };
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
  pgState.values.length = 0;
  pgState.selectRows = [];
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

    const { threads } = await storage.listThreads();
    expect(threads.map((t) => t.thread.id).sort()).toEqual(['t1', 't2', 't3']);
  });
});

function storedThread(id: string, createdAt: number, owner?: string): StoredThread {
  return {
    thread: { id, object: 'thread', created_at: createdAt, metadata: {} },
    messages: [],
    ...(owner !== undefined && { owner }),
  };
}

describe.each([
  ['InMemoryThreadStorage', async (): Promise<ThreadStorage> => new InMemoryThreadStorage()],
  [
    'RedisThreadStorage',
    async (): Promise<ThreadStorage> => {
      const storage = new RedisThreadStorage();
      await storage.connect();
      return storage;
    },
  ],
])('%s.listThreads', (_name, create) => {
  async function seeded() {
    const storage = await create();
    const threads = [
      storedThread('t_a', 100, 'key-a'),
      storedThread('t_b', 200, 'key-b'),
      storedThread('t_c', 200, 'key-a'),
      storedThread('t_d', 300),
      storedThread('t_e', 400, 'key-a'),
    ];
    for (const thread of threads) await storage.saveThread(thread.thread.id, thread);
    return storage;
  }

  it('pages newest first by creation time, then id, with a cursor', async () => {
    const storage = await seeded();

    const first = await storage.listThreads({ limit: 2 });
    const second = await storage.listThreads({ limit: 2, cursor: first.nextCursor });
    const last = await storage.listThreads({ limit: 2, cursor: second.nextCursor });

    expect(first.threads.map((t) => t.thread.id)).toEqual(['t_e', 't_d']);
    expect(second.threads.map((t) => t.thread.id)).toEqual(['t_c', 't_b']);
    expect(last.threads.map((t) => t.thread.id)).toEqual(['t_a']);
    expect(last.nextCursor).toBeUndefined();
  });

  it('lists oldest first with order asc', async () => {
    const storage = await seeded();

    const page = await storage.listThreads({ order: 'asc', limit: 3 });

    expect(page.threads.map((t) => t.thread.id)).toEqual(['t_a', 't_b', 't_c']);
    expect(page.nextCursor).toBeDefined();
  });

  it('filters by owner, and lists the threads without one for owner null', async () => {
    const storage = await seeded();

    const owned = await storage.listThreads({ owner: 'key-a', limit: 2 });
    const rest = await storage.listThreads({ owner: 'key-a', cursor: owned.nextCursor });
    const unowned = await storage.listThreads({ owner: null });

    expect(owned.threads.map((t) => t.thread.id)).toEqual(['t_e', 't_c']);
    expect(rest.threads.map((t) => t.thread.id)).toEqual(['t_a']);
    expect(unowned.threads.map((t) => t.thread.id)).toEqual(['t_d']);
  });

  it('breaks creation time ties by id in code unit order', async () => {
    const storage = await create();
    for (const id of ['t_a', 't_B', 't_Z', 't_b']) {
      await storage.saveThread(id, storedThread(id, 500));
    }

    const page = await storage.listThreads({ order: 'asc' });

    expect(page.threads.map((t) => t.thread.id)).toEqual(['t_B', 't_Z', 't_a', 't_b']);
  });

  it('refuses a limit out of range and a cursor it did not hand out', async () => {
    const storage = await seeded();

    await expect(storage.listThreads({ limit: 0 })).rejects.toThrow(RangeError);
    await expect(storage.listThreads({ limit: 501 })).rejects.toThrow(RangeError);
    await expect(storage.listThreads({ cursor: 'not-a-cursor' })).rejects.toThrow(TypeError);
  });
});

describe('PostgresThreadStorage.listThreads', () => {
  async function connected() {
    const storage = new PostgresThreadStorage({ connectionString: 'postgres://x' });
    await storage.connect();
    pgState.queries.length = 0;
    pgState.values.length = 0;
    return storage;
  }

  it('indexes threads by owner, creation time and id', async () => {
    const storage = new PostgresThreadStorage({ connectionString: 'postgres://x' });
    await storage.connect();

    const index = pgState.queries.find((q) => q.includes('idx_openai_compat_data_thread_owner'));
    expect(index).toContain("(data->>'owner')");
    expect(index).toContain("((data->'thread'->>'created_at')::bigint), (id COLLATE \"C\"))");
    expect(index).toContain("WHERE type = 'thread'");
  });

  it('filters, orders and limits in SQL and fetches one extra row to tell a next page', async () => {
    const storage = await connected();
    pgState.selectRows = [
      { data: storedThread('t_e', 400, 'key-a') },
      { data: storedThread('t_c', 200, 'key-a') },
      { data: storedThread('t_a', 100, 'key-a') },
    ];

    const page = await storage.listThreads({ owner: 'key-a', limit: 2 });

    expect(page.threads.map((t) => t.thread.id)).toEqual(['t_e', 't_c']);
    expect(page.nextCursor).toBeDefined();
    expect(pgState.queries[0]).toContain("(data->>'owner') = $1");
    expect(pgState.queries[0]).toContain(
      "ORDER BY ((data->'thread'->>'created_at')::bigint) DESC, (id COLLATE \"C\") DESC"
    );
    expect(pgState.queries[0]).toContain('LIMIT $2');
    expect(pgState.values[0]).toEqual(['key-a', 3]);

    pgState.selectRows = [{ data: storedThread('t_a', 100, 'key-a') }];
    const next = await storage.listThreads({ owner: 'key-a', limit: 2, cursor: page.nextCursor });

    expect(next.threads.map((t) => t.thread.id)).toEqual(['t_a']);
    expect(next.nextCursor).toBeUndefined();
    expect(pgState.queries[1]).toContain(
      "(((data->'thread'->>'created_at')::bigint), (id COLLATE \"C\")) < ($2::bigint, $3::text)"
    );
    expect(pgState.values[1]).toEqual(['key-a', 200, 't_c', 3]);
  });

  it('lists threads without an owner in ascending order', async () => {
    const storage = await connected();

    await storage.listThreads({ owner: null, order: 'asc' });

    expect(pgState.queries[0]).toContain("(data->>'owner') IS NULL");
    expect(pgState.queries[0]).toContain('ASC, (id COLLATE "C") ASC');
    expect(pgState.values[0]).toEqual([51]);
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
