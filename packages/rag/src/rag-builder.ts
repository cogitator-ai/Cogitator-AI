import type {
  DocumentLoader,
  Chunker,
  AsyncChunker,
  EmbeddingService,
  EmbeddingAdapter,
  Retriever,
  Reranker,
  RAGPipelineConfig,
} from '@cogitator-ai/types';
import { RAGPipelineConfigSchema, type RAGPipelineConfigInput } from './schema';
import { RAGPipeline } from './rag-pipeline';
import { createChunker } from './chunkers/create-chunker';
import { SimilarityRetriever } from './retrievers/similarity-retriever';

export class RAGPipelineBuilder {
  private loader?: DocumentLoader;
  private chunker?: Chunker | AsyncChunker;
  private embeddingService?: EmbeddingService;
  private embeddingAdapter?: EmbeddingAdapter;
  private retriever?: Retriever;
  private reranker?: Reranker;
  private configInput?: RAGPipelineConfigInput;

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
      this.retriever ??
      new SimilarityRetriever({
        embeddingAdapter: this.embeddingAdapter,
        embeddingService: this.embeddingService,
      });

    return new RAGPipeline(config, {
      loader: this.loader,
      chunker,
      embeddingService: this.embeddingService,
      embeddingAdapter: this.embeddingAdapter,
      retriever,
      reranker: this.reranker,
    });
  }

  private resolveConfig(): RAGPipelineConfig {
    if (!this.configInput) {
      throw new Error('config is required — call withConfig() before build()');
    }
    return RAGPipelineConfigSchema.parse(this.configInput);
  }
}
