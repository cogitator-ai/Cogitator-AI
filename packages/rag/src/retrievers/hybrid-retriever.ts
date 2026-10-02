import type {
  Retriever,
  RetrievalConfig,
  RetrievalResult,
  HybridSearchWeights,
  SearchResult,
} from '@cogitator-ai/types';
import type { HybridSearch } from '@cogitator-ai/memory';
import { resultSource, type ChunkIndexer, type IndexedChunk } from './chunk-indexer.js';

export interface HybridRetrieverConfig {
  hybridSearch: HybridSearch;
  defaultWeights?: HybridSearchWeights;
  defaultTopK?: number;
  defaultThreshold?: number;
}

const DEFAULT_TOP_K = 10;
const DEFAULT_THRESHOLD = 0.0;

/**
 * Vector + BM25 retrieval fused with reciprocal rank fusion. Chunks ingested through
 * `RAGPipeline` are added to the HybridSearch keyword index automatically.
 */
export class HybridRetriever implements Retriever, ChunkIndexer {
  private readonly hybridSearch: HybridSearch;
  private readonly defaultWeights?: HybridSearchWeights;
  private readonly defaultTopK: number;
  private readonly defaultThreshold: number;
  private readonly indexed = new Map<string, IndexedChunk>();

  constructor(config: HybridRetrieverConfig) {
    this.hybridSearch = config.hybridSearch;
    this.defaultWeights = config.defaultWeights;
    this.defaultTopK = config.defaultTopK ?? DEFAULT_TOP_K;
    this.defaultThreshold = config.defaultThreshold ?? DEFAULT_THRESHOLD;
  }

  indexChunk(chunk: IndexedChunk): void {
    this.indexed.set(chunk.embeddingId, chunk);
    this.hybridSearch.indexDocument(chunk.embeddingId, chunk.content);
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
    const known = this.indexed.get(entry.id);
    const metadata = { ...known?.metadata, ...entry.metadata };
    const rawDocId = metadata.documentId;
    const chunkId = known?.chunkId ?? entry.sourceId;
    const documentId = typeof rawDocId === 'string' ? rawDocId : chunkId;

    return {
      chunkId,
      documentId,
      content: entry.content,
      score: entry.score,
      source: resultSource(metadata, entry.sourceType),
      metadata: {
        ...metadata,
        vectorScore: entry.vectorScore,
        keywordScore: entry.keywordScore,
      },
    };
  }
}
