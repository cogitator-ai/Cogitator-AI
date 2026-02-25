import type {
  Embedding,
  EmbeddingAdapter,
  KeywordSearchAdapter,
  KeywordSearchOptions,
  MemoryResult,
  SearchResult,
  SemanticSearchOptions,
} from '@cogitator-ai/types';
import { nanoid } from 'nanoid';
import { BM25Index } from '../search/bm25';

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

export class InMemoryEmbeddingAdapter implements EmbeddingAdapter, KeywordSearchAdapter {
  private embeddings = new Map<string, Embedding>();
  private bm25Index = new BM25Index();

  async addEmbedding(
    embedding: Omit<Embedding, 'id' | 'createdAt'>
  ): Promise<MemoryResult<Embedding>> {
    const id = `emb_${nanoid(12)}`;
    const now = new Date();
    const full: Embedding = { ...embedding, id, createdAt: now };

    this.embeddings.set(id, full);
    this.bm25Index.addDocument({ id, content: embedding.content });

    return { success: true, data: full };
  }

  async search(
    options: SemanticSearchOptions
  ): Promise<MemoryResult<(Embedding & { score: number })[]>> {
    if (!options.vector) {
      return { success: false, error: 'vector required for semantic search' };
    }

    const threshold = options.threshold ?? 0.7;
    const limit = options.limit ?? 10;
    const results: (Embedding & { score: number })[] = [];

    for (const emb of this.embeddings.values()) {
      if (options.filter?.sourceType && emb.sourceType !== options.filter.sourceType) {
        continue;
      }

      const score = cosineSimilarity(options.vector, emb.vector);
      if (score >= threshold) {
        results.push({ ...emb, score });
      }
    }

    return {
      success: true,
      data: results.sort((a, b) => b.score - a.score).slice(0, limit),
    };
  }

  async keywordSearch(options: KeywordSearchOptions): Promise<MemoryResult<SearchResult[]>> {
    const limit = options.limit ?? 10;
    const bm25Results = this.bm25Index.search(options.query, limit * 2);

    const results: SearchResult[] = [];
    for (const r of bm25Results) {
      const emb = this.embeddings.get(r.id);
      if (!emb) continue;

      if (options.filter?.sourceType && emb.sourceType !== options.filter.sourceType) {
        continue;
      }

      results.push({
        id: emb.id,
        sourceId: emb.sourceId,
        sourceType: emb.sourceType,
        content: emb.content,
        score: r.score,
        keywordScore: r.score,
        metadata: emb.metadata,
      });
    }

    return { success: true, data: results.slice(0, limit) };
  }

  async deleteEmbedding(embeddingId: string): Promise<MemoryResult<void>> {
    this.embeddings.delete(embeddingId);
    this.bm25Index.removeDocument(embeddingId);
    return { success: true, data: undefined };
  }

  async deleteBySource(sourceId: string): Promise<MemoryResult<void>> {
    for (const [id, emb] of this.embeddings) {
      if (emb.sourceId === sourceId) {
        this.embeddings.delete(id);
        this.bm25Index.removeDocument(id);
      }
    }
    return { success: true, data: undefined };
  }

  get size(): number {
    return this.embeddings.size;
  }

  clear(): void {
    this.embeddings.clear();
    this.bm25Index.clear();
  }
}
