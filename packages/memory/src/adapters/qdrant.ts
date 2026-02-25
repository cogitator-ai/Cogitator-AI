import type {
  Embedding,
  SemanticSearchOptions,
  MemoryResult,
  QdrantAdapterConfig,
  EmbeddingAdapter,
} from '@cogitator-ai/types';
import { nanoid } from 'nanoid';

interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

interface QdrantSearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

interface QdrantFilter {
  must?: Array<{ key: string; match: { value: unknown } }>;
}

interface QdrantClient {
  getCollections(): Promise<{ collections: Array<{ name: string }> }>;
  createCollection(
    name: string,
    config: { vectors: { size: number; distance: string } }
  ): Promise<void>;
  upsert(collection: string, options: { points: QdrantPoint[] }): Promise<void>;
  search(
    collection: string,
    options: {
      vector: number[];
      limit: number;
      score_threshold?: number;
      filter?: QdrantFilter;
    }
  ): Promise<QdrantSearchResult[]>;
  delete(collection: string, options: { points?: string[]; filter?: QdrantFilter }): Promise<void>;
}

export class QdrantAdapter implements EmbeddingAdapter {
  private client: QdrantClient | null = null;
  private url: string;
  private apiKey?: string;
  private collection: string;
  private dimensions: number;

  constructor(config: QdrantAdapterConfig) {
    this.url = config.url ?? 'http://localhost:6333';
    this.apiKey = config.apiKey;
    this.collection = config.collection ?? 'cogitator';
    this.dimensions = config.dimensions;
  }

  async connect(): Promise<MemoryResult<void>> {
    if (this.client) return this.success(undefined);

    let QdrantClient: new (options: { url: string; apiKey?: string }) => QdrantClient;
    try {
      const qdrant = await import('@qdrant/js-client-rest');
      QdrantClient = qdrant.QdrantClient as unknown as new (options: {
        url: string;
        apiKey?: string;
      }) => QdrantClient;
    } catch {
      return this.failure(
        '@qdrant/js-client-rest not installed. Run: pnpm add @qdrant/js-client-rest'
      );
    }

    try {
      this.client = new QdrantClient({ url: this.url, apiKey: this.apiKey });

      const collections = await this.client.getCollections();
      const exists = collections.collections.some((c) => c.name === this.collection);

      if (!exists) {
        await this.client.createCollection(this.collection, {
          vectors: { size: this.dimensions, distance: 'Cosine' },
        });
      }

      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async disconnect(): Promise<MemoryResult<void>> {
    this.client = null;
    return this.success(undefined);
  }

  async addEmbedding(
    embedding: Omit<Embedding, 'id' | 'createdAt'>
  ): Promise<MemoryResult<Embedding>> {
    if (!this.client) return this.failure('Not connected');

    const full: Embedding = {
      ...embedding,
      id: `emb_${nanoid(12)}`,
      createdAt: new Date(),
    };

    try {
      await this.client.upsert(this.collection, {
        points: [
          {
            id: full.id,
            vector: full.vector,
            payload: {
              embeddingId: full.id,
              sourceId: full.sourceId,
              sourceType: full.sourceType,
              content: full.content,
              createdAt: full.createdAt.toISOString(),
              metadata: full.metadata ?? {},
            },
          },
        ],
      });
      return this.success(full);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async search(
    options: SemanticSearchOptions
  ): Promise<MemoryResult<(Embedding & { score: number })[]>> {
    if (!this.client) return this.failure('Not connected');

    if (!options.vector) {
      return this.failure('vector is required for Qdrant search');
    }

    try {
      const filter: { must?: Array<{ key: string; match: { value: unknown } }> } = {};
      if (options.filter) {
        filter.must = [];
        if (options.filter.sourceType) {
          filter.must.push({ key: 'sourceType', match: { value: options.filter.sourceType } });
        }
        if (options.filter.threadId) {
          filter.must.push({ key: 'threadId', match: { value: options.filter.threadId } });
        }
        if (options.filter.agentId) {
          filter.must.push({ key: 'agentId', match: { value: options.filter.agentId } });
        }
      }

      const results = await this.client.search(this.collection, {
        vector: options.vector,
        limit: options.limit ?? 10,
        score_threshold: options.threshold,
        filter: filter.must?.length ? filter : undefined,
      });

      const embeddings: (Embedding & { score: number })[] = results.map((r) => ({
        id: (r.payload.embeddingId as string) ?? r.id,
        sourceId: r.payload.sourceId as string,
        sourceType: r.payload.sourceType as Embedding['sourceType'],
        vector: [],
        content: r.payload.content as string,
        createdAt: new Date(r.payload.createdAt as string),
        metadata: (r.payload.metadata as Record<string, unknown>) ?? {},
        score: r.score,
      }));

      return this.success(embeddings);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async deleteEmbedding(embeddingId: string): Promise<MemoryResult<void>> {
    if (!this.client) return this.failure('Not connected');

    try {
      await this.client.delete(this.collection, {
        points: [embeddingId],
      });
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async deleteBySource(sourceId: string): Promise<MemoryResult<void>> {
    if (!this.client) return this.failure('Not connected');

    try {
      await this.client.delete(this.collection, {
        filter: { must: [{ key: 'sourceId', match: { value: sourceId } }] },
      });
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  private success<T>(data: T): MemoryResult<T> {
    return { success: true, data };
  }

  private failure(error: string): MemoryResult<never> {
    return { success: false, error };
  }
}
