/**
 * Message index - each history entry is embedded once and its vector kept in an embedding store
 */

import type {
  Embedding,
  EmbeddingAdapter,
  EmbeddingService,
  MemoryAdapter,
  MemoryChange,
  MemoryEntry,
  MemoryResult,
} from '@cogitator-ai/types';

/** Entries embedded in one call by default */
const DEFAULT_BATCH_SIZE = 32;

/** Vectors kept in process, so a turn reads the store only for entries it has not seen */
const VECTOR_CACHE_SIZE = 4096;

/** Deleted entries and dropped threads remembered, so a vector written late is not kept */
const TOMBSTONES = 10_000;

export interface MessageIndexOptions {
  /** Where the vectors are kept */
  store: EmbeddingAdapter;
  embedding: EmbeddingService;
  /** Entries embedded in one call, 32 by default */
  batchSize?: number;
  /**
   * Called when indexing in the background fails. The entries it was indexing are embedded
   * again when a context needs them.
   */
  onError?: (error: Error) => void;
}

/** An entry as the index sees it: the text its vector is made of */
export interface IndexedText {
  entryId: string;
  threadId: string;
  role: 'user' | 'assistant';
  text: string;
}

interface Pending extends IndexedText {
  /** The index's clock when the entry was seen, to tell whether its thread was dropped since */
  seenAt: number;
}

/** The text an entry is indexed by: a user or assistant message with text, else undefined */
export function indexedText(entry: MemoryEntry): IndexedText | undefined {
  const { role, content } = entry.message;
  if (role !== 'user' && role !== 'assistant') return undefined;
  if (typeof content !== 'string' || content.trim().length === 0) return undefined;
  return { entryId: entry.id, threadId: entry.threadId, role, text: content };
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Adds `key` to a map kept to `limit` entries, dropping the oldest */
function remember<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/**
 * Keeps a vector for every user and assistant entry of a memory adapter in an embedding store,
 * `sourceType: 'message'`, so a context build embeds only its input. Attached to an adapter that
 * reports its changes (`onChange`), it embeds new entries in the background, in batches, and
 * deletes the vectors of entries and threads the adapter deletes. Entries it has not indexed yet
 * are embedded when a build asks for them, and kept then.
 *
 * Writes and deletes run one after another in the order of the changes, so the vector of an
 * entry never outlives it.
 */
export class MessageIndex {
  private readonly store: EmbeddingAdapter;
  private readonly embedding: EmbeddingService;
  private readonly batchSize: number;
  private readonly onError: (error: Error) => void;
  private readonly waiting = new Map<string, Pending>();
  private readonly vectors = new Map<string, Float32Array>();
  private readonly deletedEntries = new Map<string, true>();
  private readonly droppedThreads = new Map<string, number>();
  private readonly detachers: (() => void)[] = [];
  private queue: Promise<void> = Promise.resolve();
  private scheduled = false;
  private clock = 0;

  constructor(options: MessageIndexOptions) {
    if (options.batchSize !== undefined && !(options.batchSize >= 1)) {
      throw new Error(`MessageIndex batchSize must be 1 or more, got ${options.batchSize}`);
    }
    this.store = options.store;
    this.embedding = options.embedding;
    this.batchSize = Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE);
    this.onError = options.onError ?? (() => undefined);
  }

  /** The embedding model the vectors are made with */
  get model(): string {
    return this.embedding.model;
  }

  /**
   * Indexes what `memory` stores from now on. False when the adapter does not report its
   * changes: its entries are then indexed only when a context build needs them.
   */
  attach(memory: MemoryAdapter): boolean {
    if (!memory.onChange) return false;
    this.detachers.push(memory.onChange((change) => this.changed(change)));
    return true;
  }

  /** Takes in a change of the memory: a new entry to embed, or vectors to delete */
  changed(change: MemoryChange): void {
    switch (change.type) {
      case 'entry-added': {
        const text = indexedText(change.entry);
        if (!text) return;
        this.waiting.set(text.entryId, { ...text, seenAt: this.clock });
        this.schedule();
        return;
      }
      case 'entry-deleted':
        this.waiting.delete(change.entryId);
        this.vectors.delete(change.entryId);
        remember(this.deletedEntries, change.entryId, true, TOMBSTONES);
        this.run(() => this.unwrap(this.store.deleteBySource(change.entryId), 'deleteBySource'));
        return;
      case 'thread-cleared':
      case 'thread-deleted':
        this.dropThread(change.threadId);
        return;
    }
  }

  /**
   * Vectors of `entries` by entry id: kept ones from the store, the rest embedded now and kept.
   * An entry the store holds a vector of another model for is embedded again.
   */
  async vectorsOf(entries: readonly IndexedText[]): Promise<Map<string, Float32Array>> {
    const found = new Map<string, Float32Array>();
    const unseen: IndexedText[] = [];
    for (const entry of entries) {
      const cached = this.vectors.get(entry.entryId);
      if (cached) {
        remember(this.vectors, entry.entryId, cached, VECTOR_CACHE_SIZE);
        found.set(entry.entryId, cached);
      } else {
        unseen.push(entry);
      }
    }
    if (unseen.length === 0) return found;

    const stored = await this.storedVectors(unseen.map((entry) => entry.entryId));
    const missing: Pending[] = [];
    for (const entry of unseen) {
      const vector = stored.get(entry.entryId);
      if (vector) {
        this.keep(entry.entryId, vector);
        found.set(entry.entryId, vector);
      } else {
        this.waiting.delete(entry.entryId);
        missing.push({ ...entry, seenAt: this.clock });
      }
    }

    for (let start = 0; start < missing.length; start += this.batchSize) {
      const batch = missing.slice(start, start + this.batchSize);
      const vectors = await this.embedBatch(batch);
      batch.forEach((entry, i) => found.set(entry.entryId, vectors[i]));
      this.run(() => this.write(batch, vectors));
    }
    return found;
  }

  /**
   * Entries of `threadId` closest to `vector`, by entry id with their similarity, at most
   * `limit` and none below `minScore`
   */
  async search(
    threadId: string,
    vector: number[],
    limit: number,
    minScore: number
  ): Promise<Map<string, number>> {
    const found = await this.unwrap(
      this.store.search({
        vector,
        limit,
        threshold: minScore,
        filter: { sourceType: 'message', threadId, metadata: { model: this.model } },
      }),
      'search'
    );
    return new Map(found.map((result) => [result.sourceId, result.score]));
  }

  /** Waits until every change taken in so far is written to the store */
  async flush(): Promise<void> {
    let settled: Promise<void>;
    do {
      settled = this.queue;
      await settled;
    } while (settled !== this.queue || this.scheduled);
  }

  /** Stops indexing the attached adapters and waits for the writes under way */
  async close(): Promise<void> {
    for (const detach of this.detachers.splice(0)) detach();
    await this.flush();
  }

  private dropThread(threadId: string): void {
    for (const [entryId, pending] of this.waiting) {
      if (pending.threadId === threadId) this.waiting.delete(entryId);
    }
    remember(this.droppedThreads, threadId, ++this.clock, TOMBSTONES);
    this.run(async () => {
      if (!this.store.deleteByFilter) return;
      await this.unwrap(
        this.store.deleteByFilter({ sourceType: 'message', threadId }),
        'deleteByFilter'
      );
    });
  }

  /** Embeds the waiting entries in batches once the current work is done */
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.run(async () => {
      this.scheduled = false;
      while (this.waiting.size > 0) {
        const batch = [...this.waiting.values()].slice(0, this.batchSize);
        for (const entry of batch) this.waiting.delete(entry.entryId);
        try {
          await this.write(batch, await this.embedBatch(batch));
        } catch (error) {
          this.onError(errorOf(error));
        }
      }
    });
  }

  /** Runs `work` after everything queued before it; a failure goes to `onError` */
  private run(work: () => Promise<unknown>): void {
    this.queue = this.queue.then(work).then(
      () => undefined,
      (error: unknown) => this.onError(errorOf(error))
    );
  }

  private async embedBatch(entries: readonly IndexedText[]): Promise<Float32Array[]> {
    const vectors = await this.embedding.embedBatch(entries.map((entry) => entry.text));
    if (vectors.length !== entries.length) {
      throw new Error(`Embedding returned ${vectors.length} vectors for ${entries.length} entries`);
    }
    return vectors.map((vector) => Float32Array.from(vector));
  }

  /** Keeps the vectors of entries still stored, each replacing what the store held for it */
  private async write(entries: readonly Pending[], vectors: Float32Array[]): Promise<void> {
    for (const [i, entry] of entries.entries()) {
      if (this.isGone(entry)) continue;
      this.keep(entry.entryId, vectors[i]);
      await this.unwrap(this.store.deleteBySource(entry.entryId), 'deleteBySource');
      await this.unwrap(
        this.store.addEmbedding({
          sourceId: entry.entryId,
          sourceType: 'message',
          vector: Array.from(vectors[i]),
          content: entry.text,
          metadata: {
            threadId: entry.threadId,
            entryId: entry.entryId,
            role: entry.role,
            model: this.model,
          },
        }),
        'addEmbedding'
      );
    }
  }

  /** Whether the entry or its thread was deleted since the index saw it */
  private isGone(entry: Pending): boolean {
    if (this.deletedEntries.has(entry.entryId)) return true;
    const dropped = this.droppedThreads.get(entry.threadId);
    return dropped !== undefined && dropped > entry.seenAt;
  }

  private keep(entryId: string, vector: Float32Array): void {
    remember(this.vectors, entryId, vector, VECTOR_CACHE_SIZE);
  }

  /** Vectors the store keeps for these entries, made by the index's model */
  private async storedVectors(entryIds: string[]): Promise<Map<string, Float32Array>> {
    const found = new Map<string, Float32Array>();
    if (!this.store.getBySources) return found;
    const stored: Embedding[] = await this.unwrap(
      this.store.getBySources(entryIds),
      'getBySources'
    );
    const dimensions = this.embedding.dimensions;
    for (const embedding of stored) {
      if (embedding.sourceType !== 'message' || embedding.metadata?.model !== this.model) continue;
      if (dimensions > 0 && embedding.vector.length !== dimensions) continue;
      found.set(embedding.sourceId, Float32Array.from(embedding.vector));
    }
    return found;
  }

  private async unwrap<T>(pending: Promise<MemoryResult<T>>, operation: string): Promise<T> {
    const result = await pending;
    if (!result.success) throw new Error(`Message index ${operation} failed: ${result.error}`);
    return result.data;
  }
}
