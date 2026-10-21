import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import { MongoDBAdapter, PostgresAdapter, RedisAdapter } from '@cogitator-ai/memory';
import type { MemoryAdapter } from '@cogitator-ai/types';

const postgresUrl = process.env.TEST_POSTGRES_URL;
const redisUrl =
  process.env.TEST_REDIS === 'true'
    ? (process.env.TEST_REDIS_URL ?? 'redis://localhost:6379')
    : undefined;
const mongoUrl = process.env.TEST_MONGODB_URL;
const tag = randomUUID().replace(/-/g, '').slice(0, 8);

interface StoredDocument {
  _id: string;
  [field: string]: unknown;
}

async function connected<T extends MemoryAdapter>(adapter: T): Promise<T> {
  const result = await adapter.connect();
  if (!result.success) throw new Error(result.error);
  return adapter;
}

/** An entry as stored before trees: no parent, no type, no format version */
interface LegacyEntry {
  id: string;
  at: Date;
  seq?: number;
  /** Stored as the entry's last field */
  metadata?: Record<string, unknown>;
}

/** The ids and parents on the path to the thread's active leaf */
async function pathOf(
  adapter: MemoryAdapter,
  threadId: string
): Promise<[string, string | null][]> {
  const path = await adapter.getPath!({ threadId });
  if (!path.success) throw new Error(path.error);
  return path.data.map((entry) => [entry.id, entry.parentId ?? null]);
}

/**
 * Checks out the root of a chained legacy thread of three entries and deletes it: the thread
 * keeps no active leaf, and nothing chains the rest again.
 */
async function expectChainedOnce(
  adapter: MemoryAdapter,
  threadId: string,
  [root, middle, last]: string[]
): Promise<void> {
  expect(await pathOf(adapter, threadId)).toEqual([
    [root, null],
    [middle, root],
    [last, middle],
  ]);
  const checkedOut = await adapter.checkout!(threadId, root!);
  expect(checkedOut.success && checkedOut.data.activeLeafId).toBe(root);
  expect((await adapter.deleteEntry(root!)).success).toBe(true);

  const thread = await adapter.getThread(threadId);
  expect(thread.success && thread.data?.activeLeafId).toBeUndefined();
  expect(await pathOf(adapter, threadId)).toEqual([]);
  const branch = await adapter.getPath!({ threadId, leafId: last! });
  expect(branch.success && branch.data.map((entry) => [entry.id, entry.parentId])).toEqual([
    [middle, null],
    [last, middle],
  ]);
}

/** What every adapter must show for a thread of entries e1, e2, e3 written before trees */
async function expectChained(adapter: MemoryAdapter, threadId: string): Promise<void> {
  const thread = await adapter.getThread(threadId);
  expect(thread.success && thread.data?.activeLeafId).toBe('e3');
  const path = await adapter.getPath!({ threadId });
  expect(path.success && path.data.map((entry) => [entry.id, entry.parentId])).toEqual([
    ['e1', null],
    ['e2', 'e1'],
    ['e3', 'e2'],
  ]);
  const added = await adapter.addEntry({
    threadId,
    message: { role: 'user', content: 'e4' },
    tokenCount: 1,
  });
  expect(added.success && added.data.parentId).toBe('e3');
}

(postgresUrl ? describe : describe.skip)('Memory: Postgres entries written before trees', () => {
  const schema = `tree_${tag}`;
  let adapter: PostgresAdapter | undefined;

  afterAll(async () => {
    await adapter?.disconnect();
    const client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it('chains them when the schema moves to trees', async () => {
    const config = { provider: 'postgres' as const, connectionString: postgresUrl!, schema };
    const first = await connected(new PostgresAdapter(config));
    await first.createThread('agent', {}, 't');
    await first.disconnect();
    const client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    for (const [i, id] of ['e1', 'e2', 'e3'].entries()) {
      await client.query(
        `INSERT INTO ${schema}.entries (id, thread_id, message, token_count, created_at)
         VALUES ($1, 't', $2::jsonb, 1, $3)`,
        [id, JSON.stringify({ role: 'user', content: id }), new Date(i * 1000)]
      );
    }
    await client.query(
      `UPDATE ${schema}.cogitator_schema_migrations SET version = 1 WHERE component = 'memory'`
    );
    await client.end();

    adapter = await connected(new PostgresAdapter(config));
    await expectChained(adapter, 't');
  });
});

(redisUrl ? describe : describe.skip)('Memory: Redis entries written before trees', () => {
  const keyPrefix = `tree:${tag}:`;
  let adapter: RedisAdapter | undefined;

  afterAll(async () => {
    await adapter?.disconnect();
    const redis = new Redis(redisUrl!);
    const keys = await redis.keys(`${keyPrefix}*`);
    if (keys.length > 0) await redis.del(...keys);
    redis.disconnect();
  });

  /** Stores a thread and its entries as the adapter wrote them before trees */
  async function seed(threadId: string, entries: LegacyEntry[]): Promise<void> {
    const redis = new Redis(redisUrl!);
    const at = new Date(0).toISOString();
    await redis.set(
      `${keyPrefix}thread:${threadId}`,
      JSON.stringify({ id: threadId, agentId: 'agent', metadata: {}, createdAt: at, updatedAt: at })
    );
    for (const { id, at: createdAt, seq, metadata } of entries) {
      const key = `${keyPrefix}entry:${id}`;
      await redis.set(
        key,
        JSON.stringify({
          id,
          threadId,
          message: { role: 'user', content: id },
          tokenCount: 1,
          createdAt,
          ...(seq !== undefined && { seq }),
          ...(metadata && { metadata }),
        })
      );
      await redis.zadd(`${keyPrefix}thread:entries:${threadId}`, createdAt.getTime(), key);
    }
    redis.disconnect();
  }

  it('chains them the first time the thread is read', async () => {
    await seed('t', [
      { id: 'e1', at: new Date(0), seq: 1 },
      { id: 'e2', at: new Date(1000), seq: 2 },
      { id: 'e3', at: new Date(2000), seq: 3 },
    ]);

    adapter = await connected(new RedisAdapter({ provider: 'redis', url: redisUrl!, keyPrefix }));
    await expectChained(adapter, 't');
  });

  it('chains entries created at one time in the order they were added', async () => {
    const at = new Date(5000);
    await seed('tied', [
      { id: 'k3', at, seq: 11 },
      { id: 'k1', at, seq: 12 },
      { id: 'k2', at, seq: 13 },
    ]);
    adapter ??= await connected(new RedisAdapter({ provider: 'redis', url: redisUrl!, keyPrefix }));

    expect(await pathOf(adapter, 'tied')).toEqual([
      ['k3', null],
      ['k1', 'k3'],
      ['k2', 'k1'],
    ]);
  });

  it('chains a thread once, so a leaf deleted later stays gone', async () => {
    await seed('once', [
      { id: 'o1', at: new Date(0), seq: 21 },
      { id: 'o2', at: new Date(1000), seq: 22 },
      { id: 'o3', at: new Date(2000), seq: 23 },
    ]);
    adapter ??= await connected(new RedisAdapter({ provider: 'redis', url: redisUrl!, keyPrefix }));
    await expectChainedOnce(adapter, 'once', ['o1', 'o2', 'o3']);
  });

  it('chains an entry whose content holds a formatVersion or a parentId of its own', async () => {
    await seed('nested', [
      { id: 'n1', at: new Date(0), seq: 31, metadata: { formatVersion: 7 } },
      {
        id: 'n2',
        at: new Date(1000),
        seq: 32,
        metadata: { note: 'tool output', formatVersion: 3, parentId: 'elsewhere' },
      },
      { id: 'n3', at: new Date(2000), seq: 33 },
    ]);
    adapter ??= await connected(new RedisAdapter({ provider: 'redis', url: redisUrl!, keyPrefix }));

    expect(await pathOf(adapter, 'nested')).toEqual([
      ['n1', null],
      ['n2', 'n1'],
      ['n3', 'n2'],
    ]);
    const n2 = await adapter.getEntry('n2');
    expect(n2.success && n2.data?.metadata).toEqual({
      note: 'tool output',
      formatVersion: 3,
      parentId: 'elsewhere',
    });
    expect(n2.success && n2.data?.formatVersion).toBe(1);
  });
});

(mongoUrl ? describe : describe.skip)('Memory: MongoDB entries written before trees', () => {
  const database = `tree_${tag}`;
  let adapter: MongoDBAdapter | undefined;

  afterAll(async () => {
    await adapter?.disconnect();
    const client = new MongoClient(mongoUrl!);
    await client.connect();
    await client.db(database).dropDatabase();
    await client.close();
  });

  /** Stores a thread and its entries as the adapter wrote them before trees, in this order */
  async function seed(threadId: string, entries: LegacyEntry[]): Promise<void> {
    const client = new MongoClient(mongoUrl!);
    await client.connect();
    const db = client.db(database);
    const at = new Date(0);
    await db
      .collection<StoredDocument>('memory_threads')
      .insertOne({ _id: threadId, agentId: 'agent', metadata: {}, createdAt: at, updatedAt: at });
    for (const { id, at: createdAt, seq } of entries) {
      await db.collection<StoredDocument>('memory_entries').insertOne({
        _id: id,
        threadId,
        message: { role: 'user', content: id },
        tokenCount: 1,
        createdAt,
        ...(seq !== undefined && { seq }),
      });
    }
    await client.close();
  }

  const open = async () =>
    connected(new MongoDBAdapter({ provider: 'mongodb', uri: mongoUrl!, database }));

  it('chains them the first time the thread is read', async () => {
    await seed('t', [
      { id: 'e1', at: new Date(0), seq: 1 },
      { id: 'e2', at: new Date(1000), seq: 2 },
      { id: 'e3', at: new Date(2000), seq: 3 },
    ]);

    adapter = await open();
    await expectChained(adapter, 't');
  });

  it('chains entries created at one time in the order they were added', async () => {
    const at = new Date(5000);
    await seed('tied', [
      { id: 'k3', at },
      { id: 'k1', at },
      { id: 'k2', at },
    ]);
    adapter ??= await open();

    const order = await adapter.getEntries({ threadId: 'tied' });
    expect(order.success && order.data.map((entry) => entry.id)).toEqual(['k3', 'k1', 'k2']);
    expect(await pathOf(adapter, 'tied')).toEqual([
      ['k3', null],
      ['k1', 'k3'],
      ['k2', 'k1'],
    ]);
  });

  it('chains a thread once, so a leaf deleted later stays gone', async () => {
    await seed('once', [
      { id: 'o1', at: new Date(0), seq: 21 },
      { id: 'o2', at: new Date(1000), seq: 22 },
      { id: 'o3', at: new Date(2000), seq: 23 },
    ]);
    adapter ??= await open();
    await expectChainedOnce(adapter, 'once', ['o1', 'o2', 'o3']);
  });
});
