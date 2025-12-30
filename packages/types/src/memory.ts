/**
 * Memory types for conversation persistence and retrieval
 */

import type { Message, ToolCall, ToolResult } from './message.js';

// ============================================
// Core Memory Types
// ============================================

export type MemoryType = 'conversation' | 'fact' | 'embedding';

/**
 * A thread represents a conversation session
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
 * A fact is a long-term memory (user preference, learned info)
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

// ============================================
// Memory Result Type (Error Handling)
// ============================================

export type MemoryResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

// ============================================
// Adapter Configuration Types
// ============================================

export type MemoryProvider = 'memory' | 'redis' | 'postgres';

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
    nodes: Array<{ host: string; port: number }>;
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
}

// ============================================
// Query Options
// ============================================

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
  filter?: {
    sourceType?: Embedding['sourceType'];
    threadId?: string;
    agentId?: string;
  };
}

// ============================================
// Adapter Interfaces
// ============================================

/**
 * Core memory adapter - all adapters implement this
 */
export interface MemoryAdapter {
  readonly provider: MemoryProvider;

  // Thread operations
  createThread(
    agentId: string,
    metadata?: Record<string, unknown>
  ): Promise<MemoryResult<Thread>>;
  getThread(threadId: string): Promise<MemoryResult<Thread | null>>;
  updateThread(
    threadId: string,
    metadata: Record<string, unknown>
  ): Promise<MemoryResult<Thread>>;
  deleteThread(threadId: string): Promise<MemoryResult<void>>;

  // Memory entry operations
  addEntry(
    entry: Omit<MemoryEntry, 'id' | 'createdAt'>
  ): Promise<MemoryResult<MemoryEntry>>;
  getEntries(options: MemoryQueryOptions): Promise<MemoryResult<MemoryEntry[]>>;
  getEntry(entryId: string): Promise<MemoryResult<MemoryEntry | null>>;
  deleteEntry(entryId: string): Promise<MemoryResult<void>>;
  clearThread(threadId: string): Promise<MemoryResult<void>>;

  // Connection lifecycle
  connect(): Promise<MemoryResult<void>>;
  disconnect(): Promise<MemoryResult<void>>;
}

/**
 * Extended adapter for long-term facts (Postgres)
 */
export interface FactAdapter {
  addFact(
    fact: Omit<Fact, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<MemoryResult<Fact>>;
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
  addEmbedding(
    embedding: Omit<Embedding, 'id' | 'createdAt'>
  ): Promise<MemoryResult<Embedding>>;
  search(
    options: SemanticSearchOptions
  ): Promise<MemoryResult<Array<Embedding & { score: number }>>>;
  deleteEmbedding(embeddingId: string): Promise<MemoryResult<void>>;
  deleteBySource(sourceId: string): Promise<MemoryResult<void>>;
}

// ============================================
// Embedding Service Interface
// ============================================

export interface EmbeddingService {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly model: string;
}

export type EmbeddingProvider = 'openai' | 'ollama';

export interface OpenAIEmbeddingConfig {
  provider: 'openai';
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export interface OllamaEmbeddingConfig {
  provider: 'ollama';
  model?: string;
  baseUrl?: string;
}

export type EmbeddingServiceConfig = OpenAIEmbeddingConfig | OllamaEmbeddingConfig;

// ============================================
// Context Builder Types
// ============================================

export type ContextStrategy = 'recent' | 'relevant' | 'hybrid';

export interface ContextBuilderConfig {
  maxTokens: number;
  reserveTokens?: number;
  strategy: ContextStrategy;
  includeSystemPrompt?: boolean;
  includeFacts?: boolean;
  includeSemanticContext?: boolean;
}

export interface BuiltContext {
  messages: Message[];
  facts: Fact[];
  semanticResults: Array<Embedding & { score: number }>;
  tokenCount: number;
  truncated: boolean;
  metadata: {
    originalMessageCount: number;
    includedMessageCount: number;
    factsIncluded: number;
    semanticResultsIncluded: number;
  };
}

// ============================================
// Memory Configuration for Cogitator
// ============================================

export interface MemoryConfig {
  adapter?: MemoryProvider;
  inMemory?: Omit<InMemoryAdapterConfig, 'provider'>;
  redis?: Omit<RedisAdapterConfig, 'provider'>;
  postgres?: Omit<PostgresAdapterConfig, 'provider'>;
  embedding?: EmbeddingServiceConfig;
  contextBuilder?: Partial<ContextBuilderConfig>;
}
