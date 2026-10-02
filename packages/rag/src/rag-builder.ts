import type {
  DocumentLoader,
  Chunker,
  AsyncChunker,
  EmbeddingService,
  EmbeddingAdapter,
  Retriever,
  Reranker,
  RAGPipelineConfig,
  HybridSearchWeights,
} from '@cogitator-ai/types';
import type { HybridSearch } from '@cogitator-ai/memory';
import { RAGPipelineConfigSchema, type RAGPipelineConfigInput } from './schema.js';
import { RAGPipeline } from './rag-pipeline.js';
import { createChunker } from './chunkers/create-chunker.js';
import { SimilarityRetriever } from './retrievers/similarity-retriever.js';
import { MMRRetriever } from './retrievers/mmr-retriever.js';
import { HybridRetriever } from './retrievers/hybrid-retriever.js';
import { MultiQueryRetriever } from './retrievers/multi-query-retriever.js';

export class RAGPipelineBuilder {
  private loader?: DocumentLoader;
  private chunker?: Chunker | AsyncChunker;
  private embeddingService?: EmbeddingService;
  private embeddingAdapter?: EmbeddingAdapter;
  private retriever?: Retriever;
  private reranker?: Reranker;
  private configInput?: RAGPipelineConfigInput;
  private hybridSearch?: HybridSearch;
  private hybridWeights?: HybridSearchWeights;
  private queryExpander?: (query: string) => Promise<string[]>;

  withLoader(loader: DocumentLoader): this {
    this.loader = loader;
    return this;
  }

  withChunker(chunker: Chunker | AsyncChunker): this {
    this.chunker = chunker;
    return this;
  }

  withEmbeddingService(service: EmbeddingService): this {
    this.embeddingService = service;
    return this;
  }

  withEmbeddingAdapter(adapter: EmbeddingAdapter): this {
    this.embeddingAdapter = adapter;
    return this;
  }

  withRetriever(retriever: Retriever): this {
    this.retriever = retriever;
    return this;
  }

  withReranker(reranker: Reranker): this {
    this.reranker = reranker;
    return this;
  }

  /** HybridSearch used by the `hybrid` strategy (and as the multi-query base when set). */
  withHybridSearch(hybridSearch: HybridSearch, weights?: HybridSearchWeights): this {
    this.hybridSearch = hybridSearch;
    this.hybridWeights = weights;
    return this;
  }

  /** Query expansion function used by the `multi-query` strategy. */
  withQueryExpander(expandQuery: (query: string) => Promise<string[]>): this {
    this.queryExpander = expandQuery;
    return this;
  }

  withConfig(config: RAGPipelineConfigInput): this {
    this.configInput = config;
    return this;
  }

  build(): RAGPipeline {
    if (!this.loader) {
      throw new Error('loader is required — call withLoader() before build()');
    }
    if (!this.embeddingService) {
      throw new Error('embeddingService is required — call withEmbeddingService() before build()');
    }
    if (!this.embeddingAdapter) {
      throw new Error('embeddingAdapter is required — call withEmbeddingAdapter() before build()');
    }

    const config = this.resolveConfig();
    const chunker = this.chunker ?? createChunker(config.chunking, this.embeddingService);
    const retriever =
      this.retriever ?? this.createRetriever(config, this.embeddingService, this.embeddingAdapter);

    return new RAGPipeline(
      config,
      {
        loader: this.loader,
        chunker,
        embeddingService: this.embeddingService,
        embeddingAdapter: this.embeddingAdapter,
        retriever,
        reranker: this.reranker,
      },
      true
    );
  }

  private createRetriever(
    config: RAGPipelineConfig,
    embeddingService: EmbeddingService,
    embeddingAdapter: EmbeddingAdapter
  ): Retriever {
    const { retrieval } = config;
    const vectorRetriever = (): Retriever =>
      this.hybridSearch
        ? new HybridRetriever({
            hybridSearch: this.hybridSearch,
            defaultWeights: this.hybridWeights,
            defaultTopK: retrieval.topK,
            defaultThreshold: retrieval.threshold,
          })
        : new SimilarityRetriever({
            embeddingAdapter,
            embeddingService,
            defaultTopK: retrieval.topK,
            defaultThreshold: retrieval.threshold,
          });

    switch (retrieval.strategy) {
      case 'similarity':
        return new SimilarityRetriever({
          embeddingAdapter,
          embeddingService,
          defaultTopK: retrieval.topK,
          defaultThreshold: retrieval.threshold,
        });

      case 'mmr':
        return new MMRRetriever({
          embeddingAdapter,
          embeddingService,
          defaultLambda: retrieval.mmrLambda,
          defaultTopK: retrieval.topK,
          defaultThreshold: retrieval.threshold,
        });

      case 'hybrid':
        if (!this.hybridSearch) {
          throw new Error(
            'retrieval strategy "hybrid" requires withHybridSearch() (or a custom withRetriever())'
          );
        }
        return vectorRetriever();

      case 'multi-query':
        if (!this.queryExpander) {
          throw new Error(
            'retrieval strategy "multi-query" requires withQueryExpander() (or a custom withRetriever())'
          );
        }
        return new MultiQueryRetriever({
          baseRetriever: vectorRetriever(),
          expandQuery: this.queryExpander,
          defaultTopK: retrieval.topK,
          defaultMaxQueries: retrieval.multiQueryCount,
        });

      default: {
        const exhaustive: never = retrieval.strategy;
        throw new Error(`Unknown retrieval strategy: ${String(exhaustive)}`);
      }
    }
  }

  private resolveConfig(): RAGPipelineConfig {
    if (!this.configInput) {
      throw new Error('config is required — call withConfig() before build()');
    }
    return RAGPipelineConfigSchema.parse(this.configInput);
  }
}
