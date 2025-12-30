/**
 * @cogitator/memory
 *
 * Memory adapters for Cogitator AI agents
 */

// Adapters
export {
  BaseMemoryAdapter,
  InMemoryAdapter,
  createMemoryAdapter,
  type MemoryAdapterConfigUnion,
} from './adapters/index.js';

// Lazy exports for optional adapters
export { RedisAdapter } from './adapters/redis.js';
export { PostgresAdapter } from './adapters/postgres.js';

// Context builder
export { ContextBuilder, type ContextBuilderDeps, type BuildContextOptions } from './context-builder.js';

// Token utilities
export {
  countTokens,
  countMessageTokens,
  countMessagesTokens,
  truncateToTokens,
} from './token-counter.js';

// Embedding services
export {
  OpenAIEmbeddingService,
  OllamaEmbeddingService,
  createEmbeddingService,
} from './embedding/index.js';

// Schemas
export {
  MemoryProviderSchema,
  InMemoryConfigSchema,
  RedisConfigSchema,
  PostgresConfigSchema,
  MemoryAdapterConfigSchema,
  ContextStrategySchema,
  ContextBuilderConfigSchema,
  EmbeddingProviderSchema,
  OpenAIEmbeddingConfigSchema,
  OllamaEmbeddingConfigSchema,
  EmbeddingServiceConfigSchema,
} from './schema.js';

// Re-export types from @cogitator/types for convenience
export type {
  MemoryType,
  Thread,
  MemoryEntry,
  Fact,
  Embedding,
  MemoryProvider,
  MemoryAdapterConfig,
  RedisAdapterConfig,
  PostgresAdapterConfig,
  InMemoryAdapterConfig,
  MemoryResult,
  MemoryQueryOptions,
  SemanticSearchOptions,
  MemoryAdapter,
  FactAdapter,
  EmbeddingAdapter,
  EmbeddingService,
  EmbeddingProvider,
  EmbeddingServiceConfig,
  OpenAIEmbeddingConfig,
  OllamaEmbeddingConfig,
  ContextBuilderConfig,
  ContextStrategy,
  BuiltContext,
  MemoryConfig,
} from '@cogitator/types';
