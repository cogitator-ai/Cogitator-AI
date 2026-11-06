import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { compileFunction } from 'node:vm';
import ts from 'typescript';
import { LAZY_CONNECT } from '../kit/features/rag.js';
import { planProject } from '../kit/plan.js';
import { parseSpec } from '../kit/spec.js';

interface MemoryModule {
  InMemoryEmbeddingAdapter: new () => {
    connect?: () => Promise<{ success: boolean; data?: undefined; error?: string }>;
    addEmbedding(embedding: unknown): Promise<{ success: boolean; data?: unknown }>;
    search(options: unknown): Promise<{ success: boolean; data?: unknown[] }>;
    deleteEmbedding(id: string): Promise<{ success: boolean; error?: string }>;
    deleteBySource(source: string): Promise<{ success: boolean; error?: string }>;
    deleteByFilter(filter: unknown): Promise<{ success: boolean; error?: string }>;
    getBySources(sourceIds: string[]): Promise<{ success: boolean; data?: unknown[] }>;
    replaceBySource(embedding: unknown): Promise<{ success: boolean; data?: unknown }>;
  };
}

interface RagPipelineInstance {
  ingest(source: string): Promise<{ documents: number; chunks: number; unchanged: number }>;
  query(text: string, options?: unknown): Promise<Array<{ content: string }>>;
}

interface RagModule {
  MarkdownLoader: new () => unknown;
  RAGPipelineBuilder: new () => {
    withLoader(loader: unknown): unknown;
    withEmbeddingService(service: unknown): unknown;
    withEmbeddingAdapter(adapter: unknown): unknown;
    withConfig(config: unknown): unknown;
    build(): RagPipelineInstance;
  };
}

const memoryModuleUrl: string = pathToFileURL(
  resolve(import.meta.dirname, '../../../memory/src/adapters/memory-embedding.ts')
).href;
const ragModuleUrl: string = pathToFileURL(
  resolve(import.meta.dirname, '../../../rag/src/index.ts')
).href;

async function loadRagPipelineTools(): Promise<{
  InMemoryEmbeddingAdapter: MemoryModule['InMemoryEmbeddingAdapter'];
  MarkdownLoader: RagModule['MarkdownLoader'];
  RAGPipelineBuilder: RagModule['RAGPipelineBuilder'];
}> {
  const memory = (await import(memoryModuleUrl)) as unknown as MemoryModule;
  const rag = (await import(ragModuleUrl)) as unknown as RagModule;
  return {
    InMemoryEmbeddingAdapter: memory.InMemoryEmbeddingAdapter,
    MarkdownLoader: rag.MarkdownLoader,
    RAGPipelineBuilder: rag.RAGPipelineBuilder,
  };
}

interface FakeStoreOptions {
  hasGetBySources?: boolean;
  hasReplaceBySource?: boolean;
  connectSuccess?: boolean;
  connectError?: string;
}

function createFakeStore(options: FakeStoreOptions = {}) {
  const calls: string[] = [];
  const {
    hasGetBySources = true,
    hasReplaceBySource = true,
    connectSuccess = true,
    connectError = 'connection failed',
  } = options;

  const store: Record<string, unknown> = {
    calls,
    async connect() {
      calls.push('connect');
      return connectSuccess
        ? { success: true, data: undefined }
        : { success: false, error: connectError };
    },
    async addEmbedding(embedding: unknown) {
      calls.push('addEmbedding');
      return { success: true, data: embedding };
    },
    async search() {
      calls.push('search');
      return { success: true, data: [] };
    },
    async deleteEmbedding() {
      calls.push('deleteEmbedding');
      return { success: true, data: undefined };
    },
    async deleteBySource() {
      calls.push('deleteBySource');
      return { success: true, data: undefined };
    },
    async deleteByFilter() {
      calls.push('deleteByFilter');
      return { success: true, data: undefined };
    },
  };

  if (hasGetBySources) {
    store.getBySources = async (sourceIds: string[]) => {
      calls.push('getBySources');
      return {
        success: true,
        data: sourceIds.map((id) => ({
          id,
          sourceId: id,
          sourceType: 'document' as const,
          vector: [0.1, 0.2],
          content: 'text',
          createdAt: new Date(),
        })),
      };
    };
  }

  if (hasReplaceBySource) {
    store.replaceBySource = async (embedding: unknown) => {
      calls.push('replaceBySource');
      return { success: true, data: embedding };
    };
  }

  return store;
}

function loadLazilyConnected(): (
  store: unknown
) => Record<string, (...args: unknown[]) => Promise<unknown>> {
  const source = `export ${LAZY_CONNECT}`;
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = {
    exports: {} as {
      lazilyConnected?: (
        store: unknown
      ) => Record<string, (...args: unknown[]) => Promise<unknown>>;
    },
  };
  compileFunction(outputText, ['module', 'exports'])(module, module.exports);
  return module.exports.lazilyConnected!;
}

function loadGeneratedStore(
  vectorStore: 'postgres' | 'qdrant',
  fakeAdapterClass: unknown
): Record<string, (...args: unknown[]) => Promise<unknown>> {
  const plan = planProject(
    parseSpec({
      name: 'demo-rag-test',
      preset: 'basic',
      app: 'script',
      memory: 'none',
      provider: 'openai',
      model: 'gpt-6.1-sol',
      features: ['rag'],
      vectorStore,
      packageManager: 'pnpm',
    })
  );
  const kbFile = plan.files.find((f) => f.path === 'src/rag/knowledge-base.ts');
  if (!kbFile) throw new Error('src/rag/knowledge-base.ts not found in generated plan');

  const { outputText } = ts.transpileModule(kbFile.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });

  const module = { exports: {} as Record<string, unknown> };
  const load = (specifier: string): unknown => {
    if (specifier === '@cogitator-ai/memory') {
      return {
        OpenAIEmbeddingService: class {
          dimensions = 64;
          model = 'test-model';
        },
        PostgresAdapter: fakeAdapterClass,
        QdrantAdapter: fakeAdapterClass,
      };
    }
    if (specifier === '@cogitator-ai/core') {
      return { tool: (def: unknown) => def };
    }
    if (specifier === '@cogitator-ai/rag') {
      return {
        MarkdownLoader: class {},
        RAGPipelineBuilder: class {
          withLoader() {
            return this;
          }
          withEmbeddingService() {
            return this;
          }
          withEmbeddingAdapter() {
            return this;
          }
          withConfig() {
            return this;
          }
          build() {
            return {};
          }
        },
        ragTools: () => [{}],
      };
    }
    throw new Error(`Unexpected import in generated knowledge base: ${specifier}`);
  };

  compileFunction(outputText, ['module', 'exports', 'require'])(module, module.exports, load);
  const exports = module.exports as {
    createStore: (embeddings: {
      dimensions: number;
      model: string;
    }) => Record<string, (...args: unknown[]) => Promise<unknown>>;
  };
  return exports.createStore({ dimensions: 64, model: 'test-model' });
}

describe('lazilyConnected RAG store adapter', () => {
  const lazilyConnected = loadLazilyConnected();

  describe.each(['postgres', 'qdrant'] as const)('generated %s store adapter', (vectorStore) => {
    it('exposes and correctly forwards both optional methods after connecting', async () => {
      let recordedCalls: string[] = [];
      class RecordingAdapter {
        config: unknown;
        constructor(config: unknown) {
          this.config = config;
          const fake = createFakeStore();
          recordedCalls = fake.calls as string[];
          Object.assign(this, fake);
        }
      }

      const adapter = loadGeneratedStore(vectorStore, RecordingAdapter);

      expect(typeof adapter.getBySources).toBe('function');
      expect(typeof adapter.replaceBySource).toBe('function');

      const getResult = await adapter.getBySources(['source-1', 'source-2']);
      expect(recordedCalls).toEqual(['connect', 'getBySources']);
      expect(getResult).toMatchObject({ success: true });

      const replaceResult = await adapter.replaceBySource({
        sourceId: 'source-1',
        sourceType: 'document',
        vector: [0.1, 0.2],
        content: 'replaced',
      });
      expect(recordedCalls).toEqual(['connect', 'getBySources', 'replaceBySource']);
      expect(replaceResult).toMatchObject({ success: true });
    });

    it('connects before replaceBySource when it is the first call', async () => {
      let recordedCalls: string[] = [];
      class RecordingAdapter {
        constructor() {
          const fake = createFakeStore();
          recordedCalls = fake.calls as string[];
          Object.assign(this, fake);
        }
      }

      const adapter = loadGeneratedStore(vectorStore, RecordingAdapter);

      await adapter.replaceBySource({
        sourceId: 'source-1',
        sourceType: 'document',
        vector: [0.1, 0.2],
        content: 'replaced',
      });
      expect(recordedCalls).toEqual(['connect', 'replaceBySource']);
    });

    it('rejects if connection fails when invoking forwarded methods', async () => {
      class FailingAdapter {
        constructor() {
          const fake = createFakeStore({
            connectSuccess: false,
            connectError: 'network unreachable',
          });
          Object.assign(this, fake);
        }
      }

      const adapter = loadGeneratedStore(vectorStore, FailingAdapter);

      await expect(adapter.getBySources(['source-1'])).rejects.toThrow(
        'Cannot connect the vector store: network unreachable'
      );
    });
  });

  describe('optional method omission', () => {
    it('leaves optional methods absent when the underlying store does not implement them', () => {
      const storeWithoutOptionals = createFakeStore({
        hasGetBySources: false,
        hasReplaceBySource: false,
      });

      const adapter = lazilyConnected(storeWithoutOptionals);

      expect('getBySources' in adapter).toBe(false);
      expect(adapter.getBySources).toBeUndefined();
      expect('replaceBySource' in adapter).toBe(false);
      expect(adapter.replaceBySource).toBeUndefined();
    });

    it('exposes only getBySources when replaceBySource is absent', () => {
      const storeWithOnlyGet = createFakeStore({
        hasGetBySources: true,
        hasReplaceBySource: false,
      });

      const adapter = lazilyConnected(storeWithOnlyGet);

      expect('getBySources' in adapter).toBe(true);
      expect(typeof adapter.getBySources).toBe('function');
      expect('replaceBySource' in adapter).toBe(false);
      expect(adapter.replaceBySource).toBeUndefined();
    });

    it('exposes only replaceBySource when getBySources is absent', () => {
      const storeWithOnlyReplace = createFakeStore({
        hasGetBySources: false,
        hasReplaceBySource: true,
      });

      const adapter = lazilyConnected(storeWithOnlyReplace);

      expect('getBySources' in adapter).toBe(false);
      expect(adapter.getBySources).toBeUndefined();
      expect('replaceBySource' in adapter).toBe(true);
      expect(typeof adapter.replaceBySource).toBe('function');
    });
  });

  describe('RAG ingestion caching regression', () => {
    let docsDir: string;

    beforeEach(() => {
      docsDir = mkdtempSync(join(tmpdir(), 'rag-ingest-test-'));
      writeFileSync(
        join(docsDir, 'deploys.md'),
        '# Deploy Schedule\n\nDeployments occur every Tuesday and Thursday.'
      );
    });

    afterEach(() => {
      rmSync(docsDir, { recursive: true, force: true });
    });

    it('embeds nothing on the second run with unchanged documents, while reusing stored chunks', async () => {
      let batchEmbedCount = 0;
      let totalEmbedTexts = 0;

      const embeddingService = {
        model: 'deterministic-test-embeddings',
        dimensions: 64,
        async embed() {
          totalEmbedTexts++;
          return new Array<number>(64).fill(0.25);
        },
        async embedBatch(texts: string[]) {
          batchEmbedCount++;
          totalEmbedTexts += texts.length;
          return texts.map(() => new Array<number>(64).fill(0.25));
        },
      };

      const { InMemoryEmbeddingAdapter, MarkdownLoader, RAGPipelineBuilder } =
        await loadRagPipelineTools();

      const memoryStore = new InMemoryEmbeddingAdapter();
      const persistentStore = Object.assign(memoryStore, {
        connect: async () => ({ success: true as const, data: undefined }),
      });

      const adapter = lazilyConnected(persistentStore);

      const builder = new RAGPipelineBuilder();
      builder.withLoader(new MarkdownLoader());
      builder.withEmbeddingService(embeddingService);
      builder.withEmbeddingAdapter(adapter);
      builder.withConfig({
        chunking: { strategy: 'recursive', chunkSize: 600, chunkOverlap: 80 },
        retrieval: { strategy: 'similarity', topK: 4, threshold: 0.1 },
      });
      const pipeline = builder.build();

      const initial = await pipeline.ingest(docsDir);
      expect(initial.documents).toBe(1);
      expect(initial.chunks).toBeGreaterThan(0);
      expect(initial.unchanged).toBe(0);
      expect(batchEmbedCount).toBe(1);
      const initialEmbedTexts = totalEmbedTexts;
      expect(initialEmbedTexts).toBeGreaterThan(0);

      const second = await pipeline.ingest(docsDir);
      expect(second.documents).toBe(1);
      expect(second.chunks).toBe(0);
      expect(second.unchanged).toBe(1);
      expect(batchEmbedCount).toBe(1);
      expect(totalEmbedTexts).toBe(initialEmbedTexts);

      const searchResults = await pipeline.query('When are deployments?');
      expect(searchResults.length).toBeGreaterThan(0);
      expect(searchResults[0]?.content).toContain('Tuesday and Thursday');
    });
  });
});
