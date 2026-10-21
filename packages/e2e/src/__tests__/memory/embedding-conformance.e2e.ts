import { randomUUID } from 'node:crypto';
import { afterAll, describe, it } from 'vitest';
import pg from 'pg';
import { PostgresAdapter, QdrantAdapter } from '@cogitator-ai/memory';
import { embeddingAdapterConformanceCases } from '@cogitator-ai/test-utils';
import type { EmbeddingAdapter, MemoryResult } from '@cogitator-ai/types';

const DIMENSIONS = 8;
const postgresUrl = process.env.TEST_POSTGRES_URL;
const qdrantUrl = process.env.TEST_QDRANT_URL;

const tag = randomUUID().replace(/-/g, '').slice(0, 8);

type Store = EmbeddingAdapter & {
  connect(): Promise<MemoryResult<void>>;
  disconnect(): Promise<unknown>;
};

interface Target {
  name: string;
  url: string | undefined;
  create(): Promise<Store>;
  /** Removes everything the cases stored */
  cleanUp(): Promise<void>;
}

async function connected<T extends Store>(store: T): Promise<T> {
  const result = await store.connect();
  if (!result.success) throw new Error(result.error);
  return store;
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
          schema: `embeddings_${tag}`,
          dimensions: DIMENSIONS,
        })
      ),
    async cleanUp() {
      const client = new pg.Client({ connectionString: postgresUrl });
      await client.connect();
      await client.query(`DROP SCHEMA IF EXISTS embeddings_${tag} CASCADE`);
      await client.end();
    },
  },
  {
    name: 'QdrantAdapter',
    url: qdrantUrl,
    create: () =>
      connected(
        new QdrantAdapter({
          provider: 'qdrant',
          url: qdrantUrl!,
          collection: `conformance_${tag}`,
          dimensions: DIMENSIONS,
        })
      ),
    async cleanUp() {
      await fetch(`${qdrantUrl}/collections/conformance_${tag}`, { method: 'DELETE' });
    },
  },
];

for (const target of targets) {
  (target.url ? describe : describe.skip)(`Memory: ${target.name} embedding conformance`, () => {
    afterAll(() => target.cleanUp());

    for (const c of embeddingAdapterConformanceCases({
      create: target.create,
      dimensions: DIMENSIONS,
      release: async (store) => {
        await store.disconnect();
      },
    })) {
      (c.skip ? it.skip : it)(c.name, { timeout: 30_000 }, () => c.run());
    }
  });
}
