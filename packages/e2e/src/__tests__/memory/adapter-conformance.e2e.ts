import { randomUUID } from 'node:crypto';
import { afterAll, describe, it } from 'vitest';
import pg from 'pg';
import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import { MongoDBAdapter, PostgresAdapter, RedisAdapter } from '@cogitator-ai/memory';
import { memoryAdapterConformanceCases } from '@cogitator-ai/test-utils';
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

interface Target {
  name: string;
  url: string | undefined;
  create(): Promise<MemoryAdapter>;
  /** Removes everything the cases stored */
  cleanUp(): Promise<void>;
}

const targets: Target[] = [
  {
    name: 'PostgresAdapter',
    url: postgresUrl,
    create: () =>
      connected(
        new PostgresAdapter({
          provider: 'postgres',
          connectionString: postgresUrl!,
          schema: `conformance_${tag}`,
        })
      ),
    async cleanUp() {
      const client = new pg.Client({ connectionString: postgresUrl });
      await client.connect();
      await client.query(`DROP SCHEMA IF EXISTS conformance_${tag} CASCADE`);
      await client.end();
    },
  },
  {
    name: 'RedisAdapter',
    url: redisUrl,
    create: () =>
      connected(
        new RedisAdapter({ provider: 'redis', url: redisUrl!, keyPrefix: `conformance:${tag}:` })
      ),
    async cleanUp() {
      const redis = new Redis(redisUrl!);
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(
          cursor,
          'MATCH',
          `conformance:${tag}:*`,
          'COUNT',
          500
        );
        if (keys.length > 0) await redis.del(...keys);
        cursor = next;
      } while (cursor !== '0');
      redis.disconnect();
    },
  },
  {
    name: 'MongoDBAdapter',
    url: mongoUrl,
    create: () =>
      connected(
        new MongoDBAdapter({ provider: 'mongodb', uri: mongoUrl!, database: `conformance_${tag}` })
      ),
    async cleanUp() {
      const client = new MongoClient(mongoUrl!);
      await client.connect();
      await client.db(`conformance_${tag}`).dropDatabase();
      await client.close();
    },
  },
];

for (const target of targets) {
  (target.url ? describe : describe.skip)(`Memory: ${target.name} conformance`, () => {
    afterAll(() => target.cleanUp());

    for (const c of memoryAdapterConformanceCases({
      create: target.create,
      release: async (adapter) => {
        await adapter.disconnect();
      },
    })) {
      (c.skip ? it.skip : it)(c.name, { timeout: 30_000 }, () => c.run());
    }
  });
}
