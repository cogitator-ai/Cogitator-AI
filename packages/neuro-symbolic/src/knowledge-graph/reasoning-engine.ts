import type {
  GraphNode,
  GraphEdge,
  GraphAdapter,
  GraphPath,
  InferredEdge,
  RelationType,
} from '@cogitator-ai/types';

export interface ReasoningConfig {
  maxHops: number;
  minConfidence: number;
  maxInferences: number;
  enableTransitivity: boolean;
  enableInverse: boolean;
  enableComposition: boolean;
}

const DEFAULT_REASONING_CONFIG: ReasoningConfig = {
  maxHops: 3,
  minConfidence: 0.5,
  maxInferences: 100,
  enableTransitivity: true,
  enableInverse: true,
  enableComposition: true,
};

export interface ReasoningContext {
  adapter: GraphAdapter;
  agentId: string;
  config: ReasoningConfig;
}

export interface ReasoningResult {
  paths: GraphPath[];
  inferences: InferredEdge[];
  confidence: number;
  steps: ReasoningStep[];
}

export interface ReasoningStep {
  type: 'traverse' | 'infer' | 'compose' | 'inverse';
  description: string;
  fromNode?: string;
  toNode?: string;
  relation?: string;
  confidence: number;
}

const INVERSE_RELATIONS: Record<string, RelationType> = {
  works_at: 'custom',
  part_of: 'custom',
  belongs_to: 'custom',
  created_by: 'custom',
  knows: 'knows',
  related_to: 'related_to',
  associated_with: 'associated_with',
};

const TRANSITIVE_RELATIONS: RelationType[] = [
  'part_of',
  'located_in',
  'related_to',
  'associated_with',
];

export async function findPath(
  ctx: ReasoningContext,
  startNodeId: string,
  endNodeId: string
): Promise<ReasoningResult> {
  const result: ReasoningResult = {
    paths: [],
    inferences: [],
    confidence: 0,
    steps: [],
  };

  const pathResult = await ctx.adapter.findShortestPath(
    ctx.agentId,
    startNodeId,
    endNodeId,
    ctx.config.maxHops
  );

  if (pathResult.success && pathResult.data) {
    result.paths.push(pathResult.data);
    result.confidence = calculatePathConfidence(pathResult.data);

    for (let i = 0; i < pathResult.data.edges.length; i++) {
      const edge = pathResult.data.edges[i];
      const fromNode = pathResult.data.nodes[i];
      const toNode = pathResult.data.nodes[i + 1];

      result.steps.push({
        type: 'traverse',
        description: `${fromNode.name} --[${edge.label || edge.type}]--> ${toNode.name}`,
        fromNode: fromNode.id,
        toNode: toNode.id,
        relation: edge.type,
        confidence: edge.confidence,
      });
    }
  }

  return result;
}

function calculatePathConfidence(path: GraphPath): number {
  if (path.edges.length === 0) return 1.0;

  let confidence = 1.0;
  for (const edge of path.edges) {
    confidence *= edge.confidence;
  }

  return confidence;
}

export async function multiHopQuery(
  ctx: ReasoningContext,
  startNodeId: string,
  relationPath: RelationType[]
): Promise<ReasoningResult> {
  const result: ReasoningResult = {
    paths: [],
    inferences: [],
    confidence: 0,
    steps: [],
  };

  let currentNodes: GraphNode[] = [];

  const startResult = await ctx.adapter.getNode(startNodeId);
  if (!startResult.success || !startResult.data) {
    return result;
  }

  currentNodes.push(startResult.data);
  const paths: GraphPath[] = [
    {
      nodes: [startResult.data],
      edges: [],
      totalWeight: 1,
      length: 0,
    },
  ];

  for (const relationType of relationPath) {
    const nextNodes: GraphNode[] = [];
    const nextPaths: GraphPath[] = [];

    for (let i = 0; i < currentNodes.length; i++) {
      const node = currentNodes[i];
      const path = paths[i];

      const edgesResult = await ctx.adapter.queryEdges({
        agentId: ctx.agentId,
        sourceNodeId: node.id,
        types: [relationType],
      });

      if (!edgesResult.success || !edgesResult.data) continue;

      for (const edge of edgesResult.data) {
        const targetResult = await ctx.adapter.getNode(edge.targetNodeId);
        if (!targetResult.success || !targetResult.data) continue;

        const targetNode = targetResult.data;
        nextNodes.push(targetNode);

        nextPaths.push({
          nodes: [...path.nodes, targetNode],
          edges: [...path.edges, edge],
          totalWeight: path.totalWeight * edge.weight,
          length: path.length + 1,
        });

        result.steps.push({
          type: 'traverse',
          description: `${node.name} --[${relationType}]--> ${targetNode.name}`,
          fromNode: node.id,
          toNode: targetNode.id,
          relation: relationType,
          confidence: edge.confidence,
        });
      }
    }

    currentNodes = nextNodes;
    paths.length = 0;
    paths.push(...nextPaths);
  }

  result.paths = paths;

  if (paths.length > 0) {
    result.confidence = Math.max(...paths.map(calculatePathConfidence));
  }

  return result;
}

export async function inferTransitiveRelations(ctx: ReasoningContext): Promise<InferredEdge[]> {
  const inferred: InferredEdge[] = [];

  if (!ctx.config.enableTransitivity) {
    return inferred;
  }

  for (const relationType of TRANSITIVE_RELATIONS) {
    const edgesResult = await ctx.adapter.queryEdges({
      agentId: ctx.agentId,
      types: [relationType],
    });

    if (!edgesResult.success || !edgesResult.data) continue;

    const edges = edgesResult.data;
    const edgesBySource = new Map<string, GraphEdge[]>();

    for (const edge of edges) {
      if (!edgesBySource.has(edge.sourceNodeId)) {
        edgesBySource.set(edge.sourceNodeId, []);
      }
      edgesBySource.get(edge.sourceNodeId)!.push(edge);
    }

    for (const edge of edges) {
      const transitiveEdges = edgesBySource.get(edge.targetNodeId) || [];

      for (const transEdge of transitiveEdges) {
        if (transEdge.targetNodeId === edge.sourceNodeId) continue;

        const existingResult = await ctx.adapter.getEdgesBetween(
          edge.sourceNodeId,
          transEdge.targetNodeId
        );

        if (existingResult.success && existingResult.data && existingResult.data.length > 0) {
          const hasType = existingResult.data.some((e) => e.type === relationType);
          if (hasType) continue;
        }

        const confidence = Math.min(edge.confidence, transEdge.confidence) * 0.9;

        if (confidence < ctx.config.minConfidence) continue;

        inferred.push({
          agentId: ctx.agentId,
          sourceNodeId: edge.sourceNodeId,
          targetNodeId: transEdge.targetNodeId,
          type: relationType,
          label: `Inferred: ${relationType} (transitive)`,
          weight: Math.min(edge.weight, transEdge.weight),
          bidirectional: false,
          properties: {},
          confidence,
          source: 'inferred',
          ruleId: 'transitive',
          supportingPath: [edge.id, transEdge.id],
        });

        if (inferred.length >= ctx.config.maxInferences) {
          return inferred;
        }
      }
    }
  }

  return inferred;
}

export async function inferInverseRelations(ctx: ReasoningContext): Promise<InferredEdge[]> {
  const inferred: InferredEdge[] = [];

  if (!ctx.config.enableInverse) {
    return inferred;
  }

  for (const [sourceRel, targetRel] of Object.entries(INVERSE_RELATIONS)) {
    const edgesResult = await ctx.adapter.queryEdges({
      agentId: ctx.agentId,
      types: [sourceRel as RelationType],
    });

    if (!edgesResult.success || !edgesResult.data) continue;

    for (const edge of edgesResult.data) {
      if (edge.bidirectional) continue;

      const existingResult = await ctx.adapter.getEdgesBetween(
        edge.targetNodeId,
        edge.sourceNodeId
      );

      if (existingResult.success && existingResult.data && existingResult.data.length > 0) {
        continue;
      }

      const confidence = edge.confidence * 0.95;

      if (confidence < ctx.config.minConfidence) continue;

      inferred.push({
        agentId: ctx.agentId,
        sourceNodeId: edge.targetNodeId,
        targetNodeId: edge.sourceNodeId,
        type: targetRel,
        label: `Inferred: inverse of ${sourceRel}`,
        weight: edge.weight,
        bidirectional: false,
        properties: {},
        confidence,
        source: 'inferred',
        ruleId: 'inverse',
        supportingPath: [edge.id],
      });

      if (inferred.length >= ctx.config.maxInferences) {
        return inferred;
      }
    }
  }

  return inferred;
}

export interface CompositionRule {
  first: RelationType;
  second: RelationType;
  result: RelationType;
  confidenceMultiplier: number;
}

const COMPOSITION_RULES: CompositionRule[] = [
  { first: 'works_at', second: 'located_in', result: 'located_in', confidenceMultiplier: 0.8 },
  { first: 'part_of', second: 'part_of', result: 'part_of', confidenceMultiplier: 0.9 },
  { first: 'belongs_to', second: 'part_of', result: 'belongs_to', confidenceMultiplier: 0.85 },
  { first: 'knows', second: 'knows', result: 'related_to', confidenceMultiplier: 0.5 },
];

export async function inferComposedRelations(ctx: ReasoningContext): Promise<InferredEdge[]> {
  const inferred: InferredEdge[] = [];

  if (!ctx.config.enableComposition) {
    return inferred;
  }

  for (const rule of COMPOSITION_RULES) {
    const firstEdgesResult = await ctx.adapter.queryEdges({
      agentId: ctx.agentId,
      types: [rule.first],
    });

    if (!firstEdgesResult.success || !firstEdgesResult.data) continue;

    for (const firstEdge of firstEdgesResult.data) {
      const secondEdgesResult = await ctx.adapter.queryEdges({
        agentId: ctx.agentId,
        sourceNodeId: firstEdge.targetNodeId,
        types: [rule.second],
      });

      if (!secondEdgesResult.success || !secondEdgesResult.data) continue;

      for (const secondEdge of secondEdgesResult.data) {
        if (secondEdge.targetNodeId === firstEdge.sourceNodeId) continue;

        const existingResult = await ctx.adapter.getEdgesBetween(
          firstEdge.sourceNodeId,
          secondEdge.targetNodeId
        );

        if (existingResult.success && existingResult.data && existingResult.data.length > 0) {
          const hasType = existingResult.data.some((e) => e.type === rule.result);
          if (hasType) continue;
        }

        const confidence =
          Math.min(firstEdge.confidence, secondEdge.confidence) * rule.confidenceMultiplier;

        if (confidence < ctx.config.minConfidence) continue;

        inferred.push({
          agentId: ctx.agentId,
          sourceNodeId: firstEdge.sourceNodeId,
          targetNodeId: secondEdge.targetNodeId,
          type: rule.result,
          label: `Inferred: ${rule.first} + ${rule.second} = ${rule.result}`,
          weight: Math.min(firstEdge.weight, secondEdge.weight),
          bidirectional: false,
          properties: {
            compositionRule: `${rule.first} + ${rule.second}`,
          },
          confidence,
          source: 'inferred',
          ruleId: 'composition',
          supportingPath: [firstEdge.id, secondEdge.id],
        });

        if (inferred.length >= ctx.config.maxInferences) {
          return inferred;
        }
      }
    }
  }

  return inferred;
}

export async function runFullInference(ctx: ReasoningContext): Promise<InferredEdge[]> {
  const allInferred: InferredEdge[] = [];

  const transitive = await inferTransitiveRelations(ctx);
  allInferred.push(...transitive);

  if (allInferred.length >= ctx.config.maxInferences) {
    return allInferred.slice(0, ctx.config.maxInferences);
  }

  const inverse = await inferInverseRelations(ctx);
  allInferred.push(...inverse);

  if (allInferred.length >= ctx.config.maxInferences) {
    return allInferred.slice(0, ctx.config.maxInferences);
  }

  const composed = await inferComposedRelations(ctx);
  allInferred.push(...composed);

  return allInferred.slice(0, ctx.config.maxInferences);
}

export class ReasoningEngine {
  private ctx: ReasoningContext;

  constructor(adapter: GraphAdapter, agentId: string, config: Partial<ReasoningConfig> = {}) {
    this.ctx = {
      adapter,
      agentId,
      config: { ...DEFAULT_REASONING_CONFIG, ...config },
    };
  }

  async findPath(startNodeId: string, endNodeId: string): Promise<ReasoningResult> {
    return findPath(this.ctx, startNodeId, endNodeId);
  }

  async multiHopQuery(startNodeId: string, relationPath: RelationType[]): Promise<ReasoningResult> {
    return multiHopQuery(this.ctx, startNodeId, relationPath);
  }

  async infer(): Promise<InferredEdge[]> {
    return runFullInference(this.ctx);
  }

  async inferTransitive(): Promise<InferredEdge[]> {
    return inferTransitiveRelations(this.ctx);
  }

  async inferInverse(): Promise<InferredEdge[]> {
    return inferInverseRelations(this.ctx);
  }

  async inferComposed(): Promise<InferredEdge[]> {
    return inferComposedRelations(this.ctx);
  }

  updateConfig(config: Partial<ReasoningConfig>): void {
    this.ctx.config = { ...this.ctx.config, ...config };
  }
}

export function createReasoningEngine(
  adapter: GraphAdapter,
  agentId: string,
  config?: Partial<ReasoningConfig>
): ReasoningEngine {
  return new ReasoningEngine(adapter, agentId, config);
}
