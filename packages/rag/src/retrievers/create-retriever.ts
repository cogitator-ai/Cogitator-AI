import type { Retriever, EmbeddingAdapter, EmbeddingService } from '@cogitator-ai/types';
import type { HybridSearch } from '@cogitator-ai/memory';
import { SimilarityRetriever } from './similarity-retriever';
import { MMRRetriever } from './mmr-retriever';
import { HybridRetriever } from './hybrid-retriever';
import { MultiQueryRetriever } from './multi-query-retriever';

interface BaseRetrieverDeps {
  embeddingAdapter: EmbeddingAdapter;
  embeddingService: EmbeddingService;
}

interface SimilarityDeps extends BaseRetrieverDeps {
  strategy: 'similarity';
  topK?: number;
  threshold?: number;
}

interface MMRDeps extends BaseRetrieverDeps {
  strategy: 'mmr';
  lambda?: number;
  topK?: number;
  threshold?: number;
}

interface HybridDeps {
  strategy: 'hybrid';
  hybridSearch: HybridSearch;
  weights?: { bm25: number; vector: number };
  topK?: number;
  threshold?: number;
}

interface MultiQueryDeps {
  strategy: 'multi-query';
  baseRetriever: Retriever;
  expandQuery: (query: string) => Promise<string[]>;
  queryCount?: number;
}

export type CreateRetrieverConfig = SimilarityDeps | MMRDeps | HybridDeps | MultiQueryDeps;

export function createRetriever(config: CreateRetrieverConfig): Retriever {
  switch (config.strategy) {
    case 'similarity':
      return new SimilarityRetriever({
        embeddingAdapter: config.embeddingAdapter,
        embeddingService: config.embeddingService,
        defaultTopK: config.topK,
        defaultThreshold: config.threshold,
      });

    case 'mmr':
      return new MMRRetriever({
        embeddingAdapter: config.embeddingAdapter,
        embeddingService: config.embeddingService,
        defaultLambda: config.lambda,
        defaultTopK: config.topK,
        defaultThreshold: config.threshold,
      });

    case 'hybrid':
      return new HybridRetriever({
        hybridSearch: config.hybridSearch,
        defaultWeights: config.weights,
        defaultTopK: config.topK,
        defaultThreshold: config.threshold,
      });

    case 'multi-query':
      return new MultiQueryRetriever({
        baseRetriever: config.baseRetriever,
        expandQuery: config.expandQuery,
        defaultQueryCount: config.queryCount,
      });
  }
}
