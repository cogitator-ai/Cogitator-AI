import type {
  Embedding,
  SemanticSearchOptions,
  MemoryResult,
  QdrantAdapterConfig,
  EmbeddingAdapter,
  EmbeddingDeleteFilter,
  SearchFilter,
} from '@cogitator-ai/types';
import type { QdrantClient as RestClient, Schemas } from '@qdrant/js-client-rest';
import { nanoid } from 'nanoid';
import { createHash } from 'node:crypto';
import { EMPTY_DELETE_FILTER_ERROR, hasDeleteCondition } from '../search/filter';

const POINT_ID_NAMESPACE = Buffer.from('a165b27944774045b57221d3df84e73b', 'hex');

/**
 * Qdrant only accepts unsigned integers and UUIDs as point ids, so each embedding id is mapped
 * to a name-based (version 5) UUID. The mapping is deterministic, which lets deletes address a
 * point by embedding id without a lookup; the embedding id itself travels in the payload.
 */
function qdrantPointId(embeddingId: string): string {
  const hash = createHash('sha1').update(POINT_ID_NAMESPACE).update(embeddingId).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The part of the `@qdrant/js-client-rest` client the adapter calls, typed against the real
 * client so a method the installed version does not have fails to compile.
 */
type QdrantClient = Pick<
  RestClient,
  'getCollections' | 'createCollection' | 'upsert' | 'query' | 'delete'
>;

type QdrantFilter = Schemas['Filter'];
type QdrantCondition = Schemas['Condition'];

/** A search filter as a Qdrant payload filter, undefined when it has no condition. */
function qdrantFilter(filter: SearchFilter | undefined): QdrantFilter | undefined {
  if (!filter) return undefined;
  const must: QdrantCondition[] = [];
  if (filter.sourceType) {
    must.push({ key: 'sourceType', match: { value: filter.sourceType } });
  }
  if (filter.threadId) {
    must.push({ key: 'metadata.threadId', match: { value: filter.threadId } });
  }
  if (filter.agentId) {
    must.push({ key: 'metadata.agentId', match: { value: filter.agentId } });
  }
  if (filter.userId) {
    must.push({
      should: [
        { key: 'metadata.userId', match: { value: filter.userId } },
        { is_empty: { key: 'metadata.userId' } },
      ],
    });
  }
  for (const [key, value] of Object.entries(filter.metadata ?? {})) {
    must.push({ key: `metadata.${key}`, match: { value } });
  }
  return must.length > 0 ? { must } : undefined;
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

    let qdrant: typeof import('@qdrant/js-client-rest');
    try {
      qdrant = await import('@qdrant/js-client-rest');
    } catch {
      return this.failure(
        '@qdrant/js-client-rest not installed. Run: pnpm add @qdrant/js-client-rest'
      );
    }

    try {
      const client: QdrantClient = new qdrant.QdrantClient({ url: this.url, apiKey: this.apiKey });

      const collections = await client.getCollections();
      const exists = collections.collections.some((c) => c.name === this.collection);

      if (!exists) {
        await client.createCollection(this.collection, {
          vectors: { size: this.dimensions, distance: 'Cosine' },
        });
      }

      this.client = client;
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  /** The REST client holds no connection, so disconnecting only drops it. */
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
            id: qdrantPointId(full.id),
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
      const filter = qdrantFilter(options.filter);
      const { points } = await this.client.query(this.collection, {
        query: options.vector,
        limit: options.limit ?? 10,
        score_threshold: options.threshold,
        with_payload: true,
        filter,
      });

      const embeddings: (Embedding & { score: number })[] = points.map((point) => {
        const payload: Record<string, unknown> = point.payload ?? {};
        return {
          id: typeof payload.embeddingId === 'string' ? payload.embeddingId : String(point.id),
          sourceId: payload.sourceId as string,
          sourceType: payload.sourceType as Embedding['sourceType'],
          vector: [],
          content: payload.content as string,
          createdAt: new Date(payload.createdAt as string),
          metadata: (payload.metadata as Record<string, unknown> | undefined) ?? {},
          score: point.score,
        };
      });

      return this.success(embeddings);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async deleteEmbedding(embeddingId: string): Promise<MemoryResult<void>> {
    if (!this.client) return this.failure('Not connected');

    try {
      await this.client.delete(this.collection, {
        wait: true,
        points: [qdrantPointId(embeddingId)],
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
        wait: true,
        filter: { must: [{ key: 'sourceId', match: { value: sourceId } }] },
      });
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async deleteByFilter(filter: EmbeddingDeleteFilter): Promise<MemoryResult<void>> {
    const conditions = hasDeleteCondition(filter) ? qdrantFilter(filter) : undefined;
    if (!conditions) return this.failure(EMPTY_DELETE_FILTER_ERROR);
    if (!this.client) return this.failure('Not connected');

    try {
      await this.client.delete(this.collection, { wait: true, filter: conditions });
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
