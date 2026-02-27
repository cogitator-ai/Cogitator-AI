import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteGraphAdapter } from '../knowledge-graph/sqlite-graph-adapter';
import type { GraphNode, GraphEdge } from '@cogitator-ai/types';

describe('SQLiteGraphAdapter', () => {
  let adapter: SQLiteGraphAdapter;

  beforeEach(async () => {
    adapter = new SQLiteGraphAdapter({ path: ':memory:' });
    await adapter.initialize();
  });

  afterEach(async () => {
    await adapter.close();
  });

  const makeNode = (
    overrides: Partial<
      Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt' | 'lastAccessedAt' | 'accessCount'>
    > = {}
  ) => ({
    agentId: 'agent1',
    type: 'person' as const,
    name: 'Alice',
    aliases: ['ali'],
    description: 'A test person',
    properties: { age: 30 },
    confidence: 0.9,
    source: 'user' as const,
    metadata: { tag: 'test' },
    ...overrides,
  });

  const makeEdge = (
    sourceNodeId: string,
    targetNodeId: string,
    overrides: Partial<Omit<GraphEdge, 'id' | 'createdAt' | 'updatedAt'>> = {}
  ) => ({
    agentId: 'agent1',
    sourceNodeId,
    targetNodeId,
    type: 'knows' as const,
    label: 'friend of',
    weight: 1.0,
    bidirectional: false,
    properties: {},
    confidence: 0.95,
    source: 'user' as const,
    metadata: {},
    ...overrides,
  });

  describe('node CRUD', () => {
    it('adds and retrieves a node', async () => {
      const res = await adapter.addNode(makeNode());
      expect(res.success).toBe(true);
      if (!res.success) return;

      expect(res.data.id).toMatch(/^node_/);
      expect(res.data.name).toBe('Alice');
      expect(res.data.accessCount).toBe(0);

      const get = await adapter.getNode(res.data.id);
      expect(get.success).toBe(true);
      if (!get.success) return;
      expect(get.data!.name).toBe('Alice');
      expect(get.data!.accessCount).toBe(1);
    });

    it('returns null for non-existent node', async () => {
      const res = await adapter.getNode('node_nonexistent');
      expect(res.success).toBe(true);
      if (res.success) expect(res.data).toBeNull();
    });

    it('getNodeByName finds by exact name', async () => {
      await adapter.addNode(makeNode({ name: 'Bob' }));
      const res = await adapter.getNodeByName('agent1', 'Bob');
      expect(res.success).toBe(true);
      if (res.success) expect(res.data!.name).toBe('Bob');
    });

    it('getNodeByName finds by alias', async () => {
      await adapter.addNode(makeNode({ name: 'Robert', aliases: ['Bob', 'Bobby'] }));
      const res = await adapter.getNodeByName('agent1', 'Bob');
      expect(res.success).toBe(true);
      if (res.success) expect(res.data!.name).toBe('Robert');
    });

    it('getNodeByName returns null when not found', async () => {
      const res = await adapter.getNodeByName('agent1', 'Nobody');
      expect(res.success).toBe(true);
      if (res.success) expect(res.data).toBeNull();
    });

    it('updates a node', async () => {
      const add = await adapter.addNode(makeNode());
      if (!add.success) return;

      const res = await adapter.updateNode(add.data.id, {
        name: 'Alice Updated',
        confidence: 0.99,
        properties: { age: 31 },
      });
      expect(res.success).toBe(true);
      if (!res.success) return;
      expect(res.data.name).toBe('Alice Updated');
      expect(res.data.confidence).toBe(0.99);
      expect(res.data.properties).toEqual({ age: 31 });
    });

    it('updateNode fails for non-existent node', async () => {
      const res = await adapter.updateNode('node_nonexistent', { name: 'X' });
      expect(res.success).toBe(false);
    });

    it('deletes a node', async () => {
      const add = await adapter.addNode(makeNode());
      if (!add.success) return;

      const del = await adapter.deleteNode(add.data.id);
      expect(del.success).toBe(true);

      const get = await adapter.getNode(add.data.id);
      if (get.success) expect(get.data).toBeNull();
    });

    it('deletes node cascades edges', async () => {
      const a = await adapter.addNode(makeNode({ name: 'A' }));
      const b = await adapter.addNode(makeNode({ name: 'B' }));
      if (!a.success || !b.success) return;

      await adapter.addEdge(makeEdge(a.data.id, b.data.id));
      await adapter.deleteNode(a.data.id);

      const edges = await adapter.queryEdges({ agentId: 'agent1' });
      if (edges.success) expect(edges.data).toHaveLength(0);
    });
  });

  describe('queryNodes', () => {
    it('filters by type', async () => {
      await adapter.addNode(makeNode({ name: 'Alice', type: 'person' }));
      await adapter.addNode(makeNode({ name: 'Acme', type: 'organization' }));

      const res = await adapter.queryNodes({ agentId: 'agent1', types: ['person'] });
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data).toHaveLength(1);
        expect(res.data[0].name).toBe('Alice');
      }
    });

    it('filters by namePattern', async () => {
      await adapter.addNode(makeNode({ name: 'Alice' }));
      await adapter.addNode(makeNode({ name: 'Bob' }));

      const res = await adapter.queryNodes({ agentId: 'agent1', namePattern: 'ali' });
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data).toHaveLength(1);
        expect(res.data[0].name).toBe('Alice');
      }
    });

    it('filters by minConfidence', async () => {
      await adapter.addNode(makeNode({ name: 'High', confidence: 0.9 }));
      await adapter.addNode(makeNode({ name: 'Low', confidence: 0.3 }));

      const res = await adapter.queryNodes({ agentId: 'agent1', minConfidence: 0.5 });
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data).toHaveLength(1);
        expect(res.data[0].name).toBe('High');
      }
    });

    it('respects limit', async () => {
      await adapter.addNode(makeNode({ name: 'A' }));
      await adapter.addNode(makeNode({ name: 'B' }));
      await adapter.addNode(makeNode({ name: 'C' }));

      const res = await adapter.queryNodes({ agentId: 'agent1', limit: 2 });
      expect(res.success).toBe(true);
      if (res.success) expect(res.data).toHaveLength(2);
    });
  });

  describe('edge CRUD', () => {
    let nodeA: GraphNode;
    let nodeB: GraphNode;

    beforeEach(async () => {
      const a = await adapter.addNode(makeNode({ name: 'A' }));
      const b = await adapter.addNode(makeNode({ name: 'B' }));
      if (!a.success || !b.success) throw new Error('setup failed');
      nodeA = a.data;
      nodeB = b.data;
    });

    it('adds and retrieves an edge', async () => {
      const res = await adapter.addEdge(makeEdge(nodeA.id, nodeB.id));
      expect(res.success).toBe(true);
      if (!res.success) return;
      expect(res.data.id).toMatch(/^edge_/);
      expect(res.data.sourceNodeId).toBe(nodeA.id);

      const get = await adapter.getEdge(res.data.id);
      expect(get.success).toBe(true);
      if (get.success) expect(get.data!.type).toBe('knows');
    });

    it('returns null for non-existent edge', async () => {
      const res = await adapter.getEdge('edge_nonexistent');
      expect(res.success).toBe(true);
      if (res.success) expect(res.data).toBeNull();
    });

    it('gets edges between two nodes', async () => {
      await adapter.addEdge(makeEdge(nodeA.id, nodeB.id, { type: 'knows' }));
      await adapter.addEdge(makeEdge(nodeA.id, nodeB.id, { type: 'works_at' }));

      const res = await adapter.getEdgesBetween(nodeA.id, nodeB.id);
      expect(res.success).toBe(true);
      if (res.success) expect(res.data).toHaveLength(2);
    });

    it('getEdgesBetween finds bidirectional edges in reverse', async () => {
      await adapter.addEdge(makeEdge(nodeA.id, nodeB.id, { bidirectional: true }));

      const res = await adapter.getEdgesBetween(nodeB.id, nodeA.id);
      expect(res.success).toBe(true);
      if (res.success) expect(res.data).toHaveLength(1);
    });

    it('updates an edge', async () => {
      const add = await adapter.addEdge(makeEdge(nodeA.id, nodeB.id));
      if (!add.success) return;

      const res = await adapter.updateEdge(add.data.id, {
        weight: 5.0,
        label: 'best friend',
      });
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.weight).toBe(5.0);
        expect(res.data.label).toBe('best friend');
      }
    });

    it('updateEdge fails for non-existent edge', async () => {
      const res = await adapter.updateEdge('edge_nonexistent', { weight: 1 });
      expect(res.success).toBe(false);
    });

    it('deletes an edge', async () => {
      const add = await adapter.addEdge(makeEdge(nodeA.id, nodeB.id));
      if (!add.success) return;

      const del = await adapter.deleteEdge(add.data.id);
      expect(del.success).toBe(true);

      const get = await adapter.getEdge(add.data.id);
      if (get.success) expect(get.data).toBeNull();
    });
  });

  describe('queryEdges', () => {
    let nodeA: GraphNode;
    let nodeB: GraphNode;
    let nodeC: GraphNode;

    beforeEach(async () => {
      const a = await adapter.addNode(makeNode({ name: 'A' }));
      const b = await adapter.addNode(makeNode({ name: 'B' }));
      const c = await adapter.addNode(makeNode({ name: 'C' }));
      if (!a.success || !b.success || !c.success) throw new Error('setup failed');
      nodeA = a.data;
      nodeB = b.data;
      nodeC = c.data;
    });

    it('filters by source', async () => {
      await adapter.addEdge(makeEdge(nodeA.id, nodeB.id));
      await adapter.addEdge(makeEdge(nodeB.id, nodeC.id));

      const res = await adapter.queryEdges({ agentId: 'agent1', sourceNodeId: nodeA.id });
      expect(res.success).toBe(true);
      if (res.success) expect(res.data).toHaveLength(1);
    });

    it('filters by type', async () => {
      await adapter.addEdge(makeEdge(nodeA.id, nodeB.id, { type: 'knows' }));
      await adapter.addEdge(makeEdge(nodeA.id, nodeC.id, { type: 'works_at' }));

      const res = await adapter.queryEdges({ agentId: 'agent1', types: ['knows'] });
      expect(res.success).toBe(true);
      if (res.success) expect(res.data).toHaveLength(1);
    });

    it('filters by minWeight and minConfidence', async () => {
      await adapter.addEdge(makeEdge(nodeA.id, nodeB.id, { weight: 5, confidence: 0.9 }));
      await adapter.addEdge(makeEdge(nodeA.id, nodeC.id, { weight: 1, confidence: 0.3 }));

      const res = await adapter.queryEdges({
        agentId: 'agent1',
        minWeight: 3,
        minConfidence: 0.5,
      });
      expect(res.success).toBe(true);
      if (res.success) expect(res.data).toHaveLength(1);
    });

    it('filters bidirectionalOnly', async () => {
      await adapter.addEdge(makeEdge(nodeA.id, nodeB.id, { bidirectional: true }));
      await adapter.addEdge(makeEdge(nodeA.id, nodeC.id, { bidirectional: false }));

      const res = await adapter.queryEdges({ agentId: 'agent1', bidirectionalOnly: true });
      expect(res.success).toBe(true);
      if (res.success) expect(res.data).toHaveLength(1);
    });
  });

  describe('neighbors', () => {
    it('gets outgoing neighbors', async () => {
      const a = await adapter.addNode(makeNode({ name: 'A' }));
      const b = await adapter.addNode(makeNode({ name: 'B' }));
      const c = await adapter.addNode(makeNode({ name: 'C' }));
      if (!a.success || !b.success || !c.success) return;

      await adapter.addEdge(makeEdge(a.data.id, b.data.id));
      await adapter.addEdge(makeEdge(c.data.id, a.data.id));

      const res = await adapter.getNeighbors(a.data.id, 'outgoing');
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data).toHaveLength(1);
        expect(res.data[0].node.name).toBe('B');
      }
    });

    it('gets incoming neighbors', async () => {
      const a = await adapter.addNode(makeNode({ name: 'A' }));
      const b = await adapter.addNode(makeNode({ name: 'B' }));
      if (!a.success || !b.success) return;

      await adapter.addEdge(makeEdge(b.data.id, a.data.id));

      const res = await adapter.getNeighbors(a.data.id, 'incoming');
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data).toHaveLength(1);
        expect(res.data[0].node.name).toBe('B');
      }
    });

    it('gets both-direction neighbors', async () => {
      const a = await adapter.addNode(makeNode({ name: 'A' }));
      const b = await adapter.addNode(makeNode({ name: 'B' }));
      const c = await adapter.addNode(makeNode({ name: 'C' }));
      if (!a.success || !b.success || !c.success) return;

      await adapter.addEdge(makeEdge(a.data.id, b.data.id));
      await adapter.addEdge(makeEdge(c.data.id, a.data.id));

      const res = await adapter.getNeighbors(a.data.id, 'both');
      expect(res.success).toBe(true);
      if (res.success) expect(res.data).toHaveLength(2);
    });

    it('handles bidirectional edges in outgoing', async () => {
      const a = await adapter.addNode(makeNode({ name: 'A' }));
      const b = await adapter.addNode(makeNode({ name: 'B' }));
      if (!a.success || !b.success) return;

      await adapter.addEdge(makeEdge(b.data.id, a.data.id, { bidirectional: true }));

      const res = await adapter.getNeighbors(a.data.id, 'outgoing');
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data).toHaveLength(1);
        expect(res.data[0].node.name).toBe('B');
      }
    });
  });

  describe('traversal', () => {
    it('traverses graph via BFS', async () => {
      const a = await adapter.addNode(makeNode({ name: 'A' }));
      const b = await adapter.addNode(makeNode({ name: 'B' }));
      const c = await adapter.addNode(makeNode({ name: 'C' }));
      if (!a.success || !b.success || !c.success) return;

      await adapter.addEdge(makeEdge(a.data.id, b.data.id));
      await adapter.addEdge(makeEdge(b.data.id, c.data.id));

      const res = await adapter.traverse({
        agentId: 'agent1',
        startNodeId: a.data.id,
        maxDepth: 3,
        direction: 'both',
      });

      expect(res.success).toBe(true);
      if (!res.success) return;
      expect(res.data.visitedNodes.length).toBeGreaterThanOrEqual(3);
      expect(res.data.visitedEdges.length).toBeGreaterThanOrEqual(2);
    });

    it('respects maxDepth', async () => {
      const a = await adapter.addNode(makeNode({ name: 'A' }));
      const b = await adapter.addNode(makeNode({ name: 'B' }));
      const c = await adapter.addNode(makeNode({ name: 'C' }));
      if (!a.success || !b.success || !c.success) return;

      await adapter.addEdge(makeEdge(a.data.id, b.data.id));
      await adapter.addEdge(makeEdge(b.data.id, c.data.id));

      const res = await adapter.traverse({
        agentId: 'agent1',
        startNodeId: a.data.id,
        maxDepth: 1,
        direction: 'both',
      });

      expect(res.success).toBe(true);
      if (!res.success) return;
      expect(res.data.visitedNodes).toHaveLength(2);
    });

    it('fails for non-existent start node', async () => {
      const res = await adapter.traverse({
        agentId: 'agent1',
        startNodeId: 'node_nonexistent',
        maxDepth: 3,
        direction: 'both',
      });
      expect(res.success).toBe(false);
    });
  });

  describe('findShortestPath', () => {
    it('finds shortest path between two nodes', async () => {
      const a = await adapter.addNode(makeNode({ name: 'A' }));
      const b = await adapter.addNode(makeNode({ name: 'B' }));
      const c = await adapter.addNode(makeNode({ name: 'C' }));
      if (!a.success || !b.success || !c.success) return;

      await adapter.addEdge(makeEdge(a.data.id, b.data.id));
      await adapter.addEdge(makeEdge(b.data.id, c.data.id));

      const res = await adapter.findShortestPath('agent1', a.data.id, c.data.id);
      expect(res.success).toBe(true);
      if (!res.success) return;
      expect(res.data).not.toBeNull();
      expect(res.data!.nodes).toHaveLength(3);
      expect(res.data!.edges).toHaveLength(2);
    });

    it('returns null when no path exists', async () => {
      const a = await adapter.addNode(makeNode({ name: 'A' }));
      const b = await adapter.addNode(makeNode({ name: 'B' }));
      if (!a.success || !b.success) return;

      const res = await adapter.findShortestPath('agent1', a.data.id, b.data.id);
      expect(res.success).toBe(true);
      if (res.success) expect(res.data).toBeNull();
    });
  });

  describe('semantic search', () => {
    it('returns results sorted by cosine similarity', async () => {
      await adapter.addNode(
        makeNode({
          name: 'Close',
          embedding: [1, 0, 0],
        })
      );
      await adapter.addNode(
        makeNode({
          name: 'Far',
          embedding: [0, 0, 1],
        })
      );
      await adapter.addNode(
        makeNode({
          name: 'NoEmb',
        })
      );

      const res = await adapter.searchNodesSemantic({
        agentId: 'agent1',
        vector: [1, 0, 0],
        threshold: 0.0,
        limit: 10,
      });

      expect(res.success).toBe(true);
      if (!res.success) return;
      expect(res.data.length).toBeGreaterThanOrEqual(1);
      expect(res.data[0].name).toBe('Close');
      expect(res.data[0].score).toBeCloseTo(1.0, 5);
    });

    it('respects threshold', async () => {
      await adapter.addNode(makeNode({ name: 'A', embedding: [1, 0, 0] }));
      await adapter.addNode(makeNode({ name: 'B', embedding: [0, 1, 0] }));

      const res = await adapter.searchNodesSemantic({
        agentId: 'agent1',
        vector: [1, 0, 0],
        threshold: 0.99,
        limit: 10,
      });

      expect(res.success).toBe(true);
      if (!res.success) return;
      expect(res.data).toHaveLength(1);
      expect(res.data[0].name).toBe('A');
    });

    it('filters by entityTypes', async () => {
      await adapter.addNode(makeNode({ name: 'Person', type: 'person', embedding: [1, 0, 0] }));
      await adapter.addNode(makeNode({ name: 'Org', type: 'organization', embedding: [1, 0, 0] }));

      const res = await adapter.searchNodesSemantic({
        agentId: 'agent1',
        vector: [1, 0, 0],
        entityTypes: ['person'],
        threshold: 0.0,
        limit: 10,
      });

      expect(res.success).toBe(true);
      if (!res.success) return;
      expect(res.data).toHaveLength(1);
      expect(res.data[0].name).toBe('Person');
    });

    it('returns error when no vector provided', async () => {
      const res = await adapter.searchNodesSemantic({
        agentId: 'agent1',
        threshold: 0.5,
      });
      expect(res.success).toBe(false);
    });
  });

  describe('graph stats', () => {
    it('returns correct counts', async () => {
      const a = await adapter.addNode(makeNode({ name: 'A', type: 'person' }));
      const b = await adapter.addNode(makeNode({ name: 'B', type: 'organization' }));
      if (!a.success || !b.success) return;

      await adapter.addEdge(makeEdge(a.data.id, b.data.id, { type: 'works_at' }));

      const res = await adapter.getGraphStats('agent1');
      expect(res.success).toBe(true);
      if (!res.success) return;
      expect(res.data.nodeCount).toBe(2);
      expect(res.data.edgeCount).toBe(1);
      expect(res.data.nodesByType.person).toBe(1);
      expect(res.data.nodesByType.organization).toBe(1);
      expect(res.data.edgesByType.works_at).toBe(1);
      expect(res.data.averageEdgesPerNode).toBe(0.5);
    });
  });

  describe('mergeNodes', () => {
    it('merges source nodes into target', async () => {
      const a = await adapter.addNode(makeNode({ name: 'Alice' }));
      const b = await adapter.addNode(makeNode({ name: 'Ali', aliases: ['A'] }));
      const c = await adapter.addNode(makeNode({ name: 'Charlie' }));
      if (!a.success || !b.success || !c.success) return;

      await adapter.addEdge(makeEdge(b.data.id, c.data.id));

      const res = await adapter.mergeNodes(a.data.id, [b.data.id]);
      expect(res.success).toBe(true);
      if (!res.success) return;
      expect(res.data.aliases).toContain('Ali');
      expect(res.data.aliases).toContain('A');

      const sourceGone = await adapter.getNode(b.data.id);
      if (sourceGone.success) expect(sourceGone.data).toBeNull();

      const edges = await adapter.queryEdges({ agentId: 'agent1', sourceNodeId: a.data.id });
      if (edges.success) expect(edges.data).toHaveLength(1);
    });
  });

  describe('clearGraph', () => {
    it('deletes all nodes and edges for agent', async () => {
      const a = await adapter.addNode(makeNode({ name: 'A' }));
      const b = await adapter.addNode(makeNode({ name: 'B' }));
      if (!a.success || !b.success) return;
      await adapter.addEdge(makeEdge(a.data.id, b.data.id));

      await adapter.clearGraph('agent1');

      const nodes = await adapter.queryNodes({ agentId: 'agent1' });
      if (nodes.success) expect(nodes.data).toHaveLength(0);
      const edges = await adapter.queryEdges({ agentId: 'agent1' });
      if (edges.success) expect(edges.data).toHaveLength(0);
    });
  });

  describe('embedding storage', () => {
    it('stores and retrieves embedding via update', async () => {
      const add = await adapter.addNode(makeNode());
      if (!add.success) return;

      const emb = [0.1, 0.2, 0.3];
      await adapter.updateNode(add.data.id, { embedding: emb });

      const res = await adapter.searchNodesSemantic({
        agentId: 'agent1',
        vector: [0.1, 0.2, 0.3],
        threshold: 0.9,
        limit: 5,
      });

      expect(res.success).toBe(true);
      if (res.success) expect(res.data.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('initialize idempotency', () => {
    it('can be called multiple times', async () => {
      await adapter.initialize();
      await adapter.initialize();
      const res = await adapter.addNode(makeNode());
      expect(res.success).toBe(true);
    });
  });
});
