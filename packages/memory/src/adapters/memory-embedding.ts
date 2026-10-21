import type {
  Embedding,
  EmbeddingAdapter,
  KeywordSearchAdapter,
  KeywordSearchOptions,
  MemoryResult,
  EmbeddingDeleteFilter,
  SearchResult,
  SemanticSearchOptions,
} from '@cogitator-ai/types';
import { nanoid } from 'nanoid';
import { BM25Index } from '../search/bm25';
import {
  EMPTY_DELETE_FILTER_ERROR,
  hasDeleteCondition,
  matchesSearchFilter,
} from '../search/filter';

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

function threadOf(embedding: Embedding): string | undefined {
  const threadId = embedding.metadata?.threadId;
  return typeof threadId === 'string' ? threadId : undefined;
}

function link(index: Map<string, Set<string>>, key: string, id: string): void {
  const ids = index.get(key);
  if (ids) ids.add(id);
  else index.set(key, new Set([id]));
}

function unlink(index: Map<string, Set<string>>, key: string, id: string): void {
  const ids = index.get(key);
  ids?.delete(id);
  if (ids?.size === 0) index.delete(key);
}

/**
 * Embeddings kept in process. Each is indexed by its source and by the thread in its metadata, so
 * replacing the vector of a source and searching one thread do not scan the whole store.
 */
export class InMemoryEmbeddingAdapter implements EmbeddingAdapter, KeywordSearchAdapter {
  private embeddings = new Map<string, Embedding>();
  private bySource = new Map<string, Set<string>>();
  private byThread = new Map<string, Set<string>>();
  private bm25Index = new BM25Index();

  async addEmbedding(
    embedding: Omit<Embedding, 'id' | 'createdAt'>
  ): Promise<MemoryResult<Embedding>> {
    return { success: true, data: this.put(embedding) };
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

    for (const emb of this.candidates(options.filter?.threadId)) {
      if (!matchesSearchFilter(emb, options.filter)) {
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

      if (!matchesSearchFilter(emb, options.filter)) {
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
    this.remove(embeddingId);
    return { success: true, data: undefined };
  }

  async deleteBySource(sourceId: string): Promise<MemoryResult<void>> {
    for (const id of [...(this.bySource.get(sourceId) ?? [])]) this.remove(id);
    return { success: true, data: undefined };
  }

  /** Replaces the embeddings of the source with no await in between, so calls cannot interleave */
  async replaceBySource(
    embedding: Omit<Embedding, 'id' | 'createdAt'>
  ): Promise<MemoryResult<Embedding>> {
    for (const id of [...(this.bySource.get(embedding.sourceId) ?? [])]) this.remove(id);
    return { success: true, data: this.put(embedding) };
  }

  async getBySources(sourceIds: string[]): Promise<MemoryResult<Embedding[]>> {
    const found = [...new Set(sourceIds)].flatMap((sourceId) =>
      [...(this.bySource.get(sourceId) ?? [])].flatMap((id) => {
        const emb = this.embeddings.get(id);
        return emb ? [{ ...emb, vector: [...emb.vector] }] : [];
      })
    );
    return { success: true, data: found };
  }

  async deleteByFilter(filter: EmbeddingDeleteFilter): Promise<MemoryResult<void>> {
    if (!hasDeleteCondition(filter)) return { success: false, error: EMPTY_DELETE_FILTER_ERROR };
    for (const emb of [...this.candidates(filter.threadId)]) {
      if (matchesSearchFilter(emb, filter)) this.remove(emb.id);
    }
    return { success: true, data: undefined };
  }

  private put(embedding: Omit<Embedding, 'id' | 'createdAt'>): Embedding {
    const full: Embedding = { ...embedding, id: `emb_${nanoid(12)}`, createdAt: new Date() };
    this.embeddings.set(full.id, full);
    link(this.bySource, full.sourceId, full.id);
    const threadId = threadOf(full);
    if (threadId !== undefined) link(this.byThread, threadId, full.id);
    this.bm25Index.addDocument({ id: full.id, content: embedding.content });
    return full;
  }

  private remove(id: string): void {
    const emb = this.embeddings.get(id);
    if (!emb) return;
    this.embeddings.delete(id);
    unlink(this.bySource, emb.sourceId, id);
    const threadId = threadOf(emb);
    if (threadId !== undefined) unlink(this.byThread, threadId, id);
    this.bm25Index.removeDocument(id);
  }

  /** The embeddings a filter on `threadId` can match: that thread's, or all without one */
  private *candidates(threadId: string | undefined): Iterable<Embedding> {
    if (!threadId) {
      yield* this.embeddings.values();
      return;
    }
    for (const id of this.byThread.get(threadId) ?? []) {
      const emb = this.embeddings.get(id);
      if (emb) yield emb;
    }
  }

  get size(): number {
    return this.embeddings.size;
  }

  clear(): void {
    this.embeddings.clear();
    this.bySource.clear();
    this.byThread.clear();
    this.bm25Index.clear();
  }
}
