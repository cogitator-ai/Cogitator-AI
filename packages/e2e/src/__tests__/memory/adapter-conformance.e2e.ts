import { randomUUID } from 'node:crypto';
import { describe, it } from 'vitest';
import { MongoDBAdapter, PostgresAdapter, RedisAdapter } from '@cogitator-ai/memory';
import { memoryAdapterConformanceCases } from '@cogitator-ai/test-utils';
import type { MemoryAdapter } from '@cogitator-ai/types';

async function connected(adapter: MemoryAdapter): Promise<MemoryAdapter> {
  const result = await adapter.connect();
  if (!result.success) throw new Error(result.error);
  return adapter;
}

const postgresUrl = process.env.TEST_POSTGRES_URL;
const redisUrl =
  process.env.TEST_REDIS === 'true'
    ? (process.env.TEST_REDIS_URL ?? 'redis://localhost:6379')
    : undefined;
const mongoUrl = process.env.TEST_MONGODB_URL;

const targets: Array<[string, string | undefined, () => Promise<MemoryAdapter>]> = [
  [
    'PostgresAdapter',
    postgresUrl,
    () =>
      connected(
        new PostgresAdapter({
          provider: 'postgres',
          connectionString: postgresUrl!,
          schema: `conformance_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
        })
      ),
  ],
  [
    'RedisAdapter',
    redisUrl,
    () =>
      connected(
        new RedisAdapter({
          provider: 'redis',
          url: redisUrl!,
          keyPrefix: `conformance:${randomUUID()}:`,
        })
      ),
  ],
  [
    'MongoDBAdapter',
    mongoUrl,
    () =>
      connected(
        new MongoDBAdapter({
          provider: 'mongodb',
          uri: mongoUrl!,
          database: `conformance_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
        })
      ),
  ],
];

for (const [name, url, create] of targets) {
  (url ? describe : describe.skip)(`Memory: ${name} conformance`, () => {
    for (const c of memoryAdapterConformanceCases({
      create,
      release: async (adapter) => {
        await adapter.disconnect();
      },
    })) {
      (c.skip ? it.skip : it)(c.name, { timeout: 30_000 }, () => c.run());
    }
  });
}
