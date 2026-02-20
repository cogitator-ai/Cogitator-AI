import type {
  EmbeddingAdapter,
  EmbeddingService,
  Embedding,
  Retriever,
  RetrievalConfig,
  RetrievalResult,
} from '@cogitator-ai/types';

export interface SimilarityRetrieverConfig {
  embeddingAdapter: EmbeddingAdapter;
  embeddingService: EmbeddingService;
  defaultTopK?: number;
  defaultThreshold?: number;
}

const DEFAULT_TOP_K = 10;
const DEFAULT_THRESHOLD = 0.5;

export class SimilarityRetriever implements Retriever {
  private readonly adapter: EmbeddingAdapter;
  private readonly embedding: EmbeddingService;
  private readonly defaultTopK: number;
  private readonly defaultThreshold: number;

  constructor(config: SimilarityRetrieverConfig) {
    this.adapter = config.embeddingAdapter;
    this.embedding = config.embeddingService;
    this.defaultTopK = config.defaultTopK ?? DEFAULT_TOP_K;
    this.defaultThreshold = config.defaultThreshold ?? DEFAULT_THRESHOLD;
  }

  async retrieve(query: string, options?: Partial<RetrievalConfig>): Promise<RetrievalResult[]> {
    const vector = await this.embedding.embed(query);

    const result = await this.adapter.search({
      vector,
      query,
      limit: options?.topK ?? this.defaultTopK,
      threshold: options?.threshold ?? this.defaultThreshold,
    });

    if (!result.success) {
      throw new Error(result.error);
    }

    return result.data.map((entry) => this.toRetrievalResult(entry));
  }

  private toRetrievalResult(entry: Embedding & { score: number }): RetrievalResult {
    const documentId = (entry.metadata?.documentId as string | undefined) ?? entry.sourceId;

    return {
      chunkId: entry.sourceId,
      documentId,
      content: entry.content,
      score: entry.score,
      source: entry.sourceType,
      metadata: entry.metadata,
    };
  }
}
