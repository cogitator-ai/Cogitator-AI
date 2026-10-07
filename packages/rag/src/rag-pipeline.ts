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
  SearchFilter,
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

interface PreparedDocument {
  doc: RAGDocument;
  chunks: DocumentChunk[];
  vectors: number[][];
}

/** Documents grouped by their `source`, in the order the loader returned them. */
function groupBySource(documents: RAGDocument[]): RAGDocument[][] {
  const groups = new Map<string, RAGDocument[]>();
  for (const doc of documents) {
    const group = groups.get(doc.source);
    if (group) group.push(doc);
    else groups.set(doc.source, [doc]);
  }
  return [...groups.values()];
}

export class RAGPipeline {
  private readonly config: RAGPipelineConfig;
  private readonly deps: RAGPipelineDeps;
  private stats = { documentsIngested: 0, chunksStored: 0, queriesProcessed: 0 };
  private warnedAppendOnly = false;

  constructor(config: RAGPipelineConfig, deps: RAGPipelineDeps, alreadyParsed = false) {
    this.config = alreadyParsed ? config : RAGPipelineConfigSchema.parse(config);
    this.deps = deps;
  }

  /**
   * Loads `source` and stores its chunks. Each source the loader returns documents for replaces
   * what this pipeline stored for it before, once the new chunks are embedded, so ingesting a
   * file again (or an edited file) leaves no duplicates or stale text behind.
   */
  async ingest(source: string): Promise<{ documents: number; chunks: number }> {
    const documents = await this.deps.loader.load(source);
    let totalChunks = 0;

    for (const group of groupBySource(documents)) {
      const prepared: PreparedDocument[] = [];
      for (const doc of group) {
        prepared.push(await this.prepareDocument(doc));
      }

      await this.forgetSource(group[0]!.source);
      for (const { doc, chunks, vectors } of prepared) {
        await this.storeChunks(chunks, vectors, doc);
        totalChunks += chunks.length;
        this.stats.chunksStored += chunks.length;
        this.stats.documentsIngested++;
      }
    }

    return { documents: documents.length, chunks: totalChunks };
  }

  /**
   * Deletes every chunk this pipeline stored for `source`: the `source` its results carry (for
   * files, the resolved path the loader read). Needs an embedding store with `deleteByFilter`.
   */
  async removeSource(source: string): Promise<void> {
    if (!this.deps.embeddingAdapter.deleteByFilter) {
      throw new Error(
        'removeSource needs an embedding store with deleteByFilter (every built-in store has it)'
      );
    }
    await this.forgetSource(source);
  }

  async query(text: string, options?: Partial<RetrievalConfig>): Promise<RetrievalResult[]> {
    const merged: Partial<RetrievalConfig> = {
      ...this.config.retrieval,
      ...definedEntries(options),
    };
    const results = await this.deps.retriever.retrieve(text, {
      ...merged,
      filter: this.scope(merged.filter),
    });
    this.stats.queriesProcessed++;

    if (this.deps.reranker && this.config.reranking?.enabled) {
      return this.deps.reranker.rerank(text, results, this.config.reranking.topN);
    }

    return results;
  }

  getStats() {
    return { ...this.stats };
  }

  /**
   * The filter every search of this pipeline runs with: documents only, so private memory kept
   * in a shared store (messages, facts) never comes back, and only this pipeline's namespace.
   */
  private scope(filter: SearchFilter | undefined): SearchFilter {
    const metadata = { ...filter?.metadata, ...this.namespaceMetadata() };
    return {
      ...filter,
      sourceType: 'document',
      ...(Object.keys(metadata).length > 0 && { metadata }),
    };
  }

  private namespaceMetadata(): { namespace: string } | Record<string, never> {
    return this.config.namespace === undefined ? {} : { namespace: this.config.namespace };
  }

  private async prepareDocument(doc: RAGDocument): Promise<PreparedDocument> {
    const chunks = await this.chunkDocument(doc);
    const vectors =
      chunks.length > 0
        ? await this.deps.embeddingService.embedBatch(chunks.map((c) => c.content))
        : [];
    if (vectors.length !== chunks.length) {
      throw new Error(
        `Embedding count mismatch: got ${vectors.length} vectors for ${chunks.length} chunks`
      );
    }
    return { doc, chunks, vectors };
  }

  /** Deletes the stored chunks of `source` in this pipeline's namespace, and drops them from a local index. */
  private async forgetSource(source: string): Promise<void> {
    const adapter = this.deps.embeddingAdapter;
    if (!adapter.deleteByFilter) {
      if (!this.warnedAppendOnly) {
        this.warnedAppendOnly = true;
        console.warn(
          'RAGPipeline: the embedding store has no deleteByFilter, so ingesting a source again ' +
            'adds its chunks next to the old ones instead of replacing them'
        );
      }
      return;
    }

    const result = await adapter.deleteByFilter({
      sourceType: 'document',
      metadata: { source, ...this.namespaceMetadata() },
    });
    if (!result.success) {
      throw new Error(`Could not remove the previous chunks of ${source}: ${result.error}`);
    }

    const retriever = this.deps.retriever;
    if (isChunkIndexer(retriever)) {
      retriever.removeChunks?.(
        (chunk) =>
          chunk.metadata.source === source && chunk.metadata.namespace === this.config.namespace
      );
    }
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
      ...this.namespaceMetadata(),
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
