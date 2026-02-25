import { z } from 'zod';

export const EntityTypeSchema = z.enum([
  'person',
  'organization',
  'location',
  'concept',
  'event',
  'object',
  'custom',
]);

export const RelationTypeSchema = z.enum([
  'knows',
  'works_at',
  'located_in',
  'part_of',
  'related_to',
  'created_by',
  'belongs_to',
  'associated_with',
  'causes',
  'precedes',
  'custom',
]);

export const NodeSourceSchema = z.enum(['extracted', 'user', 'inferred']);

export const GraphNodeSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  type: EntityTypeSchema,
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  description: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).default({}),
  embedding: z.array(z.number()).optional(),
  confidence: z.number().min(0).max(1),
  source: NodeSourceSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
  lastAccessedAt: z.date(),
  accessCount: z.number().int().min(0),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const GraphEdgeSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  sourceNodeId: z.string(),
  targetNodeId: z.string(),
  type: RelationTypeSchema,
  label: z.string().optional(),
  weight: z.number().min(0).max(1).default(1),
  bidirectional: z.boolean().default(false),
  properties: z.record(z.string(), z.unknown()).default({}),
  confidence: z.number().min(0).max(1),
  source: NodeSourceSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
  validFrom: z.date().optional(),
  validUntil: z.date().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const ExtractedEntitySchema = z.object({
  name: z.string().min(1),
  type: EntityTypeSchema,
  aliases: z.array(z.string()).optional(),
  description: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  confidence: z.number().min(0).max(1),
});

export const ExtractedRelationSchema = z.object({
  sourceEntity: z.string().min(1),
  targetEntity: z.string().min(1),
  type: RelationTypeSchema,
  label: z.string().optional(),
  weight: z.number().min(0).max(1).optional(),
  bidirectional: z.boolean().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  confidence: z.number().min(0).max(1),
});

export const ExtractionResultSchema = z.object({
  entities: z.array(ExtractedEntitySchema),
  relations: z.array(ExtractedRelationSchema),
  text: z.string(),
  timestamp: z.date(),
});

export const NodeQuerySchema = z.object({
  agentId: z.string(),
  types: z.array(EntityTypeSchema).optional(),
  namePattern: z.string().optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  limit: z.number().int().positive().optional(),
  includeEmbedding: z.boolean().optional(),
});

export const EdgeQuerySchema = z.object({
  agentId: z.string(),
  sourceNodeId: z.string().optional(),
  targetNodeId: z.string().optional(),
  types: z.array(RelationTypeSchema).optional(),
  minWeight: z.number().min(0).max(1).optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  bidirectionalOnly: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
});

export const TraversalDirectionSchema = z.enum(['outgoing', 'incoming', 'both']);

export const TraversalOptionsSchema = z.object({
  agentId: z.string(),
  startNodeId: z.string(),
  maxDepth: z.number().int().min(1).max(10).default(3),
  direction: TraversalDirectionSchema.default('both'),
  edgeTypes: z.array(RelationTypeSchema).optional(),
  minEdgeWeight: z.number().min(0).max(1).optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  limit: z.number().int().positive().optional(),
});

export const GraphSemanticSearchOptionsSchema = z.object({
  agentId: z.string(),
  query: z.string().optional(),
  vector: z.array(z.number()).optional(),
  limit: z.number().int().positive().optional(),
  threshold: z.number().min(0).max(1).optional(),
  entityTypes: z.array(EntityTypeSchema).optional(),
});

export const InferencePatternSchema = z.object({
  edgeTypes: z.array(RelationTypeSchema).min(1),
  minPathLength: z.number().int().min(2),
  maxPathLength: z.number().int().min(2),
  nodeTypeConstraints: z.record(z.string(), z.array(EntityTypeSchema)).optional(),
});

export const InferenceConclusionSchema = z.object({
  edgeType: RelationTypeSchema,
  label: z.string().optional(),
  weightFormula: z.enum(['min', 'max', 'average', 'product']),
  bidirectional: z.boolean(),
});

export const InferenceRuleSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string(),
  pattern: InferencePatternSchema,
  conclusion: InferenceConclusionSchema,
  confidence: z.number().min(0).max(1),
  enabled: z.boolean(),
});

export const KnowledgeGraphExtractionConfigSchema = z.object({
  enabled: z.boolean(),
  extractOnMessage: z.boolean().optional(),
  extractOnFact: z.boolean().optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  batchSize: z.number().int().positive().optional(),
});

export const KnowledgeGraphInferenceConfigSchema = z.object({
  enabled: z.boolean(),
  autoMaterialize: z.boolean().optional(),
  defaultRules: z.boolean().optional(),
  customRules: z.array(InferenceRuleSchema.omit({ id: true })).optional(),
});

export const KnowledgeGraphContextConfigSchema = z.object({
  maxNodes: z.number().int().positive().optional(),
  maxEdges: z.number().int().positive().optional(),
  maxDepth: z.number().int().min(1).max(10).optional(),
  includeInferred: z.boolean().optional(),
});

export const KnowledgeGraphConfigSchema = z.object({
  extraction: KnowledgeGraphExtractionConfigSchema.optional(),
  inference: KnowledgeGraphInferenceConfigSchema.optional(),
  context: KnowledgeGraphContextConfigSchema.optional(),
});
