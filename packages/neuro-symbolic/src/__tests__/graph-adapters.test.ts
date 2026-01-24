import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { GraphAdapter } from '@cogitator-ai/types';
import { MemoryGraphAdapter } from '../knowledge-graph/adapters/memory-adapter';
import { PostgresGraphAdapter } from '../knowledge-graph/adapters/postgres-adapter';
import { Neo4jGraphAdapter } from '../knowledge-graph/adapters/neo4j-adapter';

const TEST_AGENT_ID = 'test-agent-123';

function runAdapterTests(name: string, createAdapter: () => GraphAdapter) {
  describe(`${name} - GraphAdapter interface`, () => {
    let adapter: GraphAdapter;

    beforeEach(() => {
      adapter = createAdapter();
    });

    describe('Node operations', () => {
      it('adds a node', async () => {
        const result = await adapter.addNode({
          agentId: TEST_AGENT_ID,
          type: 'person',
          name: 'Alice',
          aliases: ['Ali'],
          description: 'Test person',
          properties: { age: 30 },
          confidence: 0.9,
          source: 'user',
          metadata: { test: true },
        });

        expect(result.success).toBe(true);
        expect(result.data!.id).toBeDefined();
        expect(result.data!.name).toBe('Alice');
        expect(result.data!.type).toBe('person');
        expect(result.data!.accessCount).toBe(0);
      });

      it('gets a node by id', async () => {
        const addResult = await adapter.addNode({
          agentId: TEST_AGENT_ID,
          type: 'person',
          name: 'Bob',
          aliases: [],
          properties: {},
          confidence: 1,
          source: 'user',
        });

        const getResult = await adapter.getNode(addResult.data!.id);

        expect(getResult.success).toBe(true);
        expect(getResult.data!.name).toBe('Bob');
        expect(getResult.data!.accessCount).toBe(1);
      });

      it('gets a node by name', async () => {
        await adapter.addNode({
          agentId: TEST_AGENT_ID,
          type: 'person',
          name: 'Charlie',
          aliases: ['Chuck'],
          properties: {},
          confidence: 1,
          source: 'user',
        });

        const result = await adapter.getNodeByName(TEST_AGENT_ID, 'Charlie');
        expect(result.success).toBe(true);
        expect(result.data!.name).toBe('Charlie');

        const aliasResult = await adapter.getNodeByName(TEST_AGENT_ID, 'Chuck');
        expect(aliasResult.success).toBe(true);
        expect(aliasResult.data!.name).toBe('Charlie');
      });

      it('updates a node', async () => {
        const addResult = await adapter.addNode({
          agentId: TEST_AGENT_ID,
          type: 'person',
          name: 'David',
          aliases: [],
          properties: { age: 25 },
          confidence: 0.8,
          source: 'user',
        });

        const updateResult = await adapter.updateNode(addResult.data!.id, {
          name: 'Dave',
          confidence: 0.95,
          properties: { age: 26, city: 'NYC' },
        });

        expect(updateResult.success).toBe(true);
        expect(updateResult.data!.name).toBe('Dave');
        expect(updateResult.data!.confidence).toBe(0.95);
      });

      it('deletes a node', async () => {
        const addResult = await adapter.addNode({
          agentId: TEST_AGENT_ID,
          type: 'person',
          name: 'Eve',
          aliases: [],
          properties: {},
          confidence: 1,
          source: 'user',
        });

        const deleteResult = await adapter.deleteNode(addResult.data!.id);
        expect(deleteResult.success).toBe(true);

        const getResult = await adapter.getNode(addResult.data!.id);
        expect(getResult.data).toBeNull();
      });

      it('queries nodes with filters', async () => {
        await adapter.addNode({
          agentId: TEST_AGENT_ID,
          type: 'person',
          name: 'Frank',
          aliases: [],
          properties: {},
          confidence: 0.9,
          source: 'user',
        });

        await adapter.addNode({
          agentId: TEST_AGENT_ID,
          type: 'organization',
          name: 'TechCorp',
          aliases: [],
          properties: {},
          confidence: 0.8,
          source: 'user',
        });

        const personQuery = await adapter.queryNodes({
          agentId: TEST_AGENT_ID,
          types: ['person'],
        });

        expect(personQuery.success).toBe(true);
        expect(personQuery.data!.length).toBeGreaterThanOrEqual(1);
        expect(personQuery.data!.every((n) => n.type === 'person')).toBe(true);
      });

      it('queries nodes with name pattern', async () => {
        await adapter.addNode({
          agentId: TEST_AGENT_ID,
          type: 'person',
          name: 'TestPattern123',
          aliases: [],
          properties: {},
          confidence: 1,
          source: 'user',
        });

        const result = await adapter.queryNodes({
          agentId: TEST_AGENT_ID,
          namePattern: 'Pattern',
        });

        expect(result.success).toBe(true);
        expect(result.data!.some((n) => n.name === 'TestPattern123')).toBe(true);
      });

      it('queries nodes with min confidence', async () => {
        await adapter.addNode({
          agentId: TEST_AGENT_ID,
          type: 'person',
          name: 'HighConfidence',
          aliases: [],
          properties: {},
          confidence: 0.95,
          source: 'user',
        });

        await adapter.addNode({
          agentId: TEST_AGENT_ID,
          type: 'person',
          name: 'LowConfidence',
          aliases: [],
          properties: {},
          confidence: 0.3,
          source: 'user',
        });

        const result = await adapter.queryNodes({
          agentId: TEST_AGENT_ID,
          minConfidence: 0.9,
        });

        expect(result.success).toBe(true);
        expect(result.data!.every((n) => n.confidence >= 0.9)).toBe(true);
      });
    });

    describe('Edge operations', () => {
      let node1Id: string;
      let node2Id: string;

      beforeEach(async () => {
        const n1 = await adapter.addNode({
          agentId: TEST_AGENT_ID,
          type: 'person',
          name: 'Node1',
          aliases: [],
          properties: {},
          confidence: 1,
          source: 'user',
        });
        const n2 = await adapter.addNode({
          agentId: TEST_AGENT_ID,
          type: 'person',
          name: 'Node2',
          aliases: [],
          properties: {},
          confidence: 1,
          source: 'user',
        });
        node1Id = n1.data!.id;
        node2Id = n2.data!.id;
      });

      it('adds an edge', async () => {
        const result = await adapter.addEdge({
          agentId: TEST_AGENT_ID,
          sourceNodeId: node1Id,
          targetNodeId: node2Id,
          type: 'knows',
          label: 'friends',
          weight: 0.8,
          bidirectional: true,
          properties: { since: 2020 },
          confidence: 0.9,
          source: 'user',
          metadata: {},
        });

        expect(result.success).toBe(true);
        expect(result.data!.id).toBeDefined();
        expect(result.data!.type).toBe('knows');
      });

      it('gets an edge by id', async () => {
        const addResult = await adapter.addEdge({
          agentId: TEST_AGENT_ID,
          sourceNodeId: node1Id,
          targetNodeId: node2Id,
          type: 'works_at',
          weight: 1,
          bidirectional: false,
          properties: {},
          confidence: 1,
          source: 'user',
        });

        const getResult = await adapter.getEdge(addResult.data!.id);

        expect(getResult.success).toBe(true);
        expect(getResult.data!.type).toBe('works_at');
      });

      it('gets edges between nodes', async () => {
        await adapter.addEdge({
          agentId: TEST_AGENT_ID,
          sourceNodeId: node1Id,
          targetNodeId: node2Id,
          type: 'knows',
          weight: 1,
          bidirectional: false,
          properties: {},
          confidence: 1,
          source: 'user',
        });

        const result = await adapter.getEdgesBetween(node1Id, node2Id);

        expect(result.success).toBe(true);
        expect(result.data!.length).toBeGreaterThanOrEqual(1);
      });

      it('updates an edge', async () => {
        const addResult = await adapter.addEdge({
          agentId: TEST_AGENT_ID,
          sourceNodeId: node1Id,
          targetNodeId: node2Id,
          type: 'related_to',
          weight: 0.5,
          bidirectional: false,
          properties: {},
          confidence: 0.7,
          source: 'user',
        });

        const updateResult = await adapter.updateEdge(addResult.data!.id, {
          weight: 0.9,
          confidence: 0.95,
          label: 'updated',
        });

        expect(updateResult.success).toBe(true);
        expect(updateResult.data!.weight).toBe(0.9);
        expect(updateResult.data!.confidence).toBe(0.95);
      });

      it('deletes an edge', async () => {
        const addResult = await adapter.addEdge({
          agentId: TEST_AGENT_ID,
          sourceNodeId: node1Id,
          targetNodeId: node2Id,
          type: 'part_of',
          weight: 1,
          bidirectional: false,
          properties: {},
          confidence: 1,
          source: 'user',
        });

        const deleteResult = await adapter.deleteEdge(addResult.data!.id);
        expect(deleteResult.success).toBe(true);

        const getResult = await adapter.getEdge(addResult.data!.id);
        expect(getResult.data).toBeNull();
      });

      it('queries edges with filters', async () => {
        await adapter.addEdge({
          agentId: TEST_AGENT_ID,
          sourceNodeId: node1Id,
          targetNodeId: node2Id,
          type: 'knows',
          weight: 0.9,
          bidirectional: true,
          properties: {},
          confidence: 0.9,
          source: 'user',
        });

        const result = await adapter.queryEdges({
          agentId: TEST_AGENT_ID,
          types: ['knows'],
          minWeight: 0.8,
        });

        expect(result.success).toBe(true);
        expect(result.data!.every((e) => e.type === 'knows')).toBe(true);
        expect(result.data!.every((e) => e.weight >= 0.8)).toBe(true);
      });
    });

    describe('Traversal operations', () => {
      let nodeA: string;
      let nodeB: string;
      let nodeC: string;

      beforeEach(async () => {
        const a = await adapter.addNode({
          agentId: TEST_AGENT_ID,
          type: 'person',
          name: 'A',
          aliases: [],
          properties: {},
          confidence: 1,
          source: 'user',
        });
        const b = await adapter.addNode({
          agentId: TEST_AGENT_ID,
          type: 'person',
          name: 'B',
          aliases: [],
          properties: {},
          confidence: 1,
          source: 'user',
        });
        const c = await adapter.addNode({
          agentId: TEST_AGENT_ID,
          type: 'person',
          name: 'C',
          aliases: [],
          properties: {},
          confidence: 1,
          source: 'user',
        });

        nodeA = a.data!.id;
        nodeB = b.data!.id;
        nodeC = c.data!.id;

        await adapter.addEdge({
          agentId: TEST_AGENT_ID,
          sourceNodeId: nodeA,
          targetNodeId: nodeB,
          type: 'knows',
          weight: 1,
          bidirectional: false,
          properties: {},
          confidence: 1,
          source: 'user',
        });

        await adapter.addEdge({
          agentId: TEST_AGENT_ID,
          sourceNodeId: nodeB,
          targetNodeId: nodeC,
          type: 'knows',
          weight: 1,
          bidirectional: false,
          properties: {},
          confidence: 1,
          source: 'user',
        });
      });

      it('gets neighbors', async () => {
        const result = await adapter.getNeighbors(nodeB, 'both');

        expect(result.success).toBe(true);
        expect(result.data!.length).toBe(2);
      });

      it('gets outgoing neighbors', async () => {
        const result = await adapter.getNeighbors(nodeA, 'outgoing');

        expect(result.success).toBe(true);
        expect(result.data!.length).toBe(1);
        expect(result.data![0].node.name).toBe('B');
      });

      it('gets incoming neighbors', async () => {
        const result = await adapter.getNeighbors(nodeB, 'incoming');

        expect(result.success).toBe(true);
        expect(result.data!.length).toBe(1);
        expect(result.data![0].node.name).toBe('A');
      });

      it('finds shortest path', async () => {
        const result = await adapter.findShortestPath(TEST_AGENT_ID, nodeA, nodeC);

        expect(result.success).toBe(true);
        expect(result.data).not.toBeNull();
        expect(result.data!.nodes.length).toBe(3);
        expect(result.data!.edges.length).toBe(2);
      });

      it('returns null for no path', async () => {
        const isolated = await adapter.addNode({
          agentId: TEST_AGENT_ID,
          type: 'person',
          name: 'Isolated',
          aliases: [],
          properties: {},
          confidence: 1,
          source: 'user',
        });

        const result = await adapter.findShortestPath(TEST_AGENT_ID, nodeA, isolated.data!.id);

        expect(result.success).toBe(true);
        expect(result.data).toBeNull();
      });

      it('traverses graph with depth limit', async () => {
        const result = await adapter.traverse({
          agentId: TEST_AGENT_ID,
          startNodeId: nodeA,
          maxDepth: 1,
          direction: 'outgoing',
        });

        expect(result.success).toBe(true);
        expect(result.data!.visitedNodes.length).toBeLessThanOrEqual(2);
      });
    });

    describe('Graph operations', () => {
      it('merges nodes', async () => {
        const n1 = await adapter.addNode({
          agentId: TEST_AGENT_ID,
          type: 'person',
          name: 'MergeTarget',
          aliases: ['MT'],
          properties: { key1: 'val1' },
          confidence: 1,
          source: 'user',
        });

        const n2 = await adapter.addNode({
          agentId: TEST_AGENT_ID,
          type: 'person',
          name: 'MergeSource',
          aliases: ['MS'],
          properties: { key2: 'val2' },
          confidence: 1,
          source: 'user',
        });

        const result = await adapter.mergeNodes(n1.data!.id, [n2.data!.id]);

        expect(result.success).toBe(true);
        expect(result.data!.aliases).toContain('MergeSource');
        expect(result.data!.properties).toHaveProperty('key2');

        const sourceGone = await adapter.getNode(n2.data!.id);
        expect(sourceGone.data).toBeNull();
      });

      it('clears graph for agent', async () => {
        const clearAgentId = 'clear-test-agent';

        await adapter.addNode({
          agentId: clearAgentId,
          type: 'person',
          name: 'ToClear',
          aliases: [],
          properties: {},
          confidence: 1,
          source: 'user',
        });

        await adapter.clearGraph(clearAgentId);

        const result = await adapter.queryNodes({ agentId: clearAgentId });
        expect(result.success).toBe(true);
        expect(result.data!.length).toBe(0);
      });

      it('gets graph stats', async () => {
        const statsAgentId = 'stats-test-agent';

        const n1 = await adapter.addNode({
          agentId: statsAgentId,
          type: 'person',
          name: 'Stats1',
          aliases: [],
          properties: {},
          confidence: 1,
          source: 'user',
        });

        const n2 = await adapter.addNode({
          agentId: statsAgentId,
          type: 'organization',
          name: 'Stats2',
          aliases: [],
          properties: {},
          confidence: 1,
          source: 'user',
        });

        await adapter.addEdge({
          agentId: statsAgentId,
          sourceNodeId: n1.data!.id,
          targetNodeId: n2.data!.id,
          type: 'works_at',
          weight: 1,
          bidirectional: false,
          properties: {},
          confidence: 1,
          source: 'user',
        });

        const result = await adapter.getGraphStats(statsAgentId);

        expect(result.success).toBe(true);
        expect(result.data!.nodeCount).toBe(2);
        expect(result.data!.edgeCount).toBe(1);
        expect(result.data!.nodesByType.person).toBe(1);
        expect(result.data!.nodesByType.organization).toBe(1);
      });
    });

    describe('Semantic search', () => {
      it('searches nodes by embedding similarity', async () => {
        const embedding = Array.from({ length: 1536 }, () => Math.random());

        await adapter.addNode({
          agentId: TEST_AGENT_ID,
          type: 'concept',
          name: 'EmbeddedNode',
          aliases: [],
          properties: {},
          embedding,
          confidence: 1,
          source: 'user',
        });

        const result = await adapter.searchNodesSemantic({
          agentId: TEST_AGENT_ID,
          vector: embedding,
          threshold: 0.5,
          limit: 10,
        });

        expect(result.success).toBe(true);
        expect(result.data!.length).toBeGreaterThanOrEqual(1);
        expect(result.data![0].score).toBeGreaterThanOrEqual(0.5);
      });

      it('returns empty for no vector', async () => {
        const result = await adapter.searchNodesSemantic({
          agentId: TEST_AGENT_ID,
          limit: 10,
        });

        expect(result.success).toBe(true);
        expect(result.data!.length).toBe(0);
      });
    });
  });
}

runAdapterTests('MemoryGraphAdapter', () => new MemoryGraphAdapter());

describe('PostgresGraphAdapter', () => {
  it('creates adapter instance', () => {
    const adapter = new PostgresGraphAdapter({
      connectionString: 'postgresql://localhost:5432/test',
    });
    expect(adapter).toBeInstanceOf(PostgresGraphAdapter);
  });

  it('returns error when not connected', async () => {
    const adapter = new PostgresGraphAdapter({
      connectionString: 'postgresql://localhost:5432/test',
    });

    const result = await adapter.addNode({
      agentId: 'test',
      type: 'person',
      name: 'Test',
      aliases: [],
      properties: {},
      confidence: 1,
      source: 'user',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Not connected');
  });
});

describe('Neo4jGraphAdapter', () => {
  it('creates adapter instance', () => {
    const adapter = new Neo4jGraphAdapter({
      uri: 'bolt://localhost:7687',
      username: 'neo4j',
      password: 'password',
    });
    expect(adapter).toBeInstanceOf(Neo4jGraphAdapter);
  });

  it('returns error when not connected', async () => {
    const adapter = new Neo4jGraphAdapter({
      uri: 'bolt://localhost:7687',
      username: 'neo4j',
      password: 'password',
    });

    const result = await adapter.addNode({
      agentId: 'test',
      type: 'person',
      name: 'Test',
      aliases: [],
      properties: {},
      confidence: 1,
      source: 'user',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Not connected');
  });
});
