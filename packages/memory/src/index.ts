/**
 * @cogitator-ai/memory
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

export {
  ContextBuilder,
  type ContextBuilderDeps,
  type BuildContextOptions,
} from './context-builder';

export {
  countTokens,
  countMessageTokens,
  countMessagesTokens,
  truncateToTokens,
} from './token-counter';

export {
  OpenAIEmbeddingService,
  OllamaEmbeddingService,
  GoogleEmbeddingService,
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
  GoogleEmbeddingConfigSchema,
  EmbeddingServiceConfigSchema,
} from './schema';

export {
  PostgresGraphAdapter,
  LLMEntityExtractor,
  GraphInferenceEngine,
  GraphContextBuilder,
  EntityTypeSchema,
  RelationTypeSchema,
  NodeSourceSchema,
  GraphNodeSchema,
  GraphEdgeSchema,
  ExtractedEntitySchema,
  ExtractedRelationSchema,
  ExtractionResultSchema,
  NodeQuerySchema,
  EdgeQuerySchema,
  TraversalDirectionSchema,
  TraversalOptionsSchema,
  GraphSemanticSearchOptionsSchema,
  InferencePatternSchema,
  InferenceConclusionSchema,
  InferenceRuleSchema,
  KnowledgeGraphExtractionConfigSchema,
  KnowledgeGraphInferenceConfigSchema,
  KnowledgeGraphContextConfigSchema,
  KnowledgeGraphConfigSchema,
} from './knowledge-graph/index';

export type {
  PostgresGraphAdapterConfig,
  LLMEntityExtractorConfig,
  LLMBackendMinimal,
  GraphContextBuilderConfig,
} from './knowledge-graph/index';

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
  GoogleEmbeddingConfig,
  ContextBuilderConfig,
  ContextStrategy,
  BuiltContext,
  MemoryConfig,
  GraphAdapter,
  GraphNode,
  GraphEdge,
  GraphPath,
  GraphStats,
  GraphContext,
  GraphContextOptions,
  NodeQuery,
  EdgeQuery,
  TraversalOptions,
  TraversalResult,
  TraversalDirection,
  GraphSemanticSearchOptions,
  EntityType,
  RelationType,
  NodeSource,
  ExtractedEntity,
  ExtractedRelation,
  ExtractionResult,
  ExtractionContext,
  EntityExtractor,
  InferenceEngine,
  InferenceRule,
  InferencePattern,
  InferenceConclusion,
  InferredEdge,
  InferenceOptions,
  KnowledgeGraphConfig,
  KnowledgeGraphExtractionConfig,
  KnowledgeGraphInferenceConfig,
  KnowledgeGraphContextConfig,
} from '@cogitator-ai/types';
