import type {
  Retriever,
  RetrievalConfig,
  RetrievalResult,
  HybridSearchWeights,
  SearchResult,
} from '@cogitator-ai/types';
import type { HybridSearch } from '@cogitator-ai/memory';

export interface HybridRetrieverConfig {
  hybridSearch: HybridSearch;
  defaultWeights?: HybridSearchWeights;
  defaultTopK?: number;
  defaultThreshold?: number;
}

const DEFAULT_TOP_K = 10;
const DEFAULT_THRESHOLD = 0.0;

export class HybridRetriever implements Retriever {
  private readonly hybridSearch: HybridSearch;
  private readonly defaultWeights?: HybridSearchWeights;
  private readonly defaultTopK: number;
  private readonly defaultThreshold: number;

  constructor(config: HybridRetrieverConfig) {
    this.hybridSearch = config.hybridSearch;
    this.defaultWeights = config.defaultWeights;
    this.defaultTopK = config.defaultTopK ?? DEFAULT_TOP_K;
    this.defaultThreshold = config.defaultThreshold ?? DEFAULT_THRESHOLD;
  }

  async retrieve(query: string, options?: Partial<RetrievalConfig>): Promise<RetrievalResult[]> {
    const result = await this.hybridSearch.search({
      query,
      strategy: 'hybrid',
      weights: this.defaultWeights,
      limit: options?.topK ?? this.defaultTopK,
      threshold: options?.threshold ?? this.defaultThreshold,
    });

    if (!result.success) {
      throw new Error(result.error);
    }

    return result.data.map((entry) => this.toRetrievalResult(entry));
  }

  private toRetrievalResult(entry: SearchResult): RetrievalResult {
    const rawDocId = entry.metadata?.documentId;
    const documentId = typeof rawDocId === 'string' ? rawDocId : entry.sourceId;

    return {
      chunkId: entry.sourceId,
      documentId,
      content: entry.content,
      score: entry.score,
      source: entry.sourceType,
      metadata: {
        ...entry.metadata,
        vectorScore: entry.vectorScore,
        keywordScore: entry.keywordScore,
      },
    };
  }
}
