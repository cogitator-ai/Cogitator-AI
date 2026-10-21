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

async function connected<T extends MemoryAdapter>(adapter: T): Promise<T> {
  const result = await adapter.connect();
  if (!result.success) throw new Error(result.error);
  return adapter;
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

  it('chains them the first time the thread is read', async () => {
    const redis = new Redis(redisUrl!);
    const at = new Date(0).toISOString();
    await redis.set(
      `${keyPrefix}thread:t`,
      JSON.stringify({ id: 't', agentId: 'agent', metadata: {}, createdAt: at, updatedAt: at })
    );
    for (const [i, id] of ['e1', 'e2', 'e3'].entries()) {
      const createdAt = new Date(i * 1000);
      const key = `${keyPrefix}entry:${id}`;
      await redis.set(
        key,
        JSON.stringify({
          id,
          threadId: 't',
          message: { role: 'user', content: id },
          tokenCount: 1,
          createdAt,
          seq: i + 1,
        })
      );
      await redis.zadd(`${keyPrefix}thread:entries:t`, createdAt.getTime(), key);
    }
    redis.disconnect();

    adapter = await connected(new RedisAdapter({ provider: 'redis', url: redisUrl!, keyPrefix }));
    await expectChained(adapter, 't');
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

  it('chains them the first time the thread is read', async () => {
    const client = new MongoClient(mongoUrl!);
    await client.connect();
    const db = client.db(database);
    const at = new Date(0);
    await db
      .collection<{ _id: string }>('memory_threads')
      .insertOne({ _id: 't', agentId: 'agent', metadata: {}, createdAt: at, updatedAt: at });
    await db.collection<{ _id: string }>('memory_entries').insertMany(
      ['e1', 'e2', 'e3'].map((id, i) => ({
        _id: id,
        threadId: 't',
        message: { role: 'user', content: id },
        tokenCount: 1,
        createdAt: new Date(i * 1000),
        seq: i + 1,
      }))
    );
    await client.close();

    adapter = await connected(
      new MongoDBAdapter({ provider: 'mongodb', uri: mongoUrl!, database })
    );
    await expectChained(adapter, 't');
  });
});
