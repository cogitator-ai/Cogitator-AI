import type { MemoryResult } from './memory';

export type EntityType =
  | 'person'
  | 'organization'
  | 'location'
  | 'concept'
  | 'event'
  | 'object'
  | 'custom';

export type RelationType =
  | 'knows'
  | 'works_at'
  | 'located_in'
  | 'part_of'
  | 'related_to'
  | 'created_by'
  | 'belongs_to'
  | 'associated_with'
  | 'causes'
  | 'precedes'
  | 'custom';

export type NodeSource = 'extracted' | 'user' | 'inferred';

export interface GraphNode {
  id: string;
  agentId: string;
  type: EntityType;
  name: string;
  aliases: string[];
  description?: string;
  properties: Record<string, unknown>;
  embedding?: number[];
  confidence: number;
  source: NodeSource;
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt: Date;
  accessCount: number;
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  agentId: string;
  sourceNodeId: string;
  targetNodeId: string;
  type: RelationType;
  label?: string;
  weight: number;
  bidirectional: boolean;
  properties: Record<string, unknown>;
  confidence: number;
  source: NodeSource;
  createdAt: Date;
  updatedAt: Date;
  validFrom?: Date;
  validUntil?: Date;
  metadata?: Record<string, unknown>;
}

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  aliases?: string[];
  description?: string;
  properties?: Record<string, unknown>;
  confidence: number;
}

export interface ExtractedRelation {
  sourceEntity: string;
  targetEntity: string;
  type: RelationType;
  label?: string;
  weight?: number;
  bidirectional?: boolean;
  properties?: Record<string, unknown>;
  confidence: number;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  text: string;
  timestamp: Date;
}

export interface ExtractionContext {
  agentId: string;
  existingEntities?: string[];
  entityTypeHints?: EntityType[];
  relationTypeHints?: RelationType[];
}

export interface NodeQuery {
  agentId: string;
  types?: EntityType[];
  namePattern?: string;
  minConfidence?: number;
  limit?: number;
  includeEmbedding?: boolean;
}

export interface EdgeQuery {
  agentId: string;
  sourceNodeId?: string;
  targetNodeId?: string;
  types?: RelationType[];
  minWeight?: number;
  minConfidence?: number;
  bidirectionalOnly?: boolean;
  limit?: number;
}

export type TraversalDirection = 'outgoing' | 'incoming' | 'both';

export interface TraversalOptions {
  agentId: string;
  startNodeId: string;
  maxDepth: number;
  direction: TraversalDirection;
  edgeTypes?: RelationType[];
  minEdgeWeight?: number;
  minConfidence?: number;
  limit?: number;
}

export interface GraphPath {
  nodes: GraphNode[];
  edges: GraphEdge[];
  totalWeight: number;
  length: number;
}

export interface TraversalResult {
  paths: GraphPath[];
  visitedNodes: GraphNode[];
  visitedEdges: GraphEdge[];
  depth: number;
}

export interface GraphSemanticSearchOptions {
  agentId: string;
  query?: string;
  vector?: number[];
  limit?: number;
  threshold?: number;
  entityTypes?: EntityType[];
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  nodesByType: Partial<Record<EntityType, number>>;
  edgesByType: Partial<Record<RelationType, number>>;
  averageEdgesPerNode: number;
  maxDepth: number;
}

export interface InferencePattern {
  edgeTypes: RelationType[];
  minPathLength: number;
  maxPathLength: number;
  nodeTypeConstraints?: Record<number, EntityType[]>;
}

export interface InferenceConclusion {
  edgeType: RelationType;
  label?: string;
  weightFormula: 'min' | 'max' | 'average' | 'product';
  bidirectional: boolean;
}

export interface InferenceRule {
  id: string;
  name: string;
  description: string;
  pattern: InferencePattern;
  conclusion: InferenceConclusion;
  confidence: number;
  enabled: boolean;
}

export interface InferredEdge extends Omit<GraphEdge, 'id' | 'createdAt' | 'updatedAt'> {
  ruleId: string;
  supportingPath: string[];
}

export interface InferenceOptions {
  ruleIds?: string[];
  minConfidence?: number;
  maxInferences?: number;
  nodeFilter?: string[];
}

export interface GraphAdapter {
  addNode(
    node: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt' | 'lastAccessedAt' | 'accessCount'>
  ): Promise<MemoryResult<GraphNode>>;
  getNode(nodeId: string): Promise<MemoryResult<GraphNode | null>>;
  getNodeByName(agentId: string, name: string): Promise<MemoryResult<GraphNode | null>>;
  updateNode(
    nodeId: string,
    updates: Partial<
      Pick<
        GraphNode,
        'name' | 'aliases' | 'description' | 'properties' | 'confidence' | 'metadata' | 'embedding'
      >
    >
  ): Promise<MemoryResult<GraphNode>>;
  deleteNode(nodeId: string): Promise<MemoryResult<void>>;
  queryNodes(query: NodeQuery): Promise<MemoryResult<GraphNode[]>>;
  searchNodesSemantic(
    options: GraphSemanticSearchOptions
  ): Promise<MemoryResult<(GraphNode & { score: number })[]>>;

  addEdge(
    edge: Omit<GraphEdge, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<MemoryResult<GraphEdge>>;
  getEdge(edgeId: string): Promise<MemoryResult<GraphEdge | null>>;
  getEdgesBetween(sourceNodeId: string, targetNodeId: string): Promise<MemoryResult<GraphEdge[]>>;
  updateEdge(
    edgeId: string,
    updates: Partial<
      Pick<
        GraphEdge,
        'weight' | 'label' | 'properties' | 'confidence' | 'validFrom' | 'validUntil' | 'metadata'
      >
    >
  ): Promise<MemoryResult<GraphEdge>>;
  deleteEdge(edgeId: string): Promise<MemoryResult<void>>;
  queryEdges(query: EdgeQuery): Promise<MemoryResult<GraphEdge[]>>;

  traverse(options: TraversalOptions): Promise<MemoryResult<TraversalResult>>;
  findShortestPath(
    agentId: string,
    startNodeId: string,
    endNodeId: string,
    maxDepth?: number
  ): Promise<MemoryResult<GraphPath | null>>;
  getNeighbors(
    nodeId: string,
    direction?: TraversalDirection
  ): Promise<MemoryResult<{ node: GraphNode; edge: GraphEdge }[]>>;

  mergeNodes(targetNodeId: string, sourceNodeIds: string[]): Promise<MemoryResult<GraphNode>>;
  clearGraph(agentId: string): Promise<MemoryResult<void>>;
  getGraphStats(agentId: string): Promise<MemoryResult<GraphStats>>;
}

export interface EntityExtractor {
  extract(text: string, context?: ExtractionContext): Promise<ExtractionResult>;
  extractBatch(texts: string[], context?: ExtractionContext): Promise<ExtractionResult[]>;
}

export interface InferenceEngine {
  registerRule(rule: Omit<InferenceRule, 'id'>): string;
  removeRule(ruleId: string): void;
  getRules(): InferenceRule[];
  enableRule(ruleId: string): void;
  disableRule(ruleId: string): void;

  infer(agentId: string, options?: InferenceOptions): Promise<InferredEdge[]>;
  materialize(edges: InferredEdge[]): Promise<MemoryResult<GraphEdge[]>>;
}

export interface GraphContext {
  nodes: GraphNode[];
  edges: GraphEdge[];
  formattedContext: string;
  tokenCount: number;
}

export interface GraphContextOptions {
  maxNodes?: number;
  maxEdges?: number;
  maxDepth?: number;
  includeInferred?: boolean;
  entityTypes?: EntityType[];
}

export interface KnowledgeGraphExtractionConfig {
  enabled: boolean;
  extractOnMessage?: boolean;
  extractOnFact?: boolean;
  minConfidence?: number;
  batchSize?: number;
}

export interface KnowledgeGraphInferenceConfig {
  enabled: boolean;
  autoMaterialize?: boolean;
  defaultRules?: boolean;
  customRules?: Omit<InferenceRule, 'id'>[];
}

export interface KnowledgeGraphContextConfig {
  maxNodes?: number;
  maxEdges?: number;
  maxDepth?: number;
  includeInferred?: boolean;
}

export interface KnowledgeGraphConfig {
  extraction?: KnowledgeGraphExtractionConfig;
  inference?: KnowledgeGraphInferenceConfig;
  context?: KnowledgeGraphContextConfig;
}

export const DEFAULT_KNOWLEDGE_GRAPH_CONFIG: KnowledgeGraphConfig = {
  extraction: {
    enabled: true,
    extractOnMessage: true,
    extractOnFact: true,
    minConfidence: 0.7,
    batchSize: 10,
  },
  inference: {
    enabled: true,
    autoMaterialize: false,
    defaultRules: true,
    customRules: [],
  },
  context: {
    maxNodes: 20,
    maxEdges: 50,
    maxDepth: 3,
    includeInferred: true,
  },
};
