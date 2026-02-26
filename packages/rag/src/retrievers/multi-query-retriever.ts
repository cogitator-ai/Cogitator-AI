import type { Retriever, RetrievalConfig, RetrievalResult } from '@cogitator-ai/types';

export interface MultiQueryRetrieverConfig {
  baseRetriever: Retriever;
  expandQuery: (query: string) => Promise<string[]>;
}

const DEFAULT_TOP_K = 10;

export class MultiQueryRetriever implements Retriever {
  private readonly baseRetriever: Retriever;
  private readonly expandQuery: (query: string) => Promise<string[]>;

  constructor(config: MultiQueryRetrieverConfig) {
    this.baseRetriever = config.baseRetriever;
    this.expandQuery = config.expandQuery;
  }

  async retrieve(query: string, options?: Partial<RetrievalConfig>): Promise<RetrievalResult[]> {
    const variants = await this.expandQuery(query);

    if (variants.length === 0) return [];

    const allResults = await Promise.all(
      variants.map((variant) => this.baseRetriever.retrieve(variant, options))
    );

    const merged = this.deduplicateAndMerge(allResults.flat());
    const topK = options?.topK ?? DEFAULT_TOP_K;

    return merged.slice(0, topK);
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
