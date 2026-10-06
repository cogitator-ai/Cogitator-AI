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
import { matchesSearchFilter } from './filter';
import { fuseSearchResults } from './rrf';

const DEFAULT_WEIGHTS: HybridSearchWeights = { bm25: 0.4, vector: 0.6 };
const DEFAULT_LIMIT = 10;
const OVERSAMPLE_FACTOR = 3;

export class HybridSearch {
  private embeddingAdapter: EmbeddingAdapter;
  private embeddingService: EmbeddingService;
  private keywordAdapter?: KeywordSearchAdapter;
  private localBM25: BM25Index;
  private localMetadata = new Map<string, Record<string, unknown>>();
  private defaultWeights: HybridSearchWeights;

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
      default: {
        const _exhaustive: never = options.strategy;
        return { success: false, error: `Unknown search strategy: ${_exhaustive}` };
      }
    }
  }

  /**
   * Adds a document to the local keyword index used without a `keywordAdapter`. Its `metadata`
   * lets search filters apply to it; local documents count as `sourceType: 'document'`.
   */
  indexDocument(id: string, content: string, metadata?: Record<string, unknown>): void {
    this.localBM25.addDocument({ id, content });
    if (metadata) this.localMetadata.set(id, metadata);
    else this.localMetadata.delete(id);
  }

  removeDocument(id: string): void {
    this.localBM25.removeDocument(id);
    this.localMetadata.delete(id);
  }

  clearIndex(): void {
    this.localBM25.clear();
    this.localMetadata.clear();
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

    return this.localBM25Search(options, limit);
  }

  /** Keyword search over the local index, filtered by the metadata the documents were indexed with. */
  private localBM25Search(options: SearchOptions, limit: number): MemoryResult<SearchResult[]> {
    const candidates = this.localBM25.search(
      options.query,
      options.filter ? this.localBM25.size : limit
    );

    const data: SearchResult[] = [];
    for (const r of candidates) {
      const metadata = this.localMetadata.get(r.id);
      if (!matchesSearchFilter({ sourceType: 'document', metadata }, options.filter)) continue;
      data.push({
        id: r.id,
        sourceId: r.id,
        sourceType: 'document',
        content: r.content,
        score: r.score,
        keywordScore: r.score,
        ...(metadata && { metadata }),
      });
      if (data.length >= limit) break;
    }
    return { success: true, data };
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
