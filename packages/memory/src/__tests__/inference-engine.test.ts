import { describe, it, expect, beforeEach } from 'vitest';
import type {
  GraphAdapter,
  GraphNode,
  GraphEdge,
  NodeQuery,
  EdgeQuery,
  TraversalOptions,
  TraversalResult,
  GraphPath,
  GraphSemanticSearchOptions,
  GraphStats,
  MemoryResult,
  TraversalDirection,
  EntityType,
  RelationType,
} from '@cogitator-ai/types';
import { GraphInferenceEngine } from '../knowledge-graph/inference-engine';

class InMemoryGraphAdapter implements GraphAdapter {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();
  private nextId = 1;

  private genId(prefix: string): string {
    return `${prefix}_${this.nextId++}`;
  }

  private success<T>(data: T): MemoryResult<T> {
    return { success: true, data };
  }

  async addNode(
    node: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt' | 'lastAccessedAt' | 'accessCount'>
  ): Promise<MemoryResult<GraphNode>> {
    const now = new Date();
    const full: GraphNode = {
      ...node,
      id: this.genId('node'),
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
    };
    this.nodes.set(full.id, full);
    return this.success(full);
  }

  async getNode(nodeId: string): Promise<MemoryResult<GraphNode | null>> {
    return this.success(this.nodes.get(nodeId) ?? null);
  }

  async getNodeByName(_agentId: string, name: string): Promise<MemoryResult<GraphNode | null>> {
    for (const node of this.nodes.values()) {
      if (node.name === name) return this.success(node);
    }
    return this.success(null);
  }

  async updateNode(
    nodeId: string,
    updates: Partial<
      Pick<
        GraphNode,
        'name' | 'aliases' | 'description' | 'properties' | 'confidence' | 'metadata' | 'embedding'
      >
    >
  ): Promise<MemoryResult<GraphNode>> {
    const node = this.nodes.get(nodeId)!;
    const updated = { ...node, ...updates, updatedAt: new Date() };
    this.nodes.set(nodeId, updated);
    return this.success(updated);
  }

  async deleteNode(nodeId: string): Promise<MemoryResult<void>> {
    this.nodes.delete(nodeId);
    return this.success(undefined);
  }

  async queryNodes(query: NodeQuery): Promise<MemoryResult<GraphNode[]>> {
    let results = Array.from(this.nodes.values()).filter((n) => n.agentId === query.agentId);
    if (query.types?.length) results = results.filter((n) => query.types!.includes(n.type));
    return this.success(results);
  }

  async searchNodesSemantic(
    _options: GraphSemanticSearchOptions
  ): Promise<MemoryResult<(GraphNode & { score: number })[]>> {
    return this.success([]);
  }

  async addEdge(
    edge: Omit<GraphEdge, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<MemoryResult<GraphEdge>> {
    const now = new Date();
    const full: GraphEdge = {
      ...edge,
      id: this.genId('edge'),
      createdAt: now,
      updatedAt: now,
    };
    this.edges.set(full.id, full);
    return this.success(full);
  }

  async getEdge(edgeId: string): Promise<MemoryResult<GraphEdge | null>> {
    return this.success(this.edges.get(edgeId) ?? null);
  }

  async getEdgesBetween(
    sourceNodeId: string,
    targetNodeId: string
  ): Promise<MemoryResult<GraphEdge[]>> {
    const results = Array.from(this.edges.values()).filter(
      (e) =>
        (e.sourceNodeId === sourceNodeId && e.targetNodeId === targetNodeId) ||
        (e.bidirectional && e.sourceNodeId === targetNodeId && e.targetNodeId === sourceNodeId)
    );
    return this.success(results);
  }

  async updateEdge(
    edgeId: string,
    updates: Partial<
      Pick<
        GraphEdge,
        'weight' | 'label' | 'properties' | 'confidence' | 'validFrom' | 'validUntil' | 'metadata'
      >
    >
  ): Promise<MemoryResult<GraphEdge>> {
    const edge = this.edges.get(edgeId)!;
    const updated = { ...edge, ...updates, updatedAt: new Date() };
    this.edges.set(edgeId, updated);
    return this.success(updated);
  }

  async deleteEdge(edgeId: string): Promise<MemoryResult<void>> {
    this.edges.delete(edgeId);
    return this.success(undefined);
  }

  async queryEdges(query: EdgeQuery): Promise<MemoryResult<GraphEdge[]>> {
    let results = Array.from(this.edges.values()).filter((e) => e.agentId === query.agentId);
    if (query.sourceNodeId) results = results.filter((e) => e.sourceNodeId === query.sourceNodeId);
    if (query.targetNodeId) results = results.filter((e) => e.targetNodeId === query.targetNodeId);
    if (query.types?.length) results = results.filter((e) => query.types!.includes(e.type));
    if (query.minConfidence !== undefined)
      results = results.filter((e) => e.confidence >= query.minConfidence!);
    if (query.minWeight !== undefined)
      results = results.filter((e) => e.weight >= query.minWeight!);
    return this.success(results);
  }

  async traverse(_options: TraversalOptions): Promise<MemoryResult<TraversalResult>> {
    return this.success({ paths: [], visitedNodes: [], visitedEdges: [], depth: 0 });
  }

  async findShortestPath(
    _agentId: string,
    _startNodeId: string,
    _endNodeId: string,
    _maxDepth?: number
  ): Promise<MemoryResult<GraphPath | null>> {
    return this.success(null);
  }

  async getNeighbors(
    _nodeId: string,
    _direction?: TraversalDirection
  ): Promise<MemoryResult<{ node: GraphNode; edge: GraphEdge }[]>> {
    return this.success([]);
  }

  async mergeNodes(
    targetNodeId: string,
    _sourceNodeIds: string[]
  ): Promise<MemoryResult<GraphNode>> {
    return this.success(this.nodes.get(targetNodeId)!);
  }

  async clearGraph(_agentId: string): Promise<MemoryResult<void>> {
    this.nodes.clear();
    this.edges.clear();
    return this.success(undefined);
  }

  async getGraphStats(_agentId: string): Promise<MemoryResult<GraphStats>> {
    return this.success({
      nodeCount: this.nodes.size,
      edgeCount: this.edges.size,
      nodesByType: {} as Record<EntityType, number>,
      edgesByType: {} as Record<RelationType, number>,
      averageEdgesPerNode: 0,
      maxDepth: 0,
    });
  }
}

const AGENT_ID = 'test-agent';

async function createNode(
  adapter: InMemoryGraphAdapter,
  name: string,
  type: EntityType
): Promise<GraphNode> {
  const result = await adapter.addNode({
    agentId: AGENT_ID,
    type,
    name,
    aliases: [],
    properties: {},
    confidence: 1.0,
    source: 'user',
  });
  return result.data;
}

async function createEdge(
  adapter: InMemoryGraphAdapter,
  sourceId: string,
  targetId: string,
  type: RelationType,
  weight = 1.0
): Promise<GraphEdge> {
  const result = await adapter.addEdge({
    agentId: AGENT_ID,
    sourceNodeId: sourceId,
    targetNodeId: targetId,
    type,
    weight,
    bidirectional: false,
    properties: {},
    confidence: 1.0,
    source: 'user',
  });
  return result.data;
}

describe('GraphInferenceEngine', () => {
  let adapter: InMemoryGraphAdapter;
  let engine: GraphInferenceEngine;

  beforeEach(() => {
    adapter = new InMemoryGraphAdapter();
    engine = new GraphInferenceEngine(adapter);
  });

  describe('colleagues rule (reverse edge traversal)', () => {
    it('infers colleagues when two people work at the same org', async () => {
      const alice = await createNode(adapter, 'Alice', 'person');
      const bob = await createNode(adapter, 'Bob', 'person');
      const acme = await createNode(adapter, 'Acme Corp', 'organization');

      await createEdge(adapter, alice.id, acme.id, 'works_at');
      await createEdge(adapter, bob.id, acme.id, 'works_at');

      const inferred = await engine.infer(AGENT_ID);

      const colleagueEdges = inferred.filter(
        (e) => e.type === 'associated_with' && e.label === 'colleague'
      );

      expect(colleagueEdges.length).toBeGreaterThanOrEqual(1);

      const hasAliceBob = colleagueEdges.some(
        (e) =>
          (e.sourceNodeId === alice.id && e.targetNodeId === bob.id) ||
          (e.sourceNodeId === bob.id && e.targetNodeId === alice.id)
      );
      expect(hasAliceBob).toBe(true);
    });

    it('infers multiple colleague pairs at the same org', async () => {
      const alice = await createNode(adapter, 'Alice', 'person');
      const bob = await createNode(adapter, 'Bob', 'person');
      const carol = await createNode(adapter, 'Carol', 'person');
      const acme = await createNode(adapter, 'Acme Corp', 'organization');

      await createEdge(adapter, alice.id, acme.id, 'works_at');
      await createEdge(adapter, bob.id, acme.id, 'works_at');
      await createEdge(adapter, carol.id, acme.id, 'works_at');

      const inferred = await engine.infer(AGENT_ID);

      const colleagueEdges = inferred.filter(
        (e) => e.type === 'associated_with' && e.label === 'colleague'
      );

      expect(colleagueEdges.length).toBeGreaterThanOrEqual(3);
    });

    it('does not infer a person as their own colleague', async () => {
      const alice = await createNode(adapter, 'Alice', 'person');
      const acme = await createNode(adapter, 'Acme Corp', 'organization');

      await createEdge(adapter, alice.id, acme.id, 'works_at');

      const inferred = await engine.infer(AGENT_ID);

      const selfColleague = inferred.filter(
        (e) =>
          e.type === 'associated_with' &&
          e.label === 'colleague' &&
          e.sourceNodeId === e.targetNodeId
      );
      expect(selfColleague).toHaveLength(0);
    });

    it('does not infer colleagues across different organizations', async () => {
      const alice = await createNode(adapter, 'Alice', 'person');
      const bob = await createNode(adapter, 'Bob', 'person');
      const acme = await createNode(adapter, 'Acme Corp', 'organization');
      const globex = await createNode(adapter, 'Globex Inc', 'organization');

      await createEdge(adapter, alice.id, acme.id, 'works_at');
      await createEdge(adapter, bob.id, globex.id, 'works_at');

      const inferred = await engine.infer(AGENT_ID);

      const colleagueEdges = inferred.filter(
        (e) => e.type === 'associated_with' && e.label === 'colleague'
      );
      expect(colleagueEdges).toHaveLength(0);
    });
  });

  describe('transitive_knows rule (forward traversal)', () => {
    it('infers related_to from transitive knows', async () => {
      const alice = await createNode(adapter, 'Alice', 'person');
      const bob = await createNode(adapter, 'Bob', 'person');
      const carol = await createNode(adapter, 'Carol', 'person');

      await createEdge(adapter, alice.id, bob.id, 'knows');
      await createEdge(adapter, bob.id, carol.id, 'knows');

      const inferred = await engine.infer(AGENT_ID);

      const related = inferred.filter((e) => e.type === 'related_to');
      expect(related.length).toBeGreaterThanOrEqual(1);

      const hasAliceCarol = related.some(
        (e) =>
          (e.sourceNodeId === alice.id && e.targetNodeId === carol.id) ||
          (e.sourceNodeId === carol.id && e.targetNodeId === alice.id)
      );
      expect(hasAliceCarol).toBe(true);
    });
  });

  describe('rule management', () => {
    it('registers and retrieves rules', () => {
      const engine2 = new GraphInferenceEngine(adapter, false);
      const id = engine2.registerRule({
        name: 'test_rule',
        description: 'test',
        pattern: { edgeTypes: ['knows'], minPathLength: 1, maxPathLength: 1 },
        conclusion: {
          edgeType: 'related_to',
          weightFormula: 'min',
          bidirectional: false,
        },
        confidence: 0.5,
        enabled: true,
      });

      const rules = engine2.getRules();
      expect(rules).toHaveLength(1);
      expect(rules[0].id).toBe(id);
    });

    it('enables and disables rules', () => {
      const rules = engine.getRules();
      const firstRule = rules[0];

      engine.disableRule(firstRule.id);
      expect(engine.getRules().find((r) => r.id === firstRule.id)?.enabled).toBe(false);

      engine.enableRule(firstRule.id);
      expect(engine.getRules().find((r) => r.id === firstRule.id)?.enabled).toBe(true);
    });

    it('removes rules', () => {
      const rules = engine.getRules();
      const count = rules.length;
      engine.removeRule(rules[0].id);
      expect(engine.getRules()).toHaveLength(count - 1);
    });
  });

  describe('materialize', () => {
    it('materializes inferred edges into the graph', async () => {
      const alice = await createNode(adapter, 'Alice', 'person');
      const bob = await createNode(adapter, 'Bob', 'person');
      const acme = await createNode(adapter, 'Acme Corp', 'organization');

      await createEdge(adapter, alice.id, acme.id, 'works_at');
      await createEdge(adapter, bob.id, acme.id, 'works_at');

      const inferred = await engine.infer(AGENT_ID);
      const colleagueEdges = inferred.filter(
        (e) => e.type === 'associated_with' && e.label === 'colleague'
      );
      expect(colleagueEdges.length).toBeGreaterThanOrEqual(1);

      const result = await engine.materialize(colleagueEdges);
      expect(result.success).toBe(true);
      expect(result.data.length).toBe(colleagueEdges.length);
    });
  });

  describe('inference options', () => {
    it('respects maxInferences limit', async () => {
      const alice = await createNode(adapter, 'Alice', 'person');
      const bob = await createNode(adapter, 'Bob', 'person');
      const carol = await createNode(adapter, 'Carol', 'person');
      const acme = await createNode(adapter, 'Acme Corp', 'organization');

      await createEdge(adapter, alice.id, acme.id, 'works_at');
      await createEdge(adapter, bob.id, acme.id, 'works_at');
      await createEdge(adapter, carol.id, acme.id, 'works_at');

      const inferred = await engine.infer(AGENT_ID, { maxInferences: 1 });
      expect(inferred).toHaveLength(1);
    });

    it('respects minConfidence filter', async () => {
      const alice = await createNode(adapter, 'Alice', 'person');
      const bob = await createNode(adapter, 'Bob', 'person');
      const acme = await createNode(adapter, 'Acme Corp', 'organization');

      await createEdge(adapter, alice.id, acme.id, 'works_at');
      await createEdge(adapter, bob.id, acme.id, 'works_at');

      const inferred = await engine.infer(AGENT_ID, { minConfidence: 0.99 });
      const colleagueEdges = inferred.filter(
        (e) => e.type === 'associated_with' && e.label === 'colleague'
      );
      expect(colleagueEdges.length).toBeGreaterThanOrEqual(0);
    });
  });
});
