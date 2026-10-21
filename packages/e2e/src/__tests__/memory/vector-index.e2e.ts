import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { MessageIndex, PostgresAdapter, QdrantAdapter } from '@cogitator-ai/memory';
import type { EmbeddingAdapter, EmbeddingService, MemoryAdapter } from '@cogitator-ai/types';

const postgresUrl = process.env.TEST_POSTGRES_URL;
const qdrantUrl = process.env.TEST_QDRANT_URL;
const tag = randomUUID().replace(/-/g, '').slice(0, 8);

/** Unit vectors that put texts about the same topic close together */
function topicEmbedding(dimensions: number): EmbeddingService {
  const topics = ['cat', 'tax', 'car', 'rain'];
  const vectorOf = (text: string) => {
    const vector = new Array<number>(dimensions).fill(0.001);
    topics.forEach((topic, i) => {
      if (text.toLowerCase().includes(topic)) vector[i] = 1;
    });
    const norm = Math.hypot(...vector);
    return vector.map((value) => value / norm);
  };
  return {
    dimensions,
    model: `topics-${dimensions}`,
    embed: async (text) => vectorOf(text),
    embedBatch: async (texts) => texts.map(vectorOf),
  };
}

async function connected<T extends { connect(): Promise<{ success: boolean; error?: string }> }>(
  adapter: T
): Promise<T> {
  const result = await adapter.connect();
  if (!result.success) throw new Error(result.error);
  return adapter;
}

async function exerciseIndex(memory: MemoryAdapter, store: EmbeddingAdapter, dimensions: number) {
  const embedding = topicEmbedding(dimensions);
  const index = new MessageIndex({ store, embedding });
  expect(index.attach(memory)).toBe(true);
  const threadId = `index-${randomUUID()}`;
  await memory.createThread('agent', {}, threadId);
  const say = async (content: string) => {
    const added = await memory.addEntry({
      threadId,
      message: { role: 'user', content },
      tokenCount: 3,
    });
    if (!added.success) throw new Error(added.error);
    return added.data;
  };
  const cat = await say('my cat Whiskers');
  await say('the tax form');
  await say('a red car');
  await index.flush();

  const found = await index.search(threadId, await embedding.embed('cat'), 2, 0.5);
  expect([...found.keys()]).toEqual([cat.id]);

  await memory.deleteThread(threadId);
  await index.close();
  const after = await index.search(threadId, await embedding.embed('cat'), 10, -1);
  expect(after.size).toBe(0);
}

(postgresUrl ? describe : describe.skip)('Memory: Postgres vectors and schema', () => {
  const schemas: string[] = [];
  const adapters: PostgresAdapter[] = [];

  async function postgres(dimensions: number): Promise<PostgresAdapter> {
    const schema = `vectors_${tag}_${dimensions}`;
    schemas.push(schema);
    const adapter = await connected(
      new PostgresAdapter({
        provider: 'postgres',
        connectionString: postgresUrl!,
        schema,
        dimensions,
      })
    );
    adapters.push(adapter);
    return adapter;
  }

  afterAll(async () => {
    for (const adapter of adapters) await adapter.disconnect();
    const client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    for (const schema of new Set(schemas)) {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
    await client.end();
  });

  it('indexes 3072-dimension embeddings as halfvec and searches through the index', async () => {
    const adapter = await postgres(3072);
    const embedding = topicEmbedding(3072);
    for (const [i, text] of ['cat naps', 'tax due', 'car wash', 'rain later'].entries()) {
      await adapter.addEmbedding({
        sourceId: `s${i}`,
        sourceType: 'document',
        vector: await embedding.embed(text),
        content: text,
      });
    }

    const found = await adapter.search({ vector: await embedding.embed('cat'), limit: 1 });

    expect(found.success && found.data.map((r) => r.content)).toEqual(['cat naps']);
    const client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    try {
      const index = await client.query(
        'SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = $2',
        [`vectors_${tag}_3072`, 'idx_embeddings_vector']
      );
      expect(index.rows[0]?.indexdef).toContain('halfvec_cosine_ops');
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const vector = `[${(await embedding.embed('cat')).join(',')}]`;
      const plan = await client.query(
        `EXPLAIN SELECT id FROM vectors_${tag}_3072.embeddings
         ORDER BY (vector::halfvec(3072)) <=> $1::halfvec(3072) LIMIT 1`,
        [vector]
      );
      await client.query('ROLLBACK');
      expect(plan.rows.map((row) => String(row['QUERY PLAN'])).join('\n')).toContain(
        'idx_embeddings_vector'
      );
    } finally {
      await client.end();
    }
  });

  it('records the memory schema version once and connects again without changes', async () => {
    const first = await postgres(8);
    const second = await connected(
      new PostgresAdapter({
        provider: 'postgres',
        connectionString: postgresUrl!,
        schema: `vectors_${tag}_8`,
        dimensions: 8,
      })
    );
    adapters.push(second);
    const client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    try {
      const versions = await client.query(
        `SELECT component, version FROM vectors_${tag}_8.cogitator_schema_migrations`
      );
      expect(versions.rows).toEqual([{ component: 'memory', version: 3 }]);
    } finally {
      await client.end();
    }
    expect((await first.createThread('agent', {}, 'still-works')).success).toBe(true);
  });

  it('keeps one vector per entry and drops them with the thread', async () => {
    const adapter = await postgres(16);
    await exerciseIndex(adapter, adapter, 16);
  });

  async function sql(text: string): Promise<pg.QueryResult> {
    const client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    try {
      return await client.query(text);
    } finally {
      await client.end();
    }
  }

  function connectAll(schema: string, count: number) {
    schemas.push(schema);
    return Promise.all(
      Array.from({ length: count }, async () => {
        const adapter = new PostgresAdapter({
          provider: 'postgres',
          connectionString: postgresUrl!,
          schema,
          dimensions: 8,
        });
        const result = await adapter.connect();
        adapters.push(adapter);
        return result;
      })
    );
  }

  it('lets processes connect to a new schema at once', async () => {
    const results = await connectAll(`fresh_${tag}`, 4);

    expect(results.map((result) => result.success)).toEqual([true, true, true, true]);
  });

  it('lets processes upgrade a schema from before versions at once', async () => {
    const schema = `upgrade_${tag}`;
    await connectAll(schema, 1);
    await sql(`DROP TABLE ${schema}.cogitator_schema_migrations`);
    await sql(`DROP INDEX ${schema}.idx_embeddings_source`);
    await sql(`DROP INDEX ${schema}.idx_embeddings_thread`);

    const results = await connectAll(schema, 4);

    expect(results.map((result) => result.success)).toEqual([true, true, true, true]);
    const indexes = await sql(
      `SELECT indexname FROM pg_indexes WHERE schemaname = '${schema}' AND indexname LIKE 'idx_embeddings_%' ORDER BY indexname`
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining(['idx_embeddings_source', 'idx_embeddings_thread'])
    );
  });

  it('keeps out of the way of a schema_migrations table of another tool', async () => {
    const schema = `foreign_${tag}`;
    schemas.push(schema);
    await sql(`CREATE SCHEMA ${schema}`);
    await sql(`CREATE TABLE ${schema}.schema_migrations (version BIGINT PRIMARY KEY)`);

    const [connected] = await connectAll(schema, 1);

    expect(connected?.success).toBe(true);
  });

  it('creates the tables again when they were dropped after their version was recorded', async () => {
    const schema = `dropped_${tag}`;
    await connectAll(schema, 1);
    await sql(`DROP TABLE ${schema}.entries, ${schema}.threads, ${schema}.memory_items`);

    const [adapter] = await Promise.all([
      (async () => {
        const again = new PostgresAdapter({
          provider: 'postgres',
          connectionString: postgresUrl!,
          schema,
          dimensions: 8,
        });
        await connected(again);
        adapters.push(again);
        return again;
      })(),
    ]);

    expect((await adapter.createThread('agent', {}, 'after-drop')).success).toBe(true);
  });
});

(postgresUrl && qdrantUrl ? describe : describe.skip)('Memory: message index in Qdrant', () => {
  const collection = `messages_${tag}`;
  let memory: PostgresAdapter | undefined;

  afterAll(async () => {
    await memory?.disconnect();
    await fetch(`${qdrantUrl}/collections/${collection}`, { method: 'DELETE' });
    const client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS qdrant_messages_${tag} CASCADE`);
    await client.end();
  });

  it('keeps one vector per entry and drops them with the thread', async () => {
    memory = await connected(
      new PostgresAdapter({
        provider: 'postgres',
        connectionString: postgresUrl!,
        schema: `qdrant_messages_${tag}`,
      })
    );
    const store = await connected(
      new QdrantAdapter({ provider: 'qdrant', url: qdrantUrl!, collection, dimensions: 16 })
    );
    await exerciseIndex(memory, store, 16);
  });
});
