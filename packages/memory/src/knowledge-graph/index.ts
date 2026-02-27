export { PostgresGraphAdapter } from './graph-adapter';
export type { PostgresGraphAdapterConfig } from './graph-adapter';

export { SQLiteGraphAdapter } from './sqlite-graph-adapter';
export type { SQLiteGraphAdapterConfig } from './sqlite-graph-adapter';

export { LLMEntityExtractor } from './entity-extractor';
export type { LLMEntityExtractorConfig, LLMBackendMinimal } from './entity-extractor';

export { GraphInferenceEngine } from './inference-engine';

export { GraphContextBuilder } from './graph-context-builder';
export type { GraphContextBuilderConfig } from './graph-context-builder';

export {
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
} from './schema';
