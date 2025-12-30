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
} from './adapters/index';

export { RedisAdapter } from './adapters/redis';
export { PostgresAdapter } from './adapters/postgres';

export { ContextBuilder, type ContextBuilderDeps, type BuildContextOptions } from './context-builder';

export {
  countTokens,
  countMessageTokens,
  countMessagesTokens,
  truncateToTokens,
} from './token-counter';

export {
  OpenAIEmbeddingService,
  OllamaEmbeddingService,
  createEmbeddingService,
} from './embedding/index';

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
} from './schema';

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
