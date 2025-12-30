/**
 * @cogitator/memory
 *
 * Memory adapters for Cogitator AI agents
 */

export {
  BaseMemoryAdapter,
  InMemoryAdapter,
  createMemoryAdapter,
  type MemoryAdapterConfigUnion,
} from './adapters/index.js';

export { RedisAdapter } from './adapters/redis.js';
export { PostgresAdapter } from './adapters/postgres.js';

export { ContextBuilder, type ContextBuilderDeps, type BuildContextOptions } from './context-builder.js';

export {
  countTokens,
  countMessageTokens,
  countMessagesTokens,
  truncateToTokens,
} from './token-counter.js';

export {
  OpenAIEmbeddingService,
  OllamaEmbeddingService,
  createEmbeddingService,
} from './embedding/index.js';

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
