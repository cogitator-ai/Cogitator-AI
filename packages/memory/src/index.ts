/**
 * @cogitator-ai/memory
 *
 * Memory adapters for Cogitator AI agents
 */

export {
  BaseMemoryAdapter,
  ChangeReportingMemoryAdapter,
  BranchingMemoryAdapter,
  REDACTED_TEXT,
  FORKS_KEY,
  MEMORY_USERS_KEY,
  redactedEntry,
  InMemoryAdapter,
  createMemoryAdapter,
  createEmbeddingAdapter,
  type MemoryAdapterConfigUnion,
  type EmbeddingAdapterConfigUnion,
  type ConnectableEmbeddingAdapter,
} from './adapters/index';

export { RedisAdapter } from './adapters/redis';
export { PostgresAdapter, type VectorStoreState } from './adapters/postgres';
export { SQLiteAdapter } from './adapters/sqlite';
export { MongoDBAdapter } from './adapters/mongodb';
export { QdrantAdapter } from './adapters/qdrant';
export { InMemoryEmbeddingAdapter } from './adapters/memory-embedding';

export {
  HybridSearch,
  BM25Index,
  fuseSearchResults,
  reciprocalRankFusion,
  tokenize,
  getTermFrequency,
  type BM25Config,
  type BM25Document,
  type BM25Result,
  type RRFConfig,
  type TokenizerConfig,
} from './search/index';

export {
  ContextBuilder,
  formatTurnContext,
  extendTurnContext,
  markTurnEnds,
  withoutTurnContext,
  type ContextBuilderDeps,
  type BuildContextOptions,
} from './context-builder';
export {
  ContextAssembler,
  DEFAULT_PARTITIONS,
  fitInOrder,
  type Assembly,
  type AssemblyBlock,
  type FitResult,
  type PartitionCandidates,
} from './context-assembler';

export {
  verifyEvidence,
  evidenceOnPath,
  verifyEvidenceInMemory,
  type CheckedEvidence,
} from './lineage';

export {
  MessageIndex,
  indexedText,
  type MessageIndexOptions,
  type IndexedText,
} from './message-index';

export {
  countTokens,
  countMessageTokens,
  countMessagesTokens,
  countToolCallsTokens,
  countEntryTokens,
  truncateToTokens,
} from './token-counter';

export {
  OpenAIEmbeddingService,
  OllamaEmbeddingService,
  GoogleEmbeddingService,
  createEmbeddingService,
} from './embedding/index';

export { unwrap } from './result';

export { CoreFactsStore } from './core-facts';
export type { CoreFactsStoreConfig, FactHistoryEntry } from './core-facts';

export { SessionManager, type SessionManagerOptions } from './session-manager';
export {
  CompactionService,
  checkCompactionSettings,
  compactedHistory,
  readCompactedHistory,
  sinceSummary,
  HISTORY_ENTRY_TYPES,
  type SummarizeFn,
  type SummarizeOptions,
  type CompactionServiceConfig,
} from './compaction';
export { CONTROL_KINDS, SAGA_ATOMS } from './compaction-hierarchy';

export {
  MemoryProviderSchema,
  InMemoryConfigSchema,
  RedisConfigSchema,
  PostgresConfigSchema,
  SQLiteConfigSchema,
  MongoDBConfigSchema,
  QdrantConfigSchema,
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
  SQLiteGraphAdapter,
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
  SQLiteGraphAdapterConfig,
  LLMEntityExtractorConfig,
  LLMBackendMinimal,
  GraphContextBuilderConfig,
} from './knowledge-graph/index';

export type {
  SQLiteAdapterConfig,
  MongoDBAdapterConfig,
  QdrantAdapterConfig,
  MemoryType,
  Thread,
  MemoryEntry,
  MemoryEntryType,
  NewMemoryEntry,
  PathQueryOptions,
  Evidence,
  EvidenceStatus,
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
  DroppedContext,
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
  SearchStrategy,
  HybridSearchWeights,
  SearchFilter,
  SearchOptions,
  SearchResult,
  KeywordSearchOptions,
  KeywordSearchAdapter,
  HybridSearchConfig,
  Session,
  SessionManager as ISessionManager,
  SessionFilter,
  SessionStatus,
  SessionConfigOverrides,
  CompactionConfig,
  CompactionResult,
} from '@cogitator-ai/types';

export {
  MemoryItems,
  DEFAULT_ACTIVATION_CONFIDENCE,
  OPINION_GAIN,
  OPINION_LOSS,
  byRecorded,
  entityNames,
  isMemoryItemAdapter,
  matchesEntityFilter,
  matchesItemFilter,
  normalizeName,
  sameValue,
  slotOf,
  visibleIn,
  type MemoryItemsConfig,
} from './memory-items';
export {
  MemoryBriefer,
  BRIEF_PROMPT,
  MAX_BRIEF_CARDS,
  briefBlock,
  parseBrief,
  type BriefSource,
  type MemoryBrieferOptions,
} from './memory-brief';
export { inert } from './memory-files';
export {
  MemoryObservations,
  OBSERVATIONS_DIRECTORY,
  OBSERVATION_PROMPT,
  namedIn,
  parseObservation,
  parseObservationAnswer,
  type MemoryObservation,
  type MemoryObservationsOptions,
  type ObservationsRefresh,
  type RefreshObservationsOptions,
} from './memory-observations';
export {
  MemoryConsolidator,
  DEDUPE_PROMPT,
  PLAYBOOK_PROMPT,
  PLAYBOOK_PATH,
  PLAYBOOK_DRAFT_PATH,
  MEMORY_RESERVED_PATHS,
  MAX_PLAYBOOK_EDITS,
  MAX_PLAYBOOK_RULES,
  applyPlaybookEdits,
  parsePlaybook,
  parsePlaybookEdits,
  playbookFile,
  type DedupeOptions,
  type DedupeResult,
  type FoldLessonsOptions,
  type MemoryConsolidatorOptions,
  type Playbook,
  type PlaybookChange,
  type PlaybookEdit,
} from './memory-consolidation';
export {
  MemoryCascade,
  type CascadeAgents,
  type MemoryCascadeOptions,
  type MemoryCascadeReport,
} from './memory-cascade';
export {
  MemoryFiles,
  MemoryFileError,
  MEMORY_ROOT,
  REDACTED_CONTENT,
  MAX_FILE_BYTES,
  MAX_CHANGE_BYTES,
  memoryPath,
  sha256Of,
  isMemoryFileAdapter,
  matchesFileFilter,
  byFileVersion,
  fileKeyOf,
  fileHeads,
  type MemoryFile,
  type MemoryFileAccess,
  type MemoryFileCommand,
  type MemoryFilePlace,
  type MemoryFilesOptions,
} from './memory-files';
export {
  MemoryRetriever,
  MIN_COSINE,
  RELATIVE_COSINE,
  type Retrieval,
  type RetrievalRequest,
  type RetrievedEntry,
  type RetrievedItem,
} from './retrieval/retriever';
export {
  analyzeQuery,
  timeExpressionOf,
  type QueryAnalysis,
  type QueryType,
} from './retrieval/query';
export {
  calendarDate,
  isTimeZone,
  resolveTime,
  type TimeExpression,
  type Weekday,
} from './time-resolution';
export {
  EXTRACTION_CONTINUATIONS,
  EXTRACTION_PROMPT,
  ExtractionAnswerError,
  MemoryExtractor,
  WindowError,
  extractionContinuationPrompt,
  parseExtraction,
  sessionLine,
  trustOfEntry,
  type MemoryExtractionContext,
  type MemoryExtractorConfig,
} from './memory-extraction';
