import type {
  EmbeddingAdapter,
  EmbeddingService,
  HybridSearchConfig,
  HybridSearchWeights,
  KeywordSearchAdapter,
  MemoryResult,
  SearchOptions,
  SearchResult,
} from '@cogitator-ai/types';
import { BM25Index } from './bm25';
import { fuseSearchResults } from './rrf';

const DEFAULT_WEIGHTS: HybridSearchWeights = { bm25: 0.4, vector: 0.6 };
const DEFAULT_LIMIT = 10;
const OVERSAMPLE_FACTOR = 3;

export class HybridSearch {
  private embeddingAdapter: EmbeddingAdapter;
  private embeddingService: EmbeddingService;
  private keywordAdapter?: KeywordSearchAdapter;
  private localBM25: BM25Index;
  private defaultWeights: HybridSearchWeights;
  private indexedIds = new Set<string>();

  constructor(config: HybridSearchConfig) {
    this.embeddingAdapter = config.embeddingAdapter;
    this.embeddingService = config.embeddingService;
    this.keywordAdapter = config.keywordAdapter;
    this.defaultWeights = config.defaultWeights ?? DEFAULT_WEIGHTS;
    this.localBM25 = new BM25Index();
  }

  async search(options: SearchOptions): Promise<MemoryResult<SearchResult[]>> {
    const weights = options.weights ?? this.defaultWeights;
    const limit = options.limit ?? DEFAULT_LIMIT;

    switch (options.strategy) {
      case 'vector':
        return this.vectorSearch(options, limit);
      case 'keyword':
        return this.keywordSearch(options, limit);
      case 'hybrid':
        return this.hybridSearch(options, weights, limit);
    }
  }

  indexDocument(id: string, content: string): void {
    this.localBM25.addDocument({ id, content });
    this.indexedIds.add(id);
  }

  removeDocument(id: string): void {
    this.localBM25.removeDocument(id);
    this.indexedIds.delete(id);
  }

  clearIndex(): void {
    this.localBM25.clear();
    this.indexedIds.clear();
  }

  get indexSize(): number {
    return this.localBM25.size;
  }

  private async vectorSearch(
    options: SearchOptions,
    limit: number
  ): Promise<MemoryResult<SearchResult[]>> {
    const vector = await this.embeddingService.embed(options.query);

    const result = await this.embeddingAdapter.search({
      vector,
      limit,
      threshold: options.threshold,
      filter: options.filter,
    });

    if (!result.success) return result;

    return {
      success: true,
      data: result.data.map((emb) => ({
        id: emb.id,
        sourceId: emb.sourceId,
        sourceType: emb.sourceType,
        content: emb.content,
        score: emb.score,
        vectorScore: emb.score,
        metadata: emb.metadata,
      })),
    };
  }

  private async keywordSearch(
    options: SearchOptions,
    limit: number
  ): Promise<MemoryResult<SearchResult[]>> {
    if (this.keywordAdapter) {
      return this.keywordAdapter.keywordSearch({
        query: options.query,
        limit,
        filter: options.filter,
      });
    }

    return this.localBM25Search(options.query, limit);
  }

  private localBM25Search(query: string, limit: number): MemoryResult<SearchResult[]> {
    const results = this.localBM25.search(query, limit);

    return {
      success: true,
      data: results.map((r) => ({
        id: r.id,
        sourceId: r.id,
        sourceType: 'document' as const,
        content: r.content,
        score: r.score,
        keywordScore: r.score,
      })),
    };
  }

  private async hybridSearch(
    options: SearchOptions,
    weights: HybridSearchWeights,
    limit: number
  ): Promise<MemoryResult<SearchResult[]>> {
    const expandedLimit = limit * OVERSAMPLE_FACTOR;

    const [vectorResult, keywordResult] = await Promise.all([
      this.vectorSearch({ ...options, limit: expandedLimit }, expandedLimit),
      this.keywordSearch({ ...options, limit: expandedLimit }, expandedLimit),
    ]);

    if (!vectorResult.success) return vectorResult;
    if (!keywordResult.success) return keywordResult;

    const fused = fuseSearchResults(vectorResult.data, keywordResult.data, weights);

    return { success: true, data: fused.slice(0, limit) };
  }
}
