/**
 * Memory types for conversation persistence and retrieval
 */

import type { Message, ToolCall, ToolResult } from './message';
import type { GraphContext, GraphContextOptions, GraphNode } from './knowledge-graph';
import type { MemoryCompactionConfig } from './session';

export type MemoryType = 'conversation' | 'fact' | 'embedding';

/**
 * A thread represents a conversation session.
 *
 * `metadata.userId` names the user the thread belongs to: the runtime sets it
 * from the `userId` of the run that creates the thread.
 */
export interface Thread {
  id: string;
  agentId: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  /**
   * The entry the thread's active branch ends at, which new entries are added after. Absent while
   * the thread has no entries.
   */
  activeLeafId?: string;
}

/**
 * What an entry records. `message` covers user, assistant (with its tool calls) and system
 * messages, `tool_result` the answer of a tool. The others are events of the session, which a
 * context never sends to a model as they are: `model_change` (the run moved to another model),
 * `compaction` (the entries before a point of the branch are summarized, see
 * {@link CompactionEvent}), `approval` and `interrupt` (a run paused for a decision or was
 * stopped), `label` (a name for a point of the thread) and `custom` (for plugins).
 */
export type MemoryEntryType =
  | 'message'
  | 'tool_result'
  | 'model_change'
  | 'compaction'
  | 'approval'
  | 'interrupt'
  | 'label'
  | 'custom';

/**
 * What a `compaction` entry records. Entries before `firstKeptEntryId` on its branch are left out
 * of the conversation, and the entry's message, when `summarized`, stands in for them. Nothing is
 * deleted, so other branches and evidence that point at those entries keep them.
 */
export interface CompactionEvent {
  /** The first entry the compaction kept, null when it kept none */
  firstKeptEntryId: string | null;
  /**
   * The last entry it left out, so a reader of only the newest entries of a branch, which may
   * not reach the first kept one, knows where the conversation goes on
   */
  lastCompactedEntryId?: string;
  /** How many entries of the conversation it left out */
  compacted: number;
  /** Whether its message summarizes them, or they were dropped without a summary */
  summarized: boolean;
  /**
   * The summary as a tree of what the conversation established, when a `hierarchical`
   * compaction wrote it: the newest chapters, the arcs older chapters were folded into, and the
   * saga older arcs were folded into. The entry's message is the handoff rendered from it.
   */
  levels?: CompactionLevels;
}

/** What a piece of summary records */
export type CompactionAtomKind =
  'fact' | 'task' | 'decision' | 'constraint' | 'error' | 'file' | 'thread';

/** One thing a summary keeps from the conversation, with what it stands on */
export interface CompactionAtom {
  kind: CompactionAtomKind;
  /** Whether it is still open, such as a task not done or an error not fixed */
  status: 'open' | 'closed';
  text: string;
  /** Quotes of the entries it stands on */
  evidence?: Evidence[];
  /** Whether every quote was found in its entry: an atom that is not is a suggestion */
  verified: boolean;
}

/** A part of the conversation a summary covers, and what it kept of it */
export interface CompactionNode {
  /** The first and the last entry the node covers */
  from: string;
  to: string;
  atoms: CompactionAtom[];
}

/** The levels of a hierarchical summary, oldest first in each */
export interface CompactionLevels {
  saga?: CompactionNode;
  arcs: CompactionNode[];
  chapters: CompactionNode[];
}

/** The entry types that hold conversation, the ones reads return unless asked for others */
export const CONVERSATION_ENTRY_TYPES: readonly MemoryEntryType[] = ['message', 'tool_result'];

/** The layout of entries this version writes */
export const MEMORY_ENTRY_FORMAT = 2;

/**
 * A memory entry. A thread's entries form a tree: each points at the entry before it on its
 * branch (`parentId`, null for the first), and the thread's `activeLeafId` names the branch new
 * entries go on. Branches share the entries before the point they split at.
 */
export interface MemoryEntry {
  id: string;
  threadId: string;
  message: Message;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  tokenCount: number;
  createdAt: Date;
  metadata?: Record<string, unknown>;
  /** What the entry records, `message` when absent (entries written before types) */
  type?: MemoryEntryType;
  /** The entry before it on its branch, null for the first of the thread */
  parentId?: string | null;
  /** Position among the thread's entries in the order they were added */
  seq?: number;
  /** The payload of an event entry (any type but `message` and `tool_result`) */
  event?: Record<string, unknown>;
  /** Layout version of the entry, {@link MEMORY_ENTRY_FORMAT} for entries written now */
  formatVersion?: number;
}

/**
 * An entry to add to a thread. `createdAt` places it at that time instead of now: compaction
 * uses it to put a summary before the entries it keeps without rewriting them.
 *
 * Without `parentId` the entry goes after the thread's active leaf and becomes it. With one it
 * goes after that entry, on that branch. `activate: false` adds it without moving the active
 * leaf, so a fork or a replay writes a branch of its own while the thread goes on where it was.
 */
export type NewMemoryEntry = Omit<
  MemoryEntry,
  'id' | 'createdAt' | 'seq' | 'formatVersion' | 'parentId'
> & {
  createdAt?: Date;
  parentId?: string | null;
  activate?: boolean;
};

/** Which part of a thread's tree `getPath` reads */
export interface PathQueryOptions {
  threadId: string;
  /** The entry the path ends at, the thread's active leaf by default */
  leafId?: string;
  /** Entries of the path to return, the newest ones, all by default */
  limit?: number;
  /** Only entries before this one on the path, to read a long path in pages from its end */
  before?: string;
  /** Entry types to return, the conversation ones by default, or `'all'` */
  types?: readonly MemoryEntryType[] | 'all';
  includeToolCalls?: boolean;
}

/** Evidence a derived item (summary, fact, observation) stands on: where, and what it says */
export interface Evidence {
  /** The memory entry the quote is from */
  entryId?: string;
  /** The tool call whose result the quote is from */
  toolCallId?: string;
  /** A part of a file the quote is from */
  fileRange?: { path: string; start: number; end: number };
  /** The words the item stands on, as they appear in the source */
  quote: string;
}

/** Whether the quote of a piece of evidence was found in its source word for word */
export type EvidenceStatus = 'verified' | 'suggested';

/**
 * A fact is a long-term memory (user preference, learned info).
 *
 * A fact with `metadata.userId` belongs to that user and is only put into
 * that user's context; a fact without one is shared by everyone the agent serves.
 */
export interface Fact {
  id: string;
  agentId: string;
  content: string;
  category: string;
  confidence: number;
  source: 'user' | 'inferred' | 'system';
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
  /** Where it comes from, word for word: entries, tool results or files it stands on */
  evidence?: Evidence[];
}

/**
 * An embedding for semantic search
 */
export interface Embedding {
  id: string;
  sourceId: string;
  sourceType: 'message' | 'fact' | 'document';
  vector: number[];
  content: string;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

export type MemoryResult<T> = { success: true; data: T } | { success: false; error: string };

export type MemoryProvider = 'memory' | 'redis' | 'postgres' | 'sqlite' | 'mongodb' | 'qdrant';

export interface MemoryAdapterConfig {
  provider: MemoryProvider;
}

export interface InMemoryAdapterConfig extends MemoryAdapterConfig {
  provider: 'memory';
  maxEntries?: number;
}

export interface RedisAdapterConfig extends MemoryAdapterConfig {
  provider: 'redis';
  /** Redis URL for standalone mode (e.g., redis://localhost:6379) */
  url?: string;
  /** Host for standalone mode (alternative to url) */
  host?: string;
  /** Port for standalone mode (alternative to url) */
  port?: number;
  /** Cluster nodes for Redis Cluster mode */
  cluster?: {
    nodes: { host: string; port: number }[];
    scaleReads?: 'master' | 'slave' | 'all';
  };
  /** Key prefix (default: 'cogitator:' or '{cogitator}:' for cluster) */
  keyPrefix?: string;
  /** Seconds threads and entries live after their last write, 0 (the default) to keep them */
  ttl?: number;
  /** Password for authentication */
  password?: string;
}

export interface PostgresAdapterConfig extends MemoryAdapterConfig {
  provider: 'postgres';
  connectionString: string;
  schema?: string;
  poolSize?: number;
  /**
   * Vector size of the embedding model (default 768). The `embeddings` table is created with
   * it, and an existing table of another size is reported instead of failing each search. When
   * not set, an existing table keeps its own size.
   */
  dimensions?: number;
}

export interface SQLiteAdapterConfig extends MemoryAdapterConfig {
  provider: 'sqlite';
  /** Path to SQLite database file. Use ':memory:' for in-memory database */
  path: string;
  /** Enable WAL mode for better concurrency (default: true) */
  walMode?: boolean;
}

export interface MongoDBAdapterConfig extends MemoryAdapterConfig {
  provider: 'mongodb';
  /** MongoDB connection URI */
  uri: string;
  /** Database name (default: 'cogitator') */
  database?: string;
  /** Collection prefix (default: 'memory_') */
  collectionPrefix?: string;
}

export interface QdrantAdapterConfig extends MemoryAdapterConfig {
  provider: 'qdrant';
  /** Qdrant server URL (default: 'http://localhost:6333') */
  url?: string;
  /** API key for Qdrant Cloud */
  apiKey?: string;
  /** Collection name (default: 'cogitator') */
  collection?: string;
  /** Vector dimensions (must match embedding model) */
  dimensions: number;
}

export interface MemoryQueryOptions {
  threadId: string;
  limit?: number;
  before?: Date;
  after?: Date;
  includeToolCalls?: boolean;
  /** Entry types to return, the conversation ones by default, or `'all'` */
  types?: readonly MemoryEntryType[] | 'all';
}

/** Which threads `listThreads` returns, and in which order. */
export interface ListThreadsOptions {
  /** Threads of this agent only */
  agentId?: string;
  /**
   * Threads whose metadata holds each of these values under these top-level keys, compared as
   * they are: `{ userId: 'u1', archived: false }`
   */
  metadata?: Record<string, string | number | boolean>;
  /** Threads updated at this time or later */
  updatedAfter?: Date;
  /** Threads per page, 50 by default, at most 500 */
  limit?: number;
  /** Where the page starts: `nextCursor` of the page before, with the same filters and order */
  cursor?: string;
  /** By `updatedAt`, then by id: `desc` (default) starts with the threads updated last */
  order?: 'asc' | 'desc';
}

/** A page of `listThreads`. */
export interface ThreadPage {
  threads: Thread[];
  /** Pass as `cursor` for the next page, absent on the last one */
  nextCursor?: string;
}

export interface SemanticSearchOptions {
  query?: string;
  vector?: number[];
  limit?: number;
  threshold?: number;
  filter?: SearchFilter;
}

/**
 * A change an adapter made to what it stores, reported once the write succeeded. An entry the
 * adapter dropped to stay within its limits is reported as deleted.
 */
export type MemoryChange =
  | { type: 'entry-added'; entry: MemoryEntry }
  | { type: 'entry-deleted'; entryId: string; threadId?: string }
  | { type: 'thread-cleared'; threadId: string }
  | { type: 'thread-deleted'; threadId: string };

export type MemoryChangeListener = (change: MemoryChange) => void;

/**
 * Core memory adapter - all adapters implement this
 */
export interface MemoryAdapter {
  readonly provider: MemoryProvider;

  createThread(
    agentId: string,
    metadata?: Record<string, unknown>,
    threadId?: string
  ): Promise<MemoryResult<Thread>>;
  getThread(threadId: string): Promise<MemoryResult<Thread | null>>;
  updateThread(threadId: string, metadata: Record<string, unknown>): Promise<MemoryResult<Thread>>;
  deleteThread(threadId: string): Promise<MemoryResult<void>>;
  /**
   * Threads in pages, newest update first by default, filtered by agent, metadata and update
   * time. A thread's `updatedAt` changes when it is created or its metadata is updated, not
   * when an entry is added.
   */
  listThreads(options?: ListThreadsOptions): Promise<MemoryResult<ThreadPage>>;

  addEntry(entry: NewMemoryEntry): Promise<MemoryResult<MemoryEntry>>;
  getEntries(options: MemoryQueryOptions): Promise<MemoryResult<MemoryEntry[]>>;
  getEntry(entryId: string): Promise<MemoryResult<MemoryEntry | null>>;
  deleteEntry(entryId: string): Promise<MemoryResult<void>>;
  clearThread(threadId: string): Promise<MemoryResult<void>>;

  /**
   * The entries of a branch in order, from its first entry to `leafId` (the active leaf by
   * default), the newest `limit` of them, without reading the rest of the thread
   */
  getPath?(options: PathQueryOptions): Promise<MemoryResult<MemoryEntry[]>>;
  /** Moves the active leaf back to `toEntryId`, an entry on the active branch. Nothing is deleted. */
  rewind?(threadId: string, toEntryId: string): Promise<MemoryResult<Thread>>;
  /** Makes the branch ending at `entryId` the active one, any entry of the thread */
  checkout?(threadId: string, entryId: string): Promise<MemoryResult<Thread>>;
  /**
   * A new thread holding copies of the branch up to `atEntryId`, each copy naming its original
   * in `metadata.forkOf`, the thread naming its origin in `metadata.forkedFrom`
   */
  forkThread?(
    threadId: string,
    atEntryId: string,
    newThreadId?: string
  ): Promise<MemoryResult<Thread>>;
  /**
   * Calls `listener` with every change the adapter makes from now on, until the returned
   * function is called. The built-in adapters report every change; one that does not is still
   * read correctly, its entries are only indexed when a context is built.
   */
  onChange?(listener: MemoryChangeListener): () => void;

  connect(): Promise<MemoryResult<void>>;
  disconnect(): Promise<MemoryResult<void>>;
}

/**
 * Extended adapter for long-term facts (Postgres)
 */
export interface FactAdapter {
  addFact(fact: Omit<Fact, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryResult<Fact>>;
  getFacts(agentId: string, category?: string): Promise<MemoryResult<Fact[]>>;
  updateFact(
    factId: string,
    updates: Partial<
      Pick<Fact, 'content' | 'category' | 'confidence' | 'metadata' | 'expiresAt' | 'evidence'>
    >
  ): Promise<MemoryResult<Fact>>;
  deleteFact(factId: string): Promise<MemoryResult<void>>;
  searchFacts(agentId: string, query: string): Promise<MemoryResult<Fact[]>>;
}

/**
 * Extended adapter for semantic search (pgvector)
 */
export interface EmbeddingAdapter {
  addEmbedding(embedding: Omit<Embedding, 'id' | 'createdAt'>): Promise<MemoryResult<Embedding>>;
  search(options: SemanticSearchOptions): Promise<MemoryResult<(Embedding & { score: number })[]>>;
  deleteEmbedding(embeddingId: string): Promise<MemoryResult<void>>;
  deleteBySource(sourceId: string): Promise<MemoryResult<void>>;
  /** The embeddings of these sources, vectors included, in no particular order */
  getBySources?(sourceIds: string[]): Promise<MemoryResult<Embedding[]>>;
  /**
   * Stores `embedding` as the only one of its source, atomically: two processes replacing the
   * same source at once leave one embedding, not two
   */
  replaceBySource?(
    embedding: Omit<Embedding, 'id' | 'createdAt'>
  ): Promise<MemoryResult<Embedding>>;
  /**
   * Deletes every embedding the filter matches; a filter without any condition is rejected.
   * Built-in stores implement it, RAG re-ingest needs it to replace a source's chunks.
   */
  deleteByFilter?(filter: EmbeddingDeleteFilter): Promise<MemoryResult<void>>;
}

export interface EmbeddingService {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly model: string;
}

export type EmbeddingProvider = 'openai' | 'ollama' | 'google';

export interface OpenAIEmbeddingConfig {
  provider: 'openai';
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Output dimensions (supported by text-embedding-3-* models) */
  dimensions?: number;
}

export interface OllamaEmbeddingConfig {
  provider: 'ollama';
  model?: string;
  baseUrl?: string;
  dimensions?: number;
}

export interface GoogleEmbeddingConfig {
  provider: 'google';
  apiKey: string;
  model?: string;
  baseUrl?: string;
  dimensions?: number;
}

export type EmbeddingServiceConfig =
  OpenAIEmbeddingConfig | OllamaEmbeddingConfig | GoogleEmbeddingConfig;

export type ContextStrategy = 'recent' | 'relevant' | 'hybrid';

/**
 * The parts a context is assembled from, in the order of how long they stay the same: `system`
 * (the agent's instructions), `pinned` (what is always in context), `index` (what memory holds),
 * `summaries` (the summary of compacted history), `recent` (the history itself), and the parts
 * that change every turn, `facts`, `recall` (search results and the knowledge graph), `brief`
 * (notes prepared for the turn) and `final` (the input of the turn).
 */
export type ContextPartition =
  'system' | 'pinned' | 'index' | 'summaries' | 'facts' | 'recall' | 'brief' | 'recent' | 'final';

/**
 * The budget of a context partition: `share` of the context budget it may take, and whether it
 * is `required` (never left out, cut down only when the budget cannot hold it). What a partition
 * leaves unused goes to partitions that need more, `recent` last.
 */
export interface ContextPartitionBudget {
  share?: number;
  required?: boolean;
}

/** Why a block of a context was left out */
export type DroppedReason =
  /** No room left in the budget */
  | 'budget'
  /** It said what a block that stays says already */
  | 'duplicate'
  /** The strategy did not pick it, such as an entry scored too low */
  | 'not-selected'
  /** Larger than its partition could hold alone, left out in favour of what follows */
  | 'oversized';

/** A block of a context that was left out, and why */
export interface DroppedBlock {
  partition: ContextPartition;
  reason: DroppedReason;
  tokens: number;
  /** The history entry, fact or search result it came from */
  sourceId?: string;
}

export interface ContextBuilderConfig {
  /**
   * Token budget of a built context. Without it, `build()` takes `maxTokens` from its options:
   * a Cogitator run passes the context window of the model it runs on
   */
  maxTokens?: number;
  /** Tokens of the budget kept free for the answer (default 10% of `maxTokens`, at least 100) */
  reserveTokens?: number;
  strategy: ContextStrategy;
  includeSystemPrompt?: boolean;
  includeFacts?: boolean;
  includeSemanticContext?: boolean;
  includeGraphContext?: boolean;
  graphContextOptions?: GraphContextOptions;
  /**
   * Budgets of the partitions, merged over the defaults: `system`, `pinned`, `index`,
   * `summaries`, `brief` and `final` required, `facts` 15%, `recall` 35%, `recent` the rest.
   * The shares of the partitions that are not required add up to 1 at most.
   */
  partitions?: Partial<Record<ContextPartition, ContextPartitionBudget>>;
}

/**
 * A part of the context that could not be loaded. The context is built without it:
 * `history` (the thread's entries), `facts`, `semantic` (the `Relevant context:` search),
 * `graph`, or `relevance` (scoring entries for the `relevant`/`hybrid` strategies, which then
 * fall back to the most recent entries).
 */
export interface ContextBuildError {
  source: 'history' | 'facts' | 'semantic' | 'graph' | 'relevance';
  error: Error;
}

/** What a built context left out. */
export interface DroppedContext {
  /**
   * History entries left out, in conversation order: those the budget had no room for, and with
   * the `relevant` and `hybrid` strategies also those the selection passed over (entries scored
   * too low, tool entries, entries older than the newest 200 it scores)
   */
  entries: MemoryEntry[];
  /** Facts visible to the user that did not fit */
  facts: Fact[];
  /** Search results close enough to the input that did not fit */
  semanticResults: (Embedding & { score: number })[];
  /** Knowledge graph nodes cut from the graph context */
  graphNodes: GraphNode[];
  /** Tokens of everything left out */
  tokenCount: number;
  /** Every block left out, with its partition and the reason */
  blocks: DroppedBlock[];
}

export interface BuiltContext {
  /**
   * The context in the order of how long its parts stay the same: a system message (the system
   * prompt, then what is pinned and the memory index), the history, its last message marked as a
   * cache breakpoint, and, when there is any, a user message with what changes every turn (see
   * `memoryContext`)
   */
  messages: Message[];
  /**
   * What changes every turn (facts, recall, the brief), which `messages` end with as a user
   * message. A caller that adds the input itself, as a Cogitator run does, sends it with the input
   * instead, so it does not stand between the history and the prompt cache.
   */
  memoryContext?: string;
  /** Tokens each partition took */
  partitions: Partial<Record<ContextPartition, number>>;
  facts: Fact[];
  semanticResults: (Embedding & { score: number })[];
  graphContext?: GraphContext;
  tokenCount: number;
  /** Whether history entries were left out, see `dropped.entries` */
  truncated: boolean;
  /** What was left out of the context */
  dropped: DroppedContext;
  /** Parts of the context that failed to load and were left out */
  errors?: ContextBuildError[];
  /** Budget problems, such as a system prompt that alone exceeds `maxTokens - reserveTokens` */
  warnings?: string[];
  metadata: {
    originalMessageCount: number;
    includedMessageCount: number;
    factsIncluded: number;
    semanticResultsIncluded: number;
    graphNodesIncluded: number;
    graphEdgesIncluded: number;
  };
}

export interface MemoryConfig {
  adapter?: MemoryProvider;
  inMemory?: Omit<InMemoryAdapterConfig, 'provider'>;
  redis?: Omit<RedisAdapterConfig, 'provider'>;
  postgres?: Omit<PostgresAdapterConfig, 'provider'>;
  sqlite?: Omit<SQLiteAdapterConfig, 'provider'>;
  mongodb?: Omit<MongoDBAdapterConfig, 'provider'>;
  qdrant?: Omit<QdrantAdapterConfig, 'provider'>;
  /**
   * The embedding model: a provider's config, or an `EmbeddingService` of your own (another
   * provider, a cache in front of one), which the runtime uses as it is
   */
  embedding?: EmbeddingServiceConfig | EmbeddingService;
  contextBuilder?: Partial<ContextBuilderConfig>;
  /** Compaction of a run's thread after the run, off unless set */
  compaction?: MemoryCompactionConfig;
}

export type SearchStrategy = 'vector' | 'keyword' | 'hybrid';

export interface HybridSearchWeights {
  bm25: number;
  vector: number;
}

export interface SearchFilter {
  sourceType?: Embedding['sourceType'];
  /**
   * Any of these source types, for stores that support it (every built-in one does). A store
   * that ignores it returns other types too, so a caller filters the results again.
   */
  sourceTypes?: Embedding['sourceType'][];
  threadId?: string;
  agentId?: string;
  /** Only embeddings of this user (`metadata.userId`) and those of no user */
  userId?: string;
  /** Only embeddings whose metadata holds each of these values */
  metadata?: Record<string, string | number | boolean>;
}

/**
 * What `deleteByFilter` deletes. It has no `userId`, whose search meaning also takes in
 * embeddings of no user: delete a user's embeddings with `metadata: { userId }`.
 */
export type EmbeddingDeleteFilter = Omit<SearchFilter, 'userId'>;

export interface SearchOptions {
  query: string;
  strategy: SearchStrategy;
  weights?: HybridSearchWeights;
  limit?: number;
  threshold?: number;
  filter?: SearchFilter;
}

export interface SearchResult {
  id: string;
  sourceId: string;
  sourceType: Embedding['sourceType'];
  content: string;
  score: number;
  vectorScore?: number;
  keywordScore?: number;
  metadata?: Record<string, unknown>;
}

export interface KeywordSearchOptions {
  query: string;
  limit?: number;
  filter?: SearchFilter;
}

export interface KeywordSearchAdapter {
  keywordSearch(options: KeywordSearchOptions): Promise<MemoryResult<SearchResult[]>>;
}

export interface HybridSearchConfig {
  embeddingAdapter: EmbeddingAdapter;
  embeddingService: EmbeddingService;
  keywordAdapter?: KeywordSearchAdapter;
  defaultWeights?: HybridSearchWeights;
}
