/**
 * Memory types for conversation persistence and retrieval
 */

import type { Message, ToolCall, ToolResult } from './message';
import type { GraphContext, GraphContextOptions } from './knowledge-graph';

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
}

/**
 * A memory entry - stored message with metadata
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
}

/**
 * An entry to add to a thread. `createdAt` places it at that time instead of now: compaction
 * uses it to put a summary before the entries it keeps without rewriting them.
 */
export type NewMemoryEntry = Omit<MemoryEntry, 'id' | 'createdAt'> & { createdAt?: Date };

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
  /** TTL in seconds (default: 86400 = 24 hours) */
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
}

export interface SemanticSearchOptions {
  query?: string;
  vector?: number[];
  limit?: number;
  threshold?: number;
  filter?: SearchFilter;
}

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

  addEntry(entry: NewMemoryEntry): Promise<MemoryResult<MemoryEntry>>;
  getEntries(options: MemoryQueryOptions): Promise<MemoryResult<MemoryEntry[]>>;
  getEntry(entryId: string): Promise<MemoryResult<MemoryEntry | null>>;
  deleteEntry(entryId: string): Promise<MemoryResult<void>>;
  clearThread(threadId: string): Promise<MemoryResult<void>>;

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
    updates: Partial<Pick<Fact, 'content' | 'category' | 'confidence' | 'metadata' | 'expiresAt'>>
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

export interface ContextBuilderConfig {
  maxTokens: number;
  reserveTokens?: number;
  strategy: ContextStrategy;
  includeSystemPrompt?: boolean;
  includeFacts?: boolean;
  includeSemanticContext?: boolean;
  includeGraphContext?: boolean;
  graphContextOptions?: GraphContextOptions;
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

export interface BuiltContext {
  messages: Message[];
  facts: Fact[];
  semanticResults: (Embedding & { score: number })[];
  graphContext?: GraphContext;
  tokenCount: number;
  truncated: boolean;
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
  embedding?: EmbeddingServiceConfig;
  contextBuilder?: Partial<ContextBuilderConfig>;
}

export type SearchStrategy = 'vector' | 'keyword' | 'hybrid';

export interface HybridSearchWeights {
  bm25: number;
  vector: number;
}

export interface SearchFilter {
  sourceType?: Embedding['sourceType'];
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
