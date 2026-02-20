import type {
  DocumentLoader,
  Chunker,
  AsyncChunker,
  EmbeddingService,
  EmbeddingAdapter,
  Retriever,
  Reranker,
  RAGPipelineConfig,
  RetrievalConfig,
  RetrievalResult,
  DocumentChunk,
  RAGDocument,
} from '@cogitator-ai/types';
import { RAGPipelineConfigSchema } from './schema';

export interface RAGPipelineDeps {
  loader: DocumentLoader;
  chunker: Chunker | AsyncChunker;
  embeddingService: EmbeddingService;
  embeddingAdapter: EmbeddingAdapter;
  retriever: Retriever;
  reranker?: Reranker;
}

export class RAGPipeline {
  private readonly config: RAGPipelineConfig;
  private readonly deps: RAGPipelineDeps;
  private stats = { documentsIngested: 0, chunksStored: 0, queriesProcessed: 0 };

  constructor(config: RAGPipelineConfig, deps: RAGPipelineDeps) {
    this.config = RAGPipelineConfigSchema.parse(config);
    this.deps = deps;
  }

  async ingest(source: string): Promise<{ documents: number; chunks: number }> {
    const documents = await this.deps.loader.load(source);
    let totalChunks = 0;

    for (const doc of documents) {
      const chunks = await this.chunkDocument(doc);
      const texts = chunks.map((c) => c.content);
      const vectors = await this.deps.embeddingService.embedBatch(texts);

      for (let i = 0; i < chunks.length; i++) {
        await this.storeChunk(chunks[i], vectors[i], doc);
      }

      totalChunks += chunks.length;
    }

    this.stats.documentsIngested += documents.length;
    this.stats.chunksStored += totalChunks;

    return { documents: documents.length, chunks: totalChunks };
  }

  async query(text: string, options?: Partial<RetrievalConfig>): Promise<RetrievalResult[]> {
    const results = await this.deps.retriever.retrieve(text, options);
    this.stats.queriesProcessed++;

    if (this.deps.reranker && this.config.reranking?.enabled) {
      return this.deps.reranker.rerank(text, results, this.config.reranking.topN);
    }

    return results;
  }

  getStats() {
    return { ...this.stats };
  }

  private async chunkDocument(doc: RAGDocument): Promise<DocumentChunk[]> {
    const result = this.deps.chunker.chunk(doc.content, doc.id);
    return result instanceof Promise ? result : result;
  }

  private async storeChunk(chunk: DocumentChunk, vector: number[], doc: RAGDocument) {
    const result = await this.deps.embeddingAdapter.addEmbedding({
      sourceId: chunk.id,
      sourceType: 'document',
      vector,
      content: chunk.content,
      metadata: {
        ...chunk.metadata,
        documentId: doc.id,
        source: doc.source,
        order: chunk.order,
      },
    });

    if (!result.success) {
      throw new Error(result.error);
    }
  }
}
