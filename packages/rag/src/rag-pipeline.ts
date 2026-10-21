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

/**
 * Chunk positions of each document looked at for generations an earlier ingest left unfinished,
 * at least: an ingest that stopped wrote some of the first chunks after the head
 */
const PROBED_CHUNKS = 16;

/**
 * How old a generation newer than the stored one must be to count as left by an ingest that
 * stopped, rather than one another process is still writing
 */
const ABANDONED_AFTER_MS = 10 * 60_000;

let lastGenerationTime = 0;

/**
 * A new generation id: its time first, so ids sort in the order ingests started, the time kept
 * strictly growing in this process so two ingests started in one millisecond still sort
 */
function newGeneration(): string {
  lastGenerationTime = Math.max(Date.now(), lastGenerationTime + 1);
  return `${lastGenerationTime.toString(36).padStart(9, '0')}-${randomUUID()}`;
}

/** When a generation was started, 0 for ids without a time */
function generationTime(generation: string): number {
  const match = /^([0-9a-z]{9})-/.exec(generation);
  return match ? Number.parseInt(match[1]!, 36) : 0;
}

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

/**
 * What one ingest writes into every chunk, so the next one can tell what changed. The keys carry
 * a `rag` prefix so they do not take the place of a document's own metadata.
 */
interface IngestMarks {
  /** Absent when the chunker has no fingerprint, so the chunks are never taken as unchanged */
  ragContentHash?: string;
  ragGeneration: string;
  ragSourceDocuments: number;
}

/** A chunk paired with the vector it is stored with */
interface ChunkWrite {
  chunk: DocumentChunk;
  vector: number[];
  doc: RAGDocument;
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
  /** Sources a local keyword index of the retriever holds the chunks of in this process */
  private readonly locallyIndexed = new Set<string>();
  /** Ingests under way by source, so this process replaces a source one ingest at a time */
  private readonly ingesting = new Map<string, Promise<unknown>>();

  constructor(config: RAGPipelineConfig, deps: RAGPipelineDeps, alreadyParsed = false) {
    this.config = alreadyParsed ? config : RAGPipelineConfigSchema.parse(config);
    this.deps = deps;
  }

  /**
   * Loads `source` and stores its chunks. Each source the loader returns documents for replaces
   * what this pipeline stored for it before, so ingesting a file again (or an edited file) leaves
   * no duplicates or stale text behind.
   *
   * A source whose documents, chunker and embedding model did not change since the last ingest
   * is left as stored, without embedding anything (`unchanged` counts its documents). That needs
   * a chunker with a `fingerprint`, which the built-in ones have. A changed source is written as
   * a new generation before the previous one is deleted, so searches never find it empty, and
   * the chunks of its unchanged documents keep their vectors. The first chunk of each document
   * is written last, so a source an ingest stopped writing is never taken as unchanged. That
   * needs a store with `getBySources` and `deleteByFilter`, which every built-in store has.
   * Chunks stored before generations, or a store without them, are replaced as before: deleted,
   * then written again.
   */
  async ingest(source: string): Promise<{ documents: number; chunks: number; unchanged: number }> {
    const documents = await this.deps.loader.load(source);
    let totalChunks = 0;
    let unchanged = 0;

    for (const group of groupBySource(documents)) {
      const done = await this.oneAtATime(group[0]!.source, () => this.ingestGroup(group));
      totalChunks += done.chunks;
      unchanged += done.unchanged;
    }

    return { documents: documents.length, chunks: totalChunks, unchanged };
  }

  /** Runs `work` once the ingests of `source` this process started before it are done */
  private async oneAtATime<T>(source: string, work: () => Promise<T>): Promise<T> {
    const before = this.ingesting.get(source) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(work);
    this.ingesting.set(source, run);
    try {
      return await run;
    } finally {
      if (this.ingesting.get(source) === run) this.ingesting.delete(source);
    }
  }

  /**
   * Ingests the documents of one source, leaving it as stored when unchanged. Generations older
   * than the one written are deleted after it, newer ones belong to an ingest that started later
   * and are left to it.
   */
  private async ingestGroup(group: RAGDocument[]): Promise<{ chunks: number; unchanged: number }> {
    const sourceName = group[0]!.source;
    const hashes = new Map(group.map((doc) => [doc.id, this.contentHash(doc)]));
    const stored = await this.storedChunks(
      group.flatMap((doc) => [chunkId(doc.id, 0), chunkId(doc.id, 1)])
    );
    const heads = new Map(
      group.map((doc) => [chunkId(doc.id, 0), stored.get(chunkId(doc.id, 0)) ?? []])
    );
    const previous = this.previousGeneration(group, hashes, heads);
    if (previous.unchanged) {
      const kept = previous.generations![0]!;
      for (const old of this.unfinishedGenerations(group, stored, kept)) {
        await this.forgetGeneration(sourceName, old);
      }
      await this.indexLocally(sourceName, group);
      return { chunks: 0, unchanged: group.length };
    }

    const prepared: PreparedDocument[] = [];
    for (const doc of group) {
      const hash = hashes.get(doc.id);
      const reusable =
        hash === undefined
          ? undefined
          : heads
              .get(chunkId(doc.id, 0))
              ?.find((head) => head.generation !== undefined && head.hash === hash);
      prepared.push(await this.prepareDocument(doc, reusable));
    }

    if (!previous.generations) await this.forgetSource(sourceName);
    const generation = newGeneration();
    const writes = prepared.flatMap(({ doc, chunks, vectors }) =>
      chunks.map((chunk, i) => ({ chunk, vector: vectors[i]!, doc }))
    );
    const isHead = ({ chunk, doc }: ChunkWrite) => chunk.id === chunkId(doc.id, 0);
    const marksOf = (doc: RAGDocument): IngestMarks => {
      const hash = hashes.get(doc.id);
      return {
        ...(hash !== undefined && { ragContentHash: hash }),
        ragGeneration: generation,
        ragSourceDocuments: group.length,
      };
    };
    await this.storeChunks(
      writes.filter((write) => !isHead(write)),
      marksOf
    );
    await this.storeChunks(writes.filter(isHead), marksOf);
    let chunks = 0;
    for (const document of prepared) {
      chunks += document.chunks.length;
      this.stats.chunksStored += document.chunks.length;
      this.stats.documentsIngested++;
    }
    this.locallyIndexed.add(sourceName);
    if (previous.generations) {
      const stale = new Set(previous.generations);
      for (const old of await this.leftGenerations(group, prepared, generation)) stale.add(old);
      for (const old of stale) {
        if (old < generation) await this.forgetGeneration(sourceName, old);
      }
      if (await this.supersededBy(group, generation)) {
        await this.forgetGeneration(sourceName, generation);
      }
    }
    return { chunks, unchanged: 0 };
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
   * Hash of what a document's chunks are made from: its text, source and metadata, the chunker's
   * fingerprint and the embedding model. None when the chunker has no fingerprint, as the same
   * text may then give other chunks.
   */
  private contentHash(doc: RAGDocument): string | undefined {
    const { embeddingService, chunker } = this.deps;
    if (chunker.fingerprint === undefined) return undefined;
    return createHash('sha256')
      .update(
        JSON.stringify([
          HASH_VERSION,
          doc.content,
          doc.source,
          doc.sourceType,
          doc.metadata ?? {},
          chunker.fingerprint,
          embeddingService.model,
          embeddingService.dimensions,
        ])
      )
      .digest('hex');
  }

  /**
   * Gives a local keyword index of the retriever the stored chunks of an unchanged source, once
   * per process: a new pipeline has an empty one, and skipping the source would leave it so.
   */
  private async indexLocally(source: string, group: RAGDocument[]): Promise<void> {
    const retriever = this.deps.retriever;
    if (!isChunkIndexer(retriever) || this.locallyIndexed.has(source)) return;
    const ids: string[] = [];
    for (const doc of group) {
      for (const chunk of await this.chunkDocument(doc)) ids.push(chunk.id);
    }
    const stored = await this.storedEmbeddings(ids);
    for (const embedding of stored) {
      const metadata = embedding.metadata ?? {};
      retriever.indexChunk({
        embeddingId: embedding.id,
        chunkId: embedding.sourceId,
        documentId: String(metadata.documentId),
        content: embedding.content,
        metadata,
      });
    }
    this.locallyIndexed.add(source);
  }

  /**
   * The stored chunks of this pipeline's namespace with these ids, by id: more than one for an id
   * when an ingest stopped before deleting the generation it replaced. Empty when the store cannot
   * read chunks by id.
   */
  private async storedChunks(ids: string[]): Promise<Map<string, StoredChunk[]>> {
    const found = new Map<string, StoredChunk[]>();
    for (const embedding of await this.storedEmbeddings(ids)) {
      const chunk = this.ownChunk(embedding);
      if (chunk) found.set(embedding.sourceId, [...(found.get(embedding.sourceId) ?? []), chunk]);
    }
    return found;
  }

  /** The stored embeddings of this pipeline's documents with these chunk ids */
  private async storedEmbeddings(ids: string[]): Promise<Embedding[]> {
    const adapter = this.deps.embeddingAdapter;
    if (!adapter.getBySources) return [];
    const found: Embedding[] = [];
    for (let start = 0; start < ids.length; start += LOOKUP_BATCH) {
      const result = await adapter.getBySources(ids.slice(start, start + LOOKUP_BATCH));
      if (!result.success) {
        throw new Error(`Could not read the stored chunks: ${result.error}`);
      }
      for (const embedding of result.data) {
        const metadata = embedding.metadata ?? {};
        if (embedding.sourceType === 'document' && metadata.namespace === this.config.namespace) {
          found.push(embedding);
        }
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
      ...(typeof metadata.ragContentHash === 'string' && { hash: metadata.ragContentHash }),
      ...(typeof metadata.ragGeneration === 'string' && { generation: metadata.ragGeneration }),
      ...(typeof metadata.ragSourceDocuments === 'number' && {
        documents: metadata.ragSourceDocuments,
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
    hashes: Map<string, string | undefined>,
    heads: Map<string, StoredChunk[]>
  ): { unchanged: boolean; generations?: string[] } {
    const found = group.flatMap((doc) =>
      (heads.get(chunkId(doc.id, 0)) ?? []).map((head) => ({ doc, head }))
    );
    if (
      !this.deps.embeddingAdapter.deleteByFilter ||
      found.length === 0 ||
      found.some(({ head }) => head.generation === undefined)
    ) {
      return { unchanged: false };
    }
    const generations = [...new Set(found.map(({ head }) => head.generation!))];
    const unchanged =
      found.length === group.length &&
      generations.length === 1 &&
      found.every(
        ({ doc, head }) =>
          head.hash !== undefined &&
          head.hash === hashes.get(doc.id) &&
          head.documents === group.length
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

  /**
   * Generations other than `kept` found on the second chunks of the documents, which an ingest
   * that stopped before the heads wrote first: older ones, and newer ones old enough that no
   * ingest is still writing them
   */
  private unfinishedGenerations(
    group: RAGDocument[],
    stored: Map<string, StoredChunk[]>,
    kept: string
  ): string[] {
    const found = new Set<string>();
    for (const doc of group) {
      for (const chunk of stored.get(chunkId(doc.id, 1)) ?? []) {
        const generation = chunk.generation;
        if (!generation || generation === kept) continue;
        const abandoned = generationTime(generation) < Date.now() - ABANDONED_AFTER_MS;
        if (generation < kept || abandoned) found.add(generation);
      }
    }
    return [...found];
  }

  /**
   * Generations other than `current` the store holds chunks of for these documents: ones an
   * ingest stopped writing before their heads, which no head names
   */
  private async leftGenerations(
    group: RAGDocument[],
    prepared: PreparedDocument[],
    current: string
  ): Promise<string[]> {
    const ids = new Set<string>();
    for (const { doc, chunks } of prepared) {
      for (const chunk of chunks) ids.add(chunk.id);
      for (let order = 0; order < PROBED_CHUNKS; order++) ids.add(chunkId(doc.id, order));
    }
    const documents = new Set(group.map((doc) => doc.id));
    const found = new Set<string>();
    for (const chunks of (await this.storedChunks([...ids])).values()) {
      for (const chunk of chunks) {
        if (chunk.generation && chunk.generation !== current && documents.has(chunk.documentId)) {
          found.add(chunk.generation);
        }
      }
    }
    return [...found];
  }

  /**
   * Whether an ingest that started after the one that wrote `generation` already wrote heads of
   * these documents, so the later one wins and `generation` goes
   */
  private async supersededBy(group: RAGDocument[], generation: string): Promise<boolean> {
    const heads = await this.storedChunks(group.map((doc) => chunkId(doc.id, 0)));
    for (const chunks of heads.values()) {
      if (chunks.some((chunk) => chunk.generation !== undefined && chunk.generation > generation)) {
        return true;
      }
    }
    return false;
  }

  /** Deletes the chunks of `source` an earlier ingest wrote as `generation` */
  private async forgetGeneration(source: string, generation: string): Promise<void> {
    const adapter = this.deps.embeddingAdapter;
    if (!adapter.deleteByFilter) return;
    const result = await adapter.deleteByFilter({
      sourceType: 'document',
      metadata: { source, ragGeneration: generation, ...this.namespaceMetadata() },
    });
    if (!result.success) {
      throw new Error(`Could not remove the previous chunks of ${source}: ${result.error}`);
    }
    const retriever = this.deps.retriever;
    if (isChunkIndexer(retriever)) {
      retriever.removeChunks?.(
        (chunk) =>
          chunk.metadata.source === source &&
          chunk.metadata.ragGeneration === generation &&
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
    writes: ChunkWrite[],
    marksOf: (doc: RAGDocument) => IngestMarks
  ): Promise<void> {
    let next = 0;
    let failed = false;
    const worker = async () => {
      while (next < writes.length && !failed) {
        const { chunk, vector, doc } = writes[next++]!;
        try {
          await this.storeChunk(chunk, vector, doc, marksOf(doc));
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    };
    const settled = await Promise.allSettled(
      Array.from({ length: Math.min(STORE_CONCURRENCY, writes.length) }, () => worker())
    );
    const failure = settled.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
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
