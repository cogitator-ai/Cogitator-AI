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
  Embedding,
} from '@cogitator-ai/types';
import { createHash, randomUUID } from 'node:crypto';
import { RAGPipelineConfigSchema } from './schema.js';
import { isChunkIndexer } from './retrievers/chunk-indexer.js';
import { chunkId } from './chunkers/chunk-id.js';

export interface RAGPipelineDeps {
  loader: DocumentLoader;
  chunker: Chunker | AsyncChunker;
  embeddingService: EmbeddingService;
  embeddingAdapter: EmbeddingAdapter;
  retriever: Retriever;
  reranker?: Reranker;
}

const STORE_CONCURRENCY = 16;

/** Raised when what the content hash covers changes, so every document is embedded again */
const HASH_VERSION = 1;

/** Source ids one `getBySources` call reads */
const LOOKUP_BATCH = 500;

function definedEntries<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

interface PreparedDocument {
  doc: RAGDocument;
  chunks: DocumentChunk[];
  vectors: number[][];
}

/** What a stored chunk says about the ingest that wrote it */
interface StoredChunk {
  documentId: string;
  /** Hash of the document and settings its chunks were made from */
  hash?: string;
  /** The ingest that wrote it; chunks stored before generations have none */
  generation?: string;
  /** How many documents its source had */
  documents?: number;
  vector: number[];
}

/** What one ingest writes into every chunk, so the next one can tell what changed */
interface IngestMarks {
  contentHash: string;
  generation: string;
  sourceDocuments: number;
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
   * what this pipeline stored for it before, so ingesting a file again (or an edited file) leaves
   * no duplicates or stale text behind.
   *
   * A source whose documents, chunking and embedding model did not change since the last ingest
   * is left as stored, without embedding anything (`unchanged` counts its documents). A changed
   * source is written as a new generation before the previous one is deleted, so searches never
   * find it empty: the chunks of its unchanged documents keep their vectors. That needs a store
   * with `getBySources` and `deleteByFilter`, which every built-in store has. Chunks stored before
   * generations, or a store without them, are replaced as before: deleted, then written again.
   */
  async ingest(source: string): Promise<{ documents: number; chunks: number; unchanged: number }> {
    const documents = await this.deps.loader.load(source);
    let totalChunks = 0;
    let unchanged = 0;

    for (const group of groupBySource(documents)) {
      const hashes = new Map(group.map((doc) => [doc.id, this.contentHash(doc)]));
      const heads = await this.storedChunks(group.map((doc) => chunkId(doc.id, 0)));
      const previous = this.previousGeneration(group, hashes, heads);
      if (previous.unchanged) {
        unchanged += group.length;
        continue;
      }

      const prepared: PreparedDocument[] = [];
      for (const doc of group) {
        const reusable = heads
          .get(chunkId(doc.id, 0))
          ?.find((head) => head.generation !== undefined && head.hash === hashes.get(doc.id));
        prepared.push(await this.prepareDocument(doc, reusable));
      }

      const sourceName = group[0]!.source;
      if (!previous.generations) await this.forgetSource(sourceName);
      const generation = randomUUID();
      for (const { doc, chunks, vectors } of prepared) {
        await this.storeChunks(chunks, vectors, doc, {
          contentHash: hashes.get(doc.id)!,
          generation,
          sourceDocuments: group.length,
        });
        totalChunks += chunks.length;
        this.stats.chunksStored += chunks.length;
        this.stats.documentsIngested++;
      }
      for (const old of previous.generations ?? []) {
        await this.forgetGeneration(sourceName, old);
      }
    }

    return { documents: documents.length, chunks: totalChunks, unchanged };
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

  /**
   * Hash of what a document's chunks are made from: its text, source and metadata, the chunking
   * settings and the embedding model
   */
  private contentHash(doc: RAGDocument): string {
    const { embeddingService } = this.deps;
    return createHash('sha256')
      .update(
        JSON.stringify([
          HASH_VERSION,
          doc.content,
          doc.source,
          doc.sourceType,
          doc.metadata ?? {},
          this.config.chunking,
          embeddingService.model,
          embeddingService.dimensions,
        ])
      )
      .digest('hex');
  }

  /**
   * The stored chunks of this pipeline's namespace with these ids, by id: more than one for an id
   * when an ingest stopped before deleting the generation it replaced. Empty when the store cannot
   * read chunks by id.
   */
  private async storedChunks(ids: string[]): Promise<Map<string, StoredChunk[]>> {
    const found = new Map<string, StoredChunk[]>();
    const adapter = this.deps.embeddingAdapter;
    if (!adapter.getBySources) return found;
    for (let start = 0; start < ids.length; start += LOOKUP_BATCH) {
      const result = await adapter.getBySources(ids.slice(start, start + LOOKUP_BATCH));
      if (!result.success) {
        throw new Error(`Could not read the stored chunks: ${result.error}`);
      }
      for (const embedding of result.data) {
        const chunk = this.ownChunk(embedding);
        if (chunk) found.set(embedding.sourceId, [...(found.get(embedding.sourceId) ?? []), chunk]);
      }
    }
    return found;
  }

  private ownChunk(embedding: Embedding): StoredChunk | undefined {
    const metadata = embedding.metadata ?? {};
    if (embedding.sourceType !== 'document' || metadata.namespace !== this.config.namespace) {
      return undefined;
    }
    return {
      documentId: String(metadata.documentId),
      vector: embedding.vector,
      ...(typeof metadata.contentHash === 'string' && { hash: metadata.contentHash }),
      ...(typeof metadata.generation === 'string' && { generation: metadata.generation }),
      ...(typeof metadata.sourceDocuments === 'number' && {
        documents: metadata.sourceDocuments,
      }),
    };
  }

  /**
   * What the last ingest left of a source: whether it is unchanged, and the generations to delete
   * once a new one is written. No `generations` when the source has to be cleared first: nothing
   * of it was found by id, or it was stored before generations.
   */
  private previousGeneration(
    group: RAGDocument[],
    hashes: Map<string, string>,
    heads: Map<string, StoredChunk[]>
  ): { unchanged: boolean; generations?: string[] } {
    const found = group.flatMap((doc) =>
      (heads.get(chunkId(doc.id, 0)) ?? []).map((head) => ({ doc, head }))
    );
    if (found.length === 0 || found.some(({ head }) => head.generation === undefined)) {
      return { unchanged: false };
    }
    const generations = [...new Set(found.map(({ head }) => head.generation!))];
    const unchanged =
      found.length === group.length &&
      generations.length === 1 &&
      found.every(
        ({ doc, head }) => head.hash === hashes.get(doc.id) && head.documents === group.length
      );
    return { unchanged, generations };
  }

  private async prepareDocument(
    doc: RAGDocument,
    unchangedHead?: StoredChunk
  ): Promise<PreparedDocument> {
    const chunks = await this.chunkDocument(doc);
    const kept = unchangedHead ? await this.keptVectors(chunks, unchangedHead) : undefined;
    const vectors =
      kept ??
      (chunks.length > 0
        ? await this.deps.embeddingService.embedBatch(chunks.map((c) => c.content))
        : []);
    if (vectors.length !== chunks.length) {
      throw new Error(
        `Embedding count mismatch: got ${vectors.length} vectors for ${chunks.length} chunks`
      );
    }
    return { doc, chunks, vectors };
  }

  /**
   * The stored vectors of an unchanged document's chunks, in their order, when the store keeps
   * all of them from the same ingest
   */
  private async keptVectors(
    chunks: DocumentChunk[],
    head: StoredChunk
  ): Promise<number[][] | undefined> {
    const stored = await this.storedChunks(chunks.map((chunk) => chunk.id));
    const vectors: number[][] = [];
    for (const chunk of chunks) {
      const kept = stored
        .get(chunk.id)
        ?.find(
          (candidate) => candidate.generation === head.generation && candidate.hash === head.hash
        );
      if (!kept) return undefined;
      if (kept.vector.length !== this.deps.embeddingService.dimensions) return undefined;
      vectors.push(kept.vector);
    }
    return vectors;
  }

  /** Deletes the chunks of `source` an earlier ingest wrote as `generation` */
  private async forgetGeneration(source: string, generation: string): Promise<void> {
    const adapter = this.deps.embeddingAdapter;
    if (!adapter.deleteByFilter) return;
    const result = await adapter.deleteByFilter({
      sourceType: 'document',
      metadata: { source, generation, ...this.namespaceMetadata() },
    });
    if (!result.success) {
      throw new Error(`Could not remove the previous chunks of ${source}: ${result.error}`);
    }
    const retriever = this.deps.retriever;
    if (isChunkIndexer(retriever)) {
      retriever.removeChunks?.(
        (chunk) =>
          chunk.metadata.source === source &&
          chunk.metadata.generation === generation &&
          chunk.metadata.namespace === this.config.namespace
      );
    }
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
    doc: RAGDocument,
    marks: IngestMarks
  ): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const index = next++;
        await this.storeChunk(chunks[index]!, vectors[index]!, doc, marks);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(STORE_CONCURRENCY, chunks.length) }, () => worker())
    );
  }

  private async storeChunk(
    chunk: DocumentChunk,
    vector: number[],
    doc: RAGDocument,
    marks: IngestMarks
  ) {
    const metadata: Record<string, unknown> = {
      ...doc.metadata,
      ...chunk.metadata,
      documentId: doc.id,
      source: doc.source,
      sourceType: doc.sourceType,
      order: chunk.order,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      ...marks,
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
