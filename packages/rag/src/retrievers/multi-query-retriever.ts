import type { Retriever, RetrievalConfig, RetrievalResult } from '@cogitator-ai/types';

export interface MultiQueryRetrieverConfig {
  baseRetriever: Retriever;
  expandQuery: (query: string) => Promise<string[]>;
  defaultTopK?: number;
}

const DEFAULT_TOP_K = 10;

export class MultiQueryRetriever implements Retriever {
  private readonly baseRetriever: Retriever;
  private readonly expandQuery: (query: string) => Promise<string[]>;
  private readonly defaultTopK: number;

  constructor(config: MultiQueryRetrieverConfig) {
    this.baseRetriever = config.baseRetriever;
    this.expandQuery = config.expandQuery;
    this.defaultTopK = config.defaultTopK ?? DEFAULT_TOP_K;
  }

  async retrieve(query: string, options?: Partial<RetrievalConfig>): Promise<RetrievalResult[]> {
    const expanded = await this.expandQuery(query);
    const variants = expanded.length > 0 ? expanded : [query];

    if (!variants.includes(query)) {
      variants.unshift(query);
    }

    const settled = await Promise.allSettled(
      variants.map((variant) => this.baseRetriever.retrieve(variant, options))
    );

    const allResults = settled.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? outcome.value : []
    );

    const merged = this.deduplicateAndMerge(allResults.flat());
    const topK = options?.topK ?? this.defaultTopK;

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
