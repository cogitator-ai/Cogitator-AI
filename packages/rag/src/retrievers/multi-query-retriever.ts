import type { Retriever, RetrievalConfig, RetrievalResult } from '@cogitator-ai/types';
import { isChunkIndexer, type ChunkIndexer, type IndexedChunk } from './chunk-indexer.js';

export interface MultiQueryRetrieverConfig {
  baseRetriever: Retriever;
  expandQuery: (query: string) => Promise<string[]>;
  defaultTopK?: number;
  /** Maximum number of generated query variants used in addition to the original query. */
  defaultMaxQueries?: number;
}

const DEFAULT_TOP_K = 10;

/**
 * Expands the query into variants, retrieves for each in parallel and merges results
 * (best score per chunk). The original query is always searched. If expansion fails the
 * original query alone is used; if every retrieval fails the first error is thrown.
 */
export class MultiQueryRetriever implements Retriever, ChunkIndexer {
  private readonly baseRetriever: Retriever;
  private readonly expandQuery: (query: string) => Promise<string[]>;
  private readonly defaultTopK: number;
  private readonly defaultMaxQueries?: number;

  constructor(config: MultiQueryRetrieverConfig) {
    this.baseRetriever = config.baseRetriever;
    this.expandQuery = config.expandQuery;
    this.defaultTopK = config.defaultTopK ?? DEFAULT_TOP_K;
    this.defaultMaxQueries = config.defaultMaxQueries;
  }

  indexChunk(chunk: IndexedChunk): void {
    if (isChunkIndexer(this.baseRetriever)) {
      this.baseRetriever.indexChunk(chunk);
    }
  }

  async retrieve(query: string, options?: Partial<RetrievalConfig>): Promise<RetrievalResult[]> {
    const variants = await this.buildVariants(query, options?.multiQueryCount);

    const settled = await Promise.allSettled(
      variants.map((variant) => this.baseRetriever.retrieve(variant, options))
    );

    const fulfilled = settled.filter(
      (outcome): outcome is PromiseFulfilledResult<RetrievalResult[]> =>
        outcome.status === 'fulfilled'
    );
    if (fulfilled.length === 0) {
      const firstFailure = settled.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
      );
      throw firstFailure?.reason instanceof Error
        ? firstFailure.reason
        : new Error(`MultiQueryRetriever: all retrievals failed: ${String(firstFailure?.reason)}`);
    }

    const merged = this.deduplicateAndMerge(fulfilled.flatMap((outcome) => outcome.value));
    const topK = options?.topK ?? this.defaultTopK;

    return merged.slice(0, topK);
  }

  private async buildVariants(query: string, requestedMax?: number): Promise<string[]> {
    let expanded: string[];
    try {
      expanded = await this.expandQuery(query);
    } catch {
      expanded = [];
    }

    const normalized = query.trim().toLowerCase();
    const seen = new Set([normalized]);
    const extra: string[] = [];
    for (const variant of expanded) {
      if (typeof variant !== 'string') continue;
      const trimmed = variant.trim();
      const key = trimmed.toLowerCase();
      if (!trimmed || seen.has(key)) continue;
      seen.add(key);
      extra.push(trimmed);
    }

    const max = requestedMax ?? this.defaultMaxQueries;
    return [query, ...(max === undefined ? extra : extra.slice(0, max))];
  }

  private deduplicateAndMerge(results: RetrievalResult[]): RetrievalResult[] {
    const best = new Map<string, RetrievalResult>();

    for (const result of results) {
      const existing = best.get(result.chunkId);
      if (!existing || result.score > existing.score) {
        best.set(result.chunkId, result);
      }
    }

    return [...best.values()].sort((a, b) => b.score - a.score);
  }
}
