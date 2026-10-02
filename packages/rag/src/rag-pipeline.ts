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
import { RAGPipelineConfigSchema } from './schema.js';
import { isChunkIndexer } from './retrievers/chunk-indexer.js';

export interface RAGPipelineDeps {
  loader: DocumentLoader;
  chunker: Chunker | AsyncChunker;
  embeddingService: EmbeddingService;
  embeddingAdapter: EmbeddingAdapter;
  retriever: Retriever;
  reranker?: Reranker;
}

const STORE_CONCURRENCY = 16;

function definedEntries<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export class RAGPipeline {
  private readonly config: RAGPipelineConfig;
  private readonly deps: RAGPipelineDeps;
  private stats = { documentsIngested: 0, chunksStored: 0, queriesProcessed: 0 };

  constructor(config: RAGPipelineConfig, deps: RAGPipelineDeps, alreadyParsed = false) {
    this.config = alreadyParsed ? config : RAGPipelineConfigSchema.parse(config);
    this.deps = deps;
  }

  async ingest(source: string): Promise<{ documents: number; chunks: number }> {
    const documents = await this.deps.loader.load(source);
    let totalChunks = 0;
    let ingestedDocuments = 0;

    for (const doc of documents) {
      const chunks = await this.chunkDocument(doc);
      if (chunks.length > 0) {
        const vectors = await this.deps.embeddingService.embedBatch(chunks.map((c) => c.content));

        if (vectors.length !== chunks.length) {
          throw new Error(
            `Embedding count mismatch: got ${vectors.length} vectors for ${chunks.length} chunks`
          );
        }

        await this.storeChunks(chunks, vectors, doc);
        totalChunks += chunks.length;
        this.stats.chunksStored += chunks.length;
      }
      ingestedDocuments++;
      this.stats.documentsIngested++;
    }

    return { documents: ingestedDocuments, chunks: totalChunks };
  }

  async query(text: string, options?: Partial<RetrievalConfig>): Promise<RetrievalResult[]> {
    const merged: Partial<RetrievalConfig> = {
      ...this.config.retrieval,
      ...definedEntries(options),
    };
    const results = await this.deps.retriever.retrieve(text, merged);
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
    const chunks = await this.deps.chunker.chunk(doc.content, doc.id);
    return chunks.filter((chunk) => chunk.content.trim().length > 0);
  }

  private async storeChunks(
    chunks: DocumentChunk[],
    vectors: number[][],
    doc: RAGDocument
  ): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const index = next++;
        await this.storeChunk(chunks[index]!, vectors[index]!, doc);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(STORE_CONCURRENCY, chunks.length) }, () => worker())
    );
  }

  private async storeChunk(chunk: DocumentChunk, vector: number[], doc: RAGDocument) {
    const metadata: Record<string, unknown> = {
      ...doc.metadata,
      ...chunk.metadata,
      documentId: doc.id,
      source: doc.source,
      sourceType: doc.sourceType,
      order: chunk.order,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
    };

    const result = await this.deps.embeddingAdapter.addEmbedding({
      sourceId: chunk.id,
      sourceType: 'document',
      vector,
      content: chunk.content,
      metadata,
    });

    if (!result.success) {
      throw new Error(result.error);
    }

    if (isChunkIndexer(this.deps.retriever)) {
      this.deps.retriever.indexChunk({
        embeddingId: result.data.id,
        chunkId: chunk.id,
        documentId: doc.id,
        content: chunk.content,
        metadata,
      });
    }
  }
}
