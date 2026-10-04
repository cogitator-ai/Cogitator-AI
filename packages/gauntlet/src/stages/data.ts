import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  ContextBuilder,
  CoreFactsStore,
  HybridSearch,
  InMemoryEmbeddingAdapter,
  PostgresAdapter,
  RedisAdapter,
  SQLiteAdapter,
  createEmbeddingAdapter,
  createMemoryAdapter,
  unwrap,
} from '@cogitator-ai/memory';
import { createConfigFromEnv, createRedisClient, detectRedisMode } from '@cogitator-ai/redis';
import { QdrantClient } from '@qdrant/js-client-rest';
import type { MemoryResult } from '@cogitator-ai/types';
import type { StageContext, StageDefinition } from '../runner/types.js';
import { memoryAgentStage } from './data/memory-agent.js';
import { ragStage } from './data/rag.js';
import {
  HashingEmbeddingService,
  dropPostgresSchema,
  textOf,
  uniqueSuffix,
} from './data/support.js';
import { exerciseThreadStore } from './data/thread-store.js';
import { VECTOR_CORPUS, exerciseVectorStore } from './data/vectors.js';

const MEMORY = '@cogitator-ai/memory';
const REDIS = '@cogitator-ai/redis';
const TYPES = '@cogitator-ai/types';

/** In-process stores: the in-memory and SQLite thread stores, vectors, hybrid search, context, core facts. */
const memoryLocal: StageDefinition = {
  id: 'memory-local',
  title: 'Memory: in-process stores',
  description:
    'In-memory and SQLite thread stores keep conversations in order, SQLite survives a reconnect, and hybrid search, the context builder and core facts work on top.',
  packages: [MEMORY, TYPES],
  timeoutMs: 60_000,
  async run(ctx) {
    const inMemory = await createMemoryAdapter({ provider: 'memory' });
    unwrap(await inMemory.connect());
    await exerciseThreadStore(ctx, 'in-memory', inMemory);

    const file = join(ctx.tmpDir, 'memory.db');
    const sqlite = await createMemoryAdapter({ provider: 'sqlite', path: file });
    unwrap(await sqlite.connect());
    ctx.onCleanup(async () => {
      await sqlite.disconnect();
    });
    const { threadId, entryIds } = await exerciseThreadStore(ctx, 'sqlite', sqlite, {
      keepThread: true,
    });

    await ctx.check('sqlite: the file keeps the thread across a reconnect', async (evidence) => {
      unwrap(await sqlite.disconnect());
      const reopened = new SQLiteAdapter({ provider: 'sqlite', path: file });
      unwrap(await reopened.connect());
      try {
        const entries = unwrap(await reopened.getEntries({ threadId }));
        evidence('file', 'memory.db');
        evidence('entries', entries.length);
        const expected = entryIds.slice(1);
        if (entries.map((entry) => entry.id).join() !== expected.join()) {
          throw new Error(
            `Reopened file holds ${entries.length} entries, expected ${expected.length} in order`
          );
        }
      } finally {
        await reopened.disconnect();
      }
      unwrap(await sqlite.connect());
    });

    await ctx.check(
      'hybrid search: vector, keyword and fused rankings agree on the match',
      async (evidence) => {
        const embeddingService = new HashingEmbeddingService();
        const embeddingAdapter = new InMemoryEmbeddingAdapter();
        for (const doc of VECTOR_CORPUS) {
          unwrap(
            await embeddingAdapter.addEmbedding({
              sourceId: doc.sourceId,
              sourceType: 'document',
              vector: await embeddingService.embed(doc.content),
              content: doc.content,
              metadata: { ...doc.metadata },
            })
          );
        }
        const search = new HybridSearch({
          embeddingAdapter,
          embeddingService,
          keywordAdapter: embeddingAdapter,
        });
        const top: Record<string, string | undefined> = {};
        for (const strategy of ['vector', 'keyword', 'hybrid'] as const) {
          const hits = unwrap(
            await search.search({
              query: 'sourdough bread from the bakery',
              strategy,
              limit: 3,
              threshold: 0,
            })
          );
          top[strategy] = hits[0]?.sourceId;
          if (
            strategy === 'hybrid' &&
            (hits[0]?.vectorScore === undefined || hits[0].keywordScore === undefined)
          ) {
            throw new Error(`The fused hit lacks a component score: ${JSON.stringify(hits[0])}`);
          }
        }
        evidence('top', top);
        for (const [strategy, sourceId] of Object.entries(top)) {
          if (sourceId !== 'doc-bakery')
            throw new Error(`${strategy} search ranked ${sourceId} first`);
        }
      }
    );

    await ctx.check(
      'core facts: values, history and prompt block persist in SQLite',
      async (evidence) => {
        const path = join(ctx.tmpDir, 'facts.db');
        const facts = new CoreFactsStore({ path });
        await facts.initialize();
        await facts.set('name', 'Ada');
        await facts.set('city', 'Lisbon');
        await facts.set('city', 'Porto');
        await facts.close();

        const reopened = new CoreFactsStore({ path });
        await reopened.initialize();
        try {
          const all = await reopened.getAll();
          const history = await reopened.getHistory('city');
          const prompt = await reopened.formatForPrompt();
          evidence('facts', all);
          evidence(
            'cityHistory',
            history.map((entry) => entry.value)
          );
          if (all.name !== 'Ada' || all.city !== 'Porto')
            throw new Error(`Facts read back as ${JSON.stringify(all)}`);
          if (history.map((entry) => entry.value).join() !== 'Lisbon,Porto') {
            throw new Error(`City history is ${history.map((entry) => entry.value).join(', ')}`);
          }
          if (!prompt.includes('Porto') || prompt.includes('Lisbon')) {
            throw new Error(`Prompt block does not show the current values only: ${prompt}`);
          }
        } finally {
          await reopened.close();
        }
      }
    );

    await ctx.check(
      'context builder: a tight budget keeps a contiguous recent window',
      async (evidence) => {
        const store = await createMemoryAdapter({ provider: 'memory' });
        const thread = unwrap(await store.createThread('budgeted'));
        const turns = [
          { role: 'user', content: 'What is the capital of Portugal?' },
          { role: 'assistant', content: `Lisbon. ${'It sits on the Tagus estuary. '.repeat(40)}` },
          { role: 'user', content: 'And its population?' },
          { role: 'assistant', content: 'About half a million in the city proper.' },
          { role: 'user', content: 'Thanks.' },
        ] as const;
        for (const message of turns) {
          unwrap(
            await store.addEntry({
              threadId: thread.id,
              message: { ...message },
              tokenCount: Math.ceil(message.content.length / 4),
            })
          );
        }
        const builder = new ContextBuilder(
          { maxTokens: 200, reserveTokens: 0, strategy: 'recent', includeSystemPrompt: true },
          { memoryAdapter: store }
        );
        const context = await builder.build({
          threadId: thread.id,
          agentId: 'budgeted',
          systemPrompt: 'Be brief.',
        });
        const kept = context.messages
          .filter((message) => message.role !== 'system')
          .map((message) => textOf(message.content));
        evidence(
          'kept',
          kept.map((text) => text.slice(0, 40))
        );
        evidence('truncated', context.truncated);
        evidence('tokens', context.tokenCount);
        if (!context.truncated)
          throw new Error('The long history fit a 200 token budget, the test is wrong');
        if (context.messages[0]?.role !== 'system')
          throw new Error('The system prompt was not put first');
        if (kept.at(-1) !== 'Thanks.') throw new Error('The newest message was dropped');
        const expectedSuffix = turns.slice(-kept.length).map((turn) => turn.content);
        if (kept.join('\n') !== expectedSuffix.join('\n')) {
          throw new Error(
            `The "recent" window skipped a message that did not fit and kept older ones, so the model sees a reply to a question it never got: ${kept.map((text) => JSON.stringify(text.slice(0, 30))).join(', ')}`
          );
        }
      }
    );
  },
};

/** A Postgres adapter in a schema of its own, dropped when the run ends. */
async function postgresAdapter(
  ctx: StageContext,
  dimensions: number
): Promise<{ adapter: PostgresAdapter; schema: string }> {
  const schema = `gauntlet_data_${uniqueSuffix()}`;
  const connectionString = ctx.services.postgres;
  const adapter = new PostgresAdapter({
    provider: 'postgres',
    connectionString,
    schema,
    poolSize: 4,
  });
  adapter.setVectorDimensions(dimensions);
  ctx.onCleanup(async () => {
    await adapter.disconnect();
    await dropPostgresSchema(connectionString, schema);
  });
  await ctx.check('connects and creates its schema', async (evidence) => {
    unwrap(await adapter.connect());
    evidence('schema', schema);
    evidence('vectorDimensions', dimensions);
  });
  return { adapter, schema };
}

/** Postgres as the thread and fact store. */
const memoryPostgres: StageDefinition = {
  id: 'memory-postgres',
  title: 'Memory: Postgres threads and facts',
  description:
    'The Postgres adapter keeps facts and ordered threads, tool calls included, in a schema of its own.',
  packages: [MEMORY, TYPES],
  requires: [{ kind: 'service', name: 'postgres' }],
  timeoutMs: 60_000,
  async run(ctx) {
    const { adapter } = await postgresAdapter(ctx, 8);

    await ctx.check('facts: add, filter by category, search, update, delete', async (evidence) => {
      const agentId = `facts-${uniqueSuffix()}`;
      const tea = unwrap(
        await adapter.addFact({
          agentId,
          content: 'Prefers smoked lapsang tea',
          category: 'preference',
          confidence: 0.9,
          source: 'user',
        })
      );
      unwrap(
        await adapter.addFact({
          agentId,
          content: 'Works from the Porto office',
          category: 'profile',
          confidence: 1,
          source: 'inferred',
        })
      );
      const preferences = unwrap(await adapter.getFacts(agentId, 'preference'));
      const found = unwrap(await adapter.searchFacts(agentId, 'lapsang'));
      evidence(
        'preferences',
        preferences.map((fact) => fact.content)
      );
      evidence('searchHits', found.length);
      if (preferences.length !== 1 || preferences[0]?.id !== tea.id) {
        throw new Error(`getFacts by category returned ${preferences.length} facts`);
      }
      if (found[0]?.id !== tea.id)
        throw new Error('searchFacts did not find the fact by a word in it');
      const updated = unwrap(
        await adapter.updateFact(tea.id, { content: 'Prefers jasmine tea', confidence: 0.6 })
      );
      if (updated.content !== 'Prefers jasmine tea' || updated.confidence !== 0.6) {
        throw new Error(`updateFact returned ${JSON.stringify(updated)}`);
      }
      unwrap(await adapter.deleteFact(tea.id));
      const left = unwrap(await adapter.getFacts(agentId));
      evidence(
        'afterDelete',
        left.map((fact) => fact.content)
      );
      if (left.some((fact) => fact.id === tea.id)) throw new Error('deleteFact left the fact');
    });

    await exerciseThreadStore(ctx, 'postgres', adapter);
  },
};

/** Postgres with pgvector as the vector store, with full-text and hybrid search. */
const memoryPgvector: StageDefinition = {
  id: 'memory-pgvector',
  title: 'Memory: pgvector search',
  description:
    'The Postgres adapter finds every stored vector, filters and deletes them, and answers full-text and hybrid queries.',
  packages: [MEMORY, TYPES],
  requires: [{ kind: 'service', name: 'postgres' }],
  timeoutMs: 60_000,
  async run(ctx) {
    const embeddings = new HashingEmbeddingService();
    const { adapter } = await postgresAdapter(ctx, embeddings.dimensions);

    await ctx.check(
      'a small limit returns the same nearest vectors as a large one',
      async (evidence) => {
        const texts = [
          'red kite',
          'blue whale',
          'green tea',
          'yellow taxi',
          'purple rain',
          'orange grove',
        ];
        const vectors = await embeddings.embedBatch(texts);
        for (const [index, content] of texts.entries()) {
          unwrap(
            await adapter.addEmbedding({
              sourceId: `recall-${index}`,
              sourceType: 'document',
              vector: vectors[index]!,
              content,
            })
          );
        }
        const wide = unwrap(await adapter.search({ vector: vectors[0]!, limit: 20, threshold: 0 }));
        const narrow = unwrap(
          await adapter.search({ vector: vectors[0]!, limit: 3, threshold: 0 })
        );
        evidence('limit20', wide.length);
        evidence(
          'limit3',
          narrow.map((hit) => hit.content)
        );
        for (const index of texts.keys()) unwrap(await adapter.deleteBySource(`recall-${index}`));
        const expected = wide.slice(0, 3).map((hit) => hit.sourceId);
        if (narrow.map((hit) => hit.sourceId).join() !== expected.join()) {
          throw new Error(
            `limit 3 returned ${narrow.length} rows while limit 20 returned ${wide.length}: the vector index loses rows for small limits`
          );
        }
      }
    );

    await exerciseVectorStore(ctx, 'pgvector', adapter, embeddings);

    await ctx.check('full-text and hybrid search run on the Postgres index', async (evidence) => {
      const keyword = unwrap(await adapter.keywordSearch({ query: 'sourdough bread', limit: 3 }));
      evidence('keywordTop', keyword[0]?.sourceId);
      if (keyword[0]?.sourceId !== 'doc-bakery') {
        throw new Error(`Full-text search ranked ${keyword[0]?.sourceId ?? 'nothing'} first`);
      }
      const search = new HybridSearch({
        embeddingAdapter: adapter,
        embeddingService: embeddings,
        keywordAdapter: adapter,
      });
      const hybrid = unwrap(
        await search.search({
          query: 'cider from orchard apples',
          strategy: 'hybrid',
          limit: 3,
          threshold: 0,
        })
      );
      evidence(
        'hybridTop',
        hybrid.map((hit) => hit.sourceId)
      );
      if (hybrid[0]?.sourceId !== 'doc-orchard') {
        throw new Error(`Hybrid search ranked ${hybrid[0]?.sourceId ?? 'nothing'} first`);
      }
    });
  },
};

/** Redis: the standalone client of `@cogitator-ai/redis` and the memory adapter on top of it. */
const memoryRedis: StageDefinition = {
  id: 'memory-redis',
  title: 'Memory: Redis',
  description:
    'The Redis client prefixes, scans and publishes as documented, and the Redis memory adapter keeps ordered threads that expire with their TTL.',
  packages: [REDIS, MEMORY, TYPES],
  requires: [{ kind: 'service', name: 'redis' }],
  timeoutMs: 60_000,
  async run(ctx) {
    const url = ctx.services.redis;
    const prefix = `gauntlet:data:${uniqueSuffix()}:`;
    const client = await createRedisClient({ url, keyPrefix: prefix });
    const raw = await createRedisClient({ url });
    ctx.onCleanup(async () => {
      const keys = await raw.keys(`${prefix}*`);
      if (keys.length > 0) await raw.del(...keys);
      await client.quit();
      await raw.quit();
    });

    await ctx.check(
      'client: strings, counters and sorted sets under a key prefix',
      async (evidence) => {
        evidence('pong', await client.ping());
        await client.set('greeting', 'hello');
        await client.setex('ephemeral', 60, 'soon gone');
        for (let i = 0; i < 3; i++) await client.incr('counter');
        await client.zadd('timeline', 3, 'third');
        await client.zadd('timeline', 1, 'first');
        await client.zadd('timeline', 2, 'second');
        const values = await client.mget('greeting', 'missing', 'counter');
        const ordered = await client.zrange('timeline', 0, -1);
        const later = await client.zrangebyscore('timeline', '(1', '+inf');
        evidence('mget', values);
        evidence('zrange', ordered);
        if (values.join() !== 'hello,,3')
          throw new Error(`mget returned ${JSON.stringify(values)}`);
        if (ordered.join() !== 'first,second,third')
          throw new Error(`zrange returned ${ordered.join(', ')}`);
        if (later.join() !== 'second,third')
          throw new Error(`zrangebyscore returned ${later.join(', ')}`);
        if ((await client.exists('greeting', 'ephemeral', 'missing')) !== 2)
          throw new Error('exists miscounted');
        if ((await raw.get(`${prefix}greeting`)) !== 'hello')
          throw new Error('The key was not stored under the prefix');
      }
    );

    await ctx.check(
      'client: keys and scan return prefix-free keys that work with get',
      async (evidence) => {
        const keys = (await client.keys('*')).sort();
        const scanned = new Set<string>();
        let cursor = '0';
        do {
          const [next, batch] = await client.scan(cursor, 'MATCH', '*', 'COUNT', 2);
          for (const key of batch) scanned.add(key);
          cursor = next;
        } while (cursor !== '0');
        evidence('keys', keys);
        evidence('scanned', scanned.size);
        if (keys.join() !== 'counter,ephemeral,greeting,timeline')
          throw new Error(`keys returned ${keys.join(', ')}`);
        if ([...scanned].sort().join() !== keys.join())
          throw new Error(`scan found ${[...scanned].join(', ')}`);
        if ((await client.get(keys[2]!)) !== 'hello')
          throw new Error('A key from keys() does not resolve with get()');
      }
    );

    await ctx.check(
      'client: publish reaches a subscriber on a duplicated connection',
      async (evidence) => {
        const channel = `${prefix}events`;
        const subscriber = client.duplicate();
        try {
          const received = new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('No message within 5 s')), 5_000);
            void subscriber.subscribe(channel, (_channel, message) => {
              clearTimeout(timer);
              resolve(message);
            });
          });
          await sleep(100);
          const receivers = await client.publish(channel, 'ping from the gauntlet');
          const message = await received;
          evidence('receivers', receivers);
          evidence('message', message);
          if (message !== 'ping from the gauntlet') throw new Error(`Received ${message}`);
          await subscriber.unsubscribe(channel);
        } finally {
          await subscriber.quit();
        }
      }
    );

    await ctx.check('client: mode detection and config from the environment', async (evidence) => {
      const mode = await detectRedisMode({ url });
      const config = createConfigFromEnv({ REDIS_URL: url, REDIS_KEY_PREFIX: 'svc:' });
      evidence('mode', mode);
      evidence('configMode', config.mode);
      if (mode !== 'standalone') throw new Error(`detectRedisMode answered ${mode}`);
      if (config.mode !== 'standalone' || config.url !== url || config.keyPrefix !== 'svc:') {
        throw new Error(
          `createConfigFromEnv built ${JSON.stringify({ ...config, password: undefined })}`
        );
      }
    });

    const adapter = new RedisAdapter({
      provider: 'redis',
      url,
      keyPrefix: `${prefix}memory:`,
      ttl: 3600,
    });
    unwrap(await adapter.connect());
    ctx.onCleanup(async () => {
      await adapter.disconnect();
    });
    await exerciseThreadStore(ctx, 'redis', adapter);

    await ctx.check('redis: threads and entries expire with the TTL', async (evidence) => {
      const shortLived = new RedisAdapter({
        provider: 'redis',
        url,
        keyPrefix: `${prefix}ttl:`,
        ttl: 1,
      });
      unwrap(await shortLived.connect());
      try {
        const thread = unwrap(await shortLived.createThread('ttl-agent'));
        unwrap(
          await shortLived.addEntry({
            threadId: thread.id,
            message: { role: 'user', content: 'gone soon' },
            tokenCount: 3,
          })
        );
        const before = unwrap(await shortLived.getEntries({ threadId: thread.id }));
        await sleep(2_200);
        const after = unwrap(await shortLived.getEntries({ threadId: thread.id }));
        const gone = unwrap(await shortLived.getThread(thread.id));
        evidence('before', before.length);
        evidence('after', after.length);
        if (before.length !== 1) throw new Error(`Read ${before.length} entries before expiry`);
        if (after.length !== 0 || gone) throw new Error('The thread outlived its 1 s TTL');
      } finally {
        await shortLived.disconnect();
      }
    });
  },
};

/**
 * `createEmbeddingAdapter` is typed as returning a bare `EmbeddingAdapter`, which has no
 * `connect()`, although the adapter it builds must be connected before use (see the report).
 */
function isConnectable<T extends object>(
  adapter: T
): adapter is T & { connect(): Promise<MemoryResult<void>> } {
  return 'connect' in adapter && typeof adapter.connect === 'function';
}

/** Qdrant as the vector store of the memory package. */
const memoryQdrant: StageDefinition = {
  id: 'memory-qdrant',
  title: 'Memory: Qdrant vectors',
  description:
    'The Qdrant adapter creates its collection, stores and filters document vectors, and deletes them by id and by source.',
  packages: [MEMORY, TYPES],
  requires: [{ kind: 'service', name: 'qdrant' }],
  timeoutMs: 60_000,
  async run(ctx) {
    const collection = `gauntlet_data_${uniqueSuffix()}`;
    const embeddings = new HashingEmbeddingService();
    const qdrant = new QdrantClient({ url: ctx.services.qdrant, checkCompatibility: false });
    const adapter = await createEmbeddingAdapter({
      provider: 'qdrant',
      url: ctx.services.qdrant,
      collection,
      dimensions: embeddings.dimensions,
    });
    ctx.onCleanup(async () => {
      await qdrant.deleteCollection(collection);
    });

    await ctx.check('connect creates the collection with the configured size', async (evidence) => {
      if (!isConnectable(adapter)) {
        throw new Error('createEmbeddingAdapter returned an adapter without connect()');
      }
      unwrap(await adapter.connect());
      const info = await qdrant.getCollection(collection);
      const vectors = info.config.params.vectors;
      const size = vectors && 'size' in vectors ? vectors.size : undefined;
      evidence('collection', collection);
      evidence('size', size);
      if (size !== embeddings.dimensions)
        throw new Error(`Collection vector size is ${String(size)}`);
    });

    await exerciseVectorStore(ctx, 'qdrant', adapter, embeddings);
  },
};

export const dataStages: StageDefinition[] = [
  memoryLocal,
  memoryPostgres,
  memoryPgvector,
  memoryRedis,
  memoryQdrant,
  memoryAgentStage,
  ragStage,
];
