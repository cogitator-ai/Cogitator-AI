import type {
  InferenceEngine,
  InferenceRule,
  InferredEdge,
  InferenceOptions,
  GraphAdapter,
  GraphEdge,
  MemoryResult,
  RelationType,
} from '@cogitator-ai/types';
import { nanoid } from 'nanoid';

const DEFAULT_RULES: Omit<InferenceRule, 'id'>[] = [
  {
    name: 'transitive_knows',
    description: 'If A knows B and B knows C, then A is related to C',
    pattern: {
      edgeTypes: ['knows', 'knows'],
      minPathLength: 2,
      maxPathLength: 2,
    },
    conclusion: {
      edgeType: 'related_to',
      label: 'indirect_connection',
      weightFormula: 'min',
      bidirectional: true,
    },
    confidence: 0.6,
    enabled: true,
  },
  {
    name: 'colleagues',
    description: 'People who work at the same organization are colleagues',
    pattern: {
      edgeTypes: ['works_at', 'works_at'],
      minPathLength: 2,
      maxPathLength: 2,
      nodeTypeConstraints: {
        0: ['person'],
        1: ['organization'],
        2: ['person'],
      },
    },
    conclusion: {
      edgeType: 'associated_with',
      label: 'colleague',
      weightFormula: 'min',
      bidirectional: true,
    },
    confidence: 0.8,
    enabled: true,
  },
  {
    name: 'location_hierarchy',
    description: 'Transitive location containment',
    pattern: {
      edgeTypes: ['located_in', 'located_in'],
      minPathLength: 2,
      maxPathLength: 3,
      nodeTypeConstraints: {
        0: ['location', 'organization', 'person'],
        1: ['location'],
        2: ['location'],
      },
    },
    conclusion: {
      edgeType: 'located_in',
      weightFormula: 'product',
      bidirectional: false,
    },
    confidence: 0.9,
    enabled: true,
  },
  {
    name: 'part_of_hierarchy',
    description: 'Transitive part-of relationship',
    pattern: {
      edgeTypes: ['part_of', 'part_of'],
      minPathLength: 2,
      maxPathLength: 3,
    },
    conclusion: {
      edgeType: 'part_of',
      weightFormula: 'product',
      bidirectional: false,
    },
    confidence: 0.85,
    enabled: true,
  },
  {
    name: 'causality_chain',
    description: 'If A causes B and B causes C, then A indirectly causes C',
    pattern: {
      edgeTypes: ['causes', 'causes'],
      minPathLength: 2,
      maxPathLength: 2,
    },
    conclusion: {
      edgeType: 'causes',
      label: 'indirect_cause',
      weightFormula: 'product',
      bidirectional: false,
    },
    confidence: 0.7,
    enabled: true,
  },
];

export class GraphInferenceEngine implements InferenceEngine {
  private rules = new Map<string, InferenceRule>();
  private graphAdapter: GraphAdapter;

  constructor(graphAdapter: GraphAdapter, useDefaultRules = true) {
    this.graphAdapter = graphAdapter;

    if (useDefaultRules) {
      for (const rule of DEFAULT_RULES) {
        this.registerRule(rule);
      }
    }
  }

  registerRule(rule: Omit<InferenceRule, 'id'>): string {
    const id = `rule_${nanoid(8)}`;
    this.rules.set(id, { ...rule, id });
    return id;
  }

  removeRule(ruleId: string): void {
    this.rules.delete(ruleId);
  }

  getRules(): InferenceRule[] {
    return Array.from(this.rules.values());
  }

  enableRule(ruleId: string): void {
    const rule = this.rules.get(ruleId);
    if (rule) {
      rule.enabled = true;
    }
  }

  disableRule(ruleId: string): void {
    const rule = this.rules.get(ruleId);
    if (rule) {
      rule.enabled = false;
    }
  }

  async infer(agentId: string, options?: InferenceOptions): Promise<InferredEdge[]> {
    const inferred: InferredEdge[] = [];
    const seenPairs = new Set<string>();

    const rulesToApply = options?.ruleIds
      ? Array.from(this.rules.values()).filter((r) => options.ruleIds!.includes(r.id))
      : Array.from(this.rules.values()).filter((r) => r.enabled);

    for (const rule of rulesToApply) {
      const ruleInferences = await this.applyRule(agentId, rule, options);

      for (const edge of ruleInferences) {
        const pairKey = `${edge.sourceNodeId}:${edge.targetNodeId}:${edge.type}`;
        const reversePairKey = `${edge.targetNodeId}:${edge.sourceNodeId}:${edge.type}`;

        if (!seenPairs.has(pairKey) && !seenPairs.has(reversePairKey)) {
          inferred.push(edge);
          seenPairs.add(pairKey);
          if (edge.bidirectional) {
            seenPairs.add(reversePairKey);
          }
        }

        if (options?.maxInferences && inferred.length >= options.maxInferences) {
          return inferred;
        }
      }
    }

    return inferred;
  }

  private async applyRule(
    agentId: string,
    rule: InferenceRule,
    options?: InferenceOptions
  ): Promise<InferredEdge[]> {
    const inferred: InferredEdge[] = [];

    const firstEdgeType = rule.pattern.edgeTypes[0];
    const edgesResult = await this.graphAdapter.queryEdges({
      agentId,
      types: [firstEdgeType],
      minConfidence: options?.minConfidence,
    });

    if (!edgesResult.success) return inferred;

    for (const startEdge of edgesResult.data) {
      if (options?.nodeFilter && !options.nodeFilter.includes(startEdge.sourceNodeId)) {
        continue;
      }

      const paths = await this.findMatchingPaths(
        agentId,
        startEdge,
        rule.pattern.edgeTypes.slice(1),
        rule.pattern.maxPathLength,
        rule.pattern.nodeTypeConstraints,
        options?.minConfidence
      );

      for (const path of paths) {
        const allEdges = [startEdge, ...path];
        if (allEdges.length < rule.pattern.minPathLength) continue;
        const sourceNodeId = startEdge.sourceNodeId;
        const targetNodeId = path[path.length - 1].targetNodeId;

        if (sourceNodeId === targetNodeId) continue;

        const existingEdges = await this.graphAdapter.getEdgesBetween(sourceNodeId, targetNodeId);
        if (
          existingEdges.success &&
          existingEdges.data.some((e) => e.type === rule.conclusion.edgeType)
        ) {
          continue;
        }

        const weight = this.calculateWeight(allEdges, rule.conclusion.weightFormula);
        const confidence = Math.min(rule.confidence, ...allEdges.map((e) => e.confidence));

        if (options?.minConfidence && confidence < options.minConfidence) continue;

        inferred.push({
          agentId,
          sourceNodeId,
          targetNodeId,
          type: rule.conclusion.edgeType,
          label: rule.conclusion.label,
          weight,
          bidirectional: rule.conclusion.bidirectional,
          properties: {},
          confidence,
          source: 'inferred',
          ruleId: rule.id,
          supportingPath: allEdges.map((e) => e.id),
        });
      }
    }

    return inferred;
  }

  private async findMatchingPaths(
    agentId: string,
    currentEdge: GraphEdge,
    remainingTypes: RelationType[],
    maxDepth: number,
    nodeTypeConstraints?: Record<number, string[]>,
    minConfidence?: number,
    currentDepth = 1
  ): Promise<GraphEdge[][]> {
    if (remainingTypes.length === 0 || currentDepth >= maxDepth) {
      return [[]];
    }

    const nextType = remainingTypes[0];
    const currentNodeId = currentEdge.targetNodeId;

    if (nodeTypeConstraints?.[currentDepth]) {
      const nodeResult = await this.graphAdapter.getNode(currentNodeId);
      if (nodeResult.success && nodeResult.data) {
        const allowedTypes = nodeTypeConstraints[currentDepth];
        if (!allowedTypes.includes(nodeResult.data.type)) {
          return [];
        }
      }
    }

    const forwardResult = await this.graphAdapter.queryEdges({
      agentId,
      sourceNodeId: currentNodeId,
      types: [nextType],
      minConfidence,
    });

    const reverseResult = await this.graphAdapter.queryEdges({
      agentId,
      targetNodeId: currentNodeId,
      types: [nextType],
      minConfidence,
    });

    const orientedEdges: GraphEdge[] = [];

    if (forwardResult.success) {
      orientedEdges.push(...forwardResult.data);
    }

    if (reverseResult.success) {
      for (const edge of reverseResult.data) {
        orientedEdges.push({
          ...edge,
          sourceNodeId: edge.targetNodeId,
          targetNodeId: edge.sourceNodeId,
        });
      }
    }

    const paths: GraphEdge[][] = [];

    for (const nextEdge of orientedEdges) {
      const subPaths = await this.findMatchingPaths(
        agentId,
        nextEdge,
        remainingTypes.slice(1),
        maxDepth,
        nodeTypeConstraints,
        minConfidence,
        currentDepth + 1
      );

      for (const subPath of subPaths) {
        paths.push([nextEdge, ...subPath]);
      }
    }

    return paths;
  }

  private calculateWeight(
    edges: GraphEdge[],
    formula: 'min' | 'max' | 'average' | 'product'
  ): number {
    const weights = edges.map((e) => e.weight);

    switch (formula) {
      case 'min':
        return Math.min(...weights);
      case 'max':
        return Math.max(...weights);
      case 'average':
        return weights.reduce((a, b) => a + b, 0) / weights.length;
      case 'product':
        return weights.reduce((a, b) => a * b, 1);
    }
  }

  async materialize(edges: InferredEdge[]): Promise<MemoryResult<GraphEdge[]>> {
    const materialized: GraphEdge[] = [];

    for (const edge of edges) {
      const { ruleId, supportingPath, ...edgeData } = edge;

      const result = await this.graphAdapter.addEdge({
        ...edgeData,
        metadata: {
          ...edgeData.metadata,
          inferredBy: ruleId,
          supportingPath,
        },
      });

      if (result.success) {
        materialized.push(result.data);
      }
    }

    return { success: true, data: materialized };
  }
}
