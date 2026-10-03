import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CogitatorConfig, MemoryResult } from '@cogitator-ai/types';
import type { ContextBuilderDeps } from '@cogitator-ai/memory';
import { initializeMemory, cleanupState, type InitializerState } from '../cogitator/initializers';

const created = vi.hoisted(
  () => [] as { kind: string; config: unknown; dimensions?: number; disconnected: boolean }[]
);
const captured = vi.hoisted(() => [] as ContextBuilderDeps[]);

vi.mock('@cogitator-ai/memory', async (importOriginal) => {
  const original = await importOriginal<typeof import('@cogitator-ai/memory')>();
  const ok = async (): Promise<MemoryResult<void>> => ({ success: true, data: undefined });

  function fake(kind: string, base: typeof original.InMemoryAdapter) {
    return class extends base {
      record: (typeof created)[number];
      constructor(config: unknown) {
        super({ provider: 'memory' });
        this.record = { kind, config, disconnected: false };
        created.push(this.record);
      }
      override connect = ok;
      override disconnect = async (): Promise<MemoryResult<void>> => {
        this.record.disconnected = true;
        return ok();
      };
      setVectorDimensions(dimensions: number) {
        this.record.dimensions = dimensions;
      }
    };
  }

  class FakeQdrant {
    record: (typeof created)[number];
    constructor(config: unknown) {
      this.record = { kind: 'qdrant', config, disconnected: false };
      created.push(this.record);
    }
    connect = ok;
    disconnect = async (): Promise<MemoryResult<void>> => {
      this.record.disconnected = true;
      return ok();
    };
    addEmbedding = vi.fn();
    search = vi.fn();
    deleteEmbedding = vi.fn();
    deleteBySource = vi.fn();
  }

  class CapturingContextBuilder extends original.ContextBuilder {
    constructor(...args: ConstructorParameters<typeof original.ContextBuilder>) {
      super(...args);
      captured.push(args[1]);
    }
  }

  return {
    ...original,
    RedisAdapter: fake('redis', original.InMemoryAdapter),
    PostgresAdapter: fake('postgres', original.InMemoryAdapter),
    SQLiteAdapter: fake('sqlite', original.InMemoryAdapter),
    MongoDBAdapter: fake('mongodb', original.InMemoryAdapter),
    QdrantAdapter: FakeQdrant,
    ContextBuilder: CapturingContextBuilder,
  };
});

const freshState = (): InitializerState => ({
  memoryInitialized: false,
  sandboxInitialized: false,
  reflectionInitialized: false,
  guardrailsInitialized: false,
  costRoutingInitialized: false,
  securityInitialized: false,
  contextManagerInitialized: false,
});

async function init(memory: CogitatorConfig['memory']) {
  const state = freshState();
  await initializeMemory({ memory }, state);
  return state;
}

beforeEach(() => {
  created.length = 0;
  captured.length = 0;
});

describe('memory from config', () => {
  it('builds a SQLite store from memory.sqlite', async () => {
    const state = await init({ adapter: 'sqlite', sqlite: { path: ':memory:' } });

    expect(state.memoryAdapter).toBeDefined();
    expect(created).toEqual([
      expect.objectContaining({ kind: 'sqlite', config: { provider: 'sqlite', path: ':memory:' } }),
    ]);
  });

  it('builds a MongoDB store from memory.mongodb', async () => {
    const state = await init({
      adapter: 'mongodb',
      mongodb: { uri: 'mongodb://localhost:27017', database: 'agents' },
    });

    expect(state.memoryAdapter).toBeDefined();
    expect(created[0]).toMatchObject({
      kind: 'mongodb',
      config: { provider: 'mongodb', uri: 'mongodb://localhost:27017', database: 'agents' },
    });
  });

  it('builds a Redis store from host and port, or cluster nodes, without a url', async () => {
    await init({ adapter: 'redis', redis: { host: 'cache', port: 6380 } });
    await init({ adapter: 'redis', redis: { cluster: { nodes: [{ host: 'n1', port: 7000 }] } } });

    expect(created.map((c) => c.config)).toEqual([
      { provider: 'redis', host: 'cache', port: 6380 },
      { provider: 'redis', cluster: { nodes: [{ host: 'n1', port: 7000 }] } },
    ]);
  });

  it('sizes the Postgres vector column for the embedding model before connecting', async () => {
    await init({
      adapter: 'postgres',
      postgres: { connectionString: 'postgres://localhost/db' },
      embedding: { provider: 'openai', apiKey: 'sk-test', model: 'text-embedding-3-large' },
    });

    expect(created[0]).toMatchObject({ kind: 'postgres', dimensions: 3072 });
  });

  it('leaves memory off, with no store, when adapter is qdrant', async () => {
    const state = await init({
      adapter: 'qdrant',
      qdrant: { url: 'http://localhost:6333', dimensions: 768 },
    });

    expect(state.memoryAdapter).toBeUndefined();
    expect(state.memoryInitialized).toBe(false);
    expect(created).toEqual([]);
  });

  it('uses memory.qdrant as the embedding store of the context builder, and closes it', async () => {
    const state = await init({
      adapter: 'memory',
      qdrant: { url: 'http://localhost:6333', collection: 'notes', dimensions: 768 },
      embedding: { provider: 'ollama', model: 'nomic-embed-text' },
      contextBuilder: { strategy: 'relevant' },
    });

    const qdrant = created.find((c) => c.kind === 'qdrant');
    expect(qdrant?.config).toEqual({
      provider: 'qdrant',
      url: 'http://localhost:6333',
      collection: 'notes',
      dimensions: 768,
    });
    expect(captured[0]?.embeddingAdapter).toBe(state.embeddingStore);

    await cleanupState(state);
    expect(qdrant?.disconnected).toBe(true);
  });
});
