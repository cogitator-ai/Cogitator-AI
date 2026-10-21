import { randomUUID } from 'node:crypto';
import { describe, it } from 'vitest';
import { PostgresAdapter, QdrantAdapter } from '@cogitator-ai/memory';
import { embeddingAdapterConformanceCases } from '@cogitator-ai/test-utils';
import type { EmbeddingAdapter } from '@cogitator-ai/types';

const DIMENSIONS = 8;
const postgresUrl = process.env.TEST_POSTGRES_URL;
const qdrantUrl = process.env.TEST_QDRANT_URL;

const suffix = () => randomUUID().replace(/-/g, '').slice(0, 8);

type Store = EmbeddingAdapter & { disconnect(): Promise<unknown> };

const targets: Array<[string, string | undefined, () => Promise<Store>]> = [
  [
    'PostgresAdapter',
    postgresUrl,
    async () => {
      const adapter = new PostgresAdapter({
        provider: 'postgres',
        connectionString: postgresUrl!,
        schema: `embeddings_${suffix()}`,
        dimensions: DIMENSIONS,
      });
      const connected = await adapter.connect();
      if (!connected.success) throw new Error(connected.error);
      return adapter;
    },
  ],
  [
    'QdrantAdapter',
    qdrantUrl,
    async () => {
      const adapter = new QdrantAdapter({
        provider: 'qdrant',
        url: qdrantUrl!,
        collection: `conformance_${suffix()}`,
        dimensions: DIMENSIONS,
      });
      const connected = await adapter.connect();
      if (!connected.success) throw new Error(connected.error);
      return adapter;
    },
  ],
];

for (const [name, url, create] of targets) {
  (url ? describe : describe.skip)(`Memory: ${name} embedding conformance`, () => {
    for (const c of embeddingAdapterConformanceCases({
      create,
      dimensions: DIMENSIONS,
      release: async (adapter) => {
        await adapter.disconnect();
      },
    })) {
      (c.skip ? it.skip : it)(c.name, { timeout: 30_000 }, () => c.run());
    }
  });
}
