export {
  MemoryGraphAdapter,
  createMemoryGraphAdapter,
  PostgresGraphAdapter,
  createPostgresGraphAdapter,
  Neo4jGraphAdapter,
  createNeo4jGraphAdapter,
  type PostgresGraphAdapterConfig,
  type Neo4jGraphAdapterConfig,
} from './adapters';

export {
  executeQuery,
  GraphQueryBuilder,
  variable,
  parseQueryString,
  formatQueryResult,
  type QueryExecutionContext,
  type ParsedPattern,
} from './query-language';

export {
  analyzeNLQuery,
  buildQueryFromAnalysis,
  executeNLQuery,
  createNLToGraphQueryPrompt,
  parseNLQueryResponse,
  suggestQuestions,
  generateClarifications,
  type NLQueryContext,
  type NLQueryAnalysis,
  type NLQueryPromptContext,
  type QueryClarification,
} from './natural-language-query';

export {
  ReasoningEngine,
  createReasoningEngine,
  findPath,
  multiHopQuery,
  inferTransitiveRelations,
  inferInverseRelations,
  inferComposedRelations,
  runFullInference,
  type ReasoningConfig,
  type ReasoningContext,
  type ReasoningResult,
  type ReasoningStep,
  type CompositionRule,
} from './reasoning-engine';

export {
  createGraphContextPrompt,
  createQueryExplanationPrompt,
  createPathExplanationPrompt,
  createEntityExtractionPrompt,
  createReasoningExplanationPrompt,
  createGraphSummaryPrompt,
  parseEntityExtractionResponse,
  formatNodeForPrompt,
  formatEdgeForPrompt,
  formatPathForPrompt,
  type GraphContextForPrompt,
  type QueryToNLContext,
  type PathExplanationContext,
  type EntityExtractionContext,
  type ReasoningExplanationContext,
  type GraphSummaryContext,
} from './prompts';

export { cosineSimilarity, extractJSON } from './utils';
