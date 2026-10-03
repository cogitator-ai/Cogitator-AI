import { describe, it, expect, beforeEach } from 'vitest';
import type {
  EntityType,
  GraphAdapter,
  GraphEdge,
  GraphNode,
  MemoryResult,
  RelationType,
} from '@cogitator-ai/types';
import {
  GraphQueryBuilder,
  parseQueryString,
  formatQueryResult,
  variable,
} from '../knowledge-graph/query-language';

interface MockGraphAdapter extends GraphAdapter {
  getConnections(nodeId: string): Promise<MemoryResult<GraphEdge[]>>;
}

const MOCK_AGENT_ID = 'test';
const MOCK_TIMESTAMP = new Date(0);

function ok<T>(data: T): MemoryResult<T> {
  return { success: true, data };
}

function unwrap<T>(result: MemoryResult<T>): T {
  if (!result.success) throw new Error(result.error);
  return result.data;
}

function createNode(
  id: string,
  type: EntityType,
  name: string,
  properties: Record<string, unknown>
): GraphNode {
  return {
    id,
    agentId: MOCK_AGENT_ID,
    type,
    name,
    aliases: [],
    properties,
    confidence: 1,
    source: 'user',
    createdAt: MOCK_TIMESTAMP,
    updatedAt: MOCK_TIMESTAMP,
    lastAccessedAt: MOCK_TIMESTAMP,
    accessCount: 0,
  };
}

function createEdge(
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  type: RelationType,
  properties: Record<string, unknown>
): GraphEdge {
  return {
    id,
    agentId: MOCK_AGENT_ID,
    sourceNodeId,
    targetNodeId,
    type,
    weight: 1,
    bidirectional: false,
    properties,
    confidence: 1,
    source: 'user',
    createdAt: MOCK_TIMESTAMP,
    updatedAt: MOCK_TIMESTAMP,
  };
}

const createMockAdapter = (): MockGraphAdapter => {
  const nodes: GraphNode[] = [
    createNode('person1', 'person', 'Alice', { age: 30 }),
    createNode('person2', 'person', 'Bob', { age: 25 }),
    createNode('company1', 'organization', 'TechCorp', { employees: 100 }),
    createNode('city1', 'location', 'New York', { population: 8000000 }),
  ];

  const edges: GraphEdge[] = [
    createEdge('e1', 'person1', 'company1', 'works_at', { since: 2020 }),
    createEdge('e2', 'person2', 'company1', 'works_at', { since: 2021 }),
    createEdge('e3', 'person1', 'city1', 'located_in', {}),
    createEdge('e4', 'person1', 'person2', 'knows', { years: 5 }),
  ];

  const findNode = (nodeId: string) => nodes.find((n) => n.id === nodeId);
  const findEdge = (edgeId: string) => edges.find((e) => e.id === edgeId);

  return {
    addNode: async () => ok(nodes[0]),
    addEdge: async () => ok(edges[0]),
    getNode: async (nodeId) => ok(findNode(nodeId) ?? null),
    getNodeByName: async (agentId, name) =>
      ok(nodes.find((n) => n.agentId === agentId && n.name === name) ?? null),
    getEdge: async (edgeId) => ok(findEdge(edgeId) ?? null),
    getEdgesBetween: async (sourceNodeId, targetNodeId) =>
      ok(edges.filter((e) => e.sourceNodeId === sourceNodeId && e.targetNodeId === targetNodeId)),
    updateNode: async (nodeId, updates) => {
      const node = findNode(nodeId);
      return node
        ? ok({ ...node, ...updates })
        : { success: false, error: `Node not found: ${nodeId}` };
    },
    updateEdge: async (edgeId, updates) => {
      const edge = findEdge(edgeId);
      return edge
        ? ok({ ...edge, ...updates })
        : { success: false, error: `Edge not found: ${edgeId}` };
    },
    deleteNode: async () => ok(undefined),
    deleteEdge: async () => ok(undefined),
    queryNodes: async (query) =>
      ok(nodes.filter((n) => !query.types || query.types.includes(n.type))),
    searchNodesSemantic: async () => ok([]),
    queryEdges: async (query) =>
      ok(edges.filter((e) => !query.types || query.types.includes(e.type))),
    traverse: async () => ok({ paths: [], visitedNodes: [], visitedEdges: [], depth: 0 }),
    findShortestPath: async () => ok(null),
    getNeighbors: async (nodeId, direction = 'both') =>
      ok(
        edges.flatMap((edge) => {
          const neighborId =
            edge.sourceNodeId === nodeId && direction !== 'incoming'
              ? edge.targetNodeId
              : edge.targetNodeId === nodeId && direction !== 'outgoing'
                ? edge.sourceNodeId
                : undefined;
          const node = neighborId === undefined ? undefined : findNode(neighborId);
          return node ? [{ node, edge }] : [];
        })
      ),
    getConnections: async (nodeId) =>
      ok(edges.filter((e) => e.sourceNodeId === nodeId || e.targetNodeId === nodeId)),
    mergeNodes: async (targetNodeId) => {
      const node = findNode(targetNodeId);
      return node ? ok(node) : { success: false, error: `Node not found: ${targetNodeId}` };
    },
    clearGraph: async () => ok(undefined),
    getGraphStats: async () =>
      ok({
        nodeCount: nodes.length,
        edgeCount: edges.length,
        nodesByType: {},
        edgesByType: {},
        averageEdgesPerNode: edges.length / nodes.length,
        maxDepth: 0,
      }),
  };
};

describe('GraphQueryBuilder', () => {
  describe('Basic query construction', () => {
    it('creates select query', () => {
      const query = GraphQueryBuilder.select().build();
      expect(query.type).toBe('select');
      expect(query.patterns).toEqual([]);
    });

    it('creates ask query', () => {
      const query = GraphQueryBuilder.ask().build();
      expect(query.type).toBe('ask');
    });

    it('creates construct query', () => {
      const query = GraphQueryBuilder.construct().build();
      expect(query.type).toBe('construct');
    });

    it('creates describe query', () => {
      const query = GraphQueryBuilder.describe().build();
      expect(query.type).toBe('describe');
    });
  });

  describe('Pattern matching with where', () => {
    it('adds pattern with where clause', () => {
      const p = variable('p');
      const query = GraphQueryBuilder.select().where(p, 'type', 'Person').build();

      expect(query.patterns).toHaveLength(1);
      expect(query.patterns[0].subject).toBe(p);
    });

    it('chains multiple patterns', () => {
      const p = variable('p');
      const c = variable('c');
      const query = GraphQueryBuilder.select()
        .where(p, 'type', 'Person')
        .where(p, 'WORKS_AT', c)
        .build();

      expect(query.patterns).toHaveLength(2);
    });
  });

  describe('Variables', () => {
    it('creates variable reference', () => {
      const v = variable('person');
      expect(v.name).toBe('person');
    });

    it('uses variables in patterns', () => {
      const p = variable('p');
      const c = variable('c');

      const query = GraphQueryBuilder.select().where(p, 'WORKS_AT', c).build();

      expect(query.patterns).toHaveLength(1);
    });
  });

  describe('Filters', () => {
    it('adds filter with equality', () => {
      const query = GraphQueryBuilder.select().filter('age', 'eq', 30).build();

      expect(query.filters).toHaveLength(1);
      expect(query.filters![0]).toEqual({ field: 'age', operator: 'eq', value: 30 });
    });

    it('adds filter with comparison', () => {
      const query = GraphQueryBuilder.select().filter('age', 'gt', 25).build();

      expect(query.filters![0].operator).toBe('gt');
    });

    it('chains multiple filters', () => {
      const query = GraphQueryBuilder.select()
        .filter('age', 'gt', 20)
        .filter('age', 'lt', 40)
        .build();

      expect(query.filters).toHaveLength(2);
    });
  });

  describe('Ordering and Limits', () => {
    it('adds orderBy clause', () => {
      const query = GraphQueryBuilder.select().orderBy('name', 'asc').build();

      expect(query.orderBy).toEqual([{ field: 'name', direction: 'asc' }]);
    });

    it('adds descending order', () => {
      const query = GraphQueryBuilder.select().orderBy('age', 'desc').build();

      expect(query.orderBy![0].direction).toBe('desc');
    });

    it('adds limit', () => {
      const query = GraphQueryBuilder.select().limit(10).build();

      expect(query.limit).toBe(10);
    });

    it('adds offset', () => {
      const query = GraphQueryBuilder.select().offset(5).build();

      expect(query.offset).toBe(5);
    });

    it('combines limit and offset', () => {
      const query = GraphQueryBuilder.select().limit(10).offset(20).build();

      expect(query.limit).toBe(10);
      expect(query.offset).toBe(20);
    });
  });

  describe('Aggregations', () => {
    it('adds count aggregation', () => {
      const query = GraphQueryBuilder.select().count('person', 'totalPeople').build();

      expect(query.aggregates).toHaveLength(1);
      expect(query.aggregates![0].function).toBe('count');
    });

    it('adds sum aggregation', () => {
      const query = GraphQueryBuilder.select().sum('age', 'totalAge').build();

      expect(query.aggregates![0].function).toBe('sum');
    });

    it('adds avg aggregation', () => {
      const query = GraphQueryBuilder.select().avg('age', 'avgAge').build();

      expect(query.aggregates![0].function).toBe('avg');
    });

    it('adds min/max aggregations', () => {
      const query = GraphQueryBuilder.select().min('age', 'minAge').max('age', 'maxAge').build();

      expect(query.aggregates).toHaveLength(2);
    });

    it('adds groupBy', () => {
      const query = GraphQueryBuilder.select().groupBy('type', 'status').build();

      expect(query.groupBy).toEqual(['type', 'status']);
    });
  });
});

describe('parseQueryString', () => {
  it('returns parsed result structure', () => {
    const result = parseQueryString('SELECT ?p WHERE ?p type Person');
    expect(result.type).toBe('select');
    expect(result.patterns).toBeDefined();
  });

  it('parses select query type', () => {
    const result = parseQueryString('SELECT ?x WHERE ?x type Person');
    expect(result.type).toBe('select');
  });

  it('parses ask query type', () => {
    const result = parseQueryString('ASK WHERE ?x type Person');
    expect(result.type).toBe('ask');
  });

  it('parses construct query type', () => {
    const result = parseQueryString('CONSTRUCT WHERE ?x type Person');
    expect(result.type).toBe('construct');
  });

  it('parses describe query type', () => {
    const result = parseQueryString('DESCRIBE ?x');
    expect(result.type).toBe('describe');
  });

  it('parses limit clause', () => {
    const result = parseQueryString(`
      SELECT ?x
      LIMIT 10
    `);
    expect(result.limit).toBe(10);
  });

  it('parses offset clause', () => {
    const result = parseQueryString(`
      SELECT ?x
      OFFSET 20
    `);
    expect(result.offset).toBe(20);
  });
});

describe('formatQueryResult', () => {
  it('formats empty result', () => {
    const result = {
      bindings: [],
      count: 0,
      executionTime: 50,
    };

    const formatted = formatQueryResult(result);
    expect(formatted).toContain('No results');
  });

  it('formats result with bindings', () => {
    const result = {
      bindings: [
        { person: { id: '1', type: 'person', name: 'Alice', confidence: 1, source: 'test' } },
        { person: { id: '2', type: 'person', name: 'Bob', confidence: 1, source: 'test' } },
      ],
      count: 2,
      executionTime: 100,
    };

    const formatted = formatQueryResult(result);
    expect(formatted).toContain('2 result(s)');
    expect(formatted).toContain('Alice');
    expect(formatted).toContain('Bob');
  });

  it('includes timing info', () => {
    const result = {
      bindings: [{ x: 'value' }],
      count: 1,
      executionTime: 100,
    };

    const formatted = formatQueryResult(result);
    expect(formatted).toContain('100ms');
  });
});

describe('Query Execution Context', () => {
  let adapter: MockGraphAdapter;

  beforeEach(() => {
    adapter = createMockAdapter();
  });

  it('mock adapter returns nodes by type', async () => {
    const result = await adapter.queryNodes({ agentId: 'test', types: ['person'] });
    expect(result.success).toBe(true);
    expect(unwrap(result)).toHaveLength(2);
  });

  it('mock adapter returns edges by type', async () => {
    const result = await adapter.queryEdges({ agentId: 'test', types: ['works_at'] });
    expect(result.success).toBe(true);
    expect(unwrap(result)).toHaveLength(2);
  });

  it('mock adapter returns neighbors', async () => {
    const result = await adapter.getNeighbors('person1');
    expect(result.success).toBe(true);
    expect(unwrap(result).length).toBeGreaterThan(0);
  });

  it('mock adapter returns connections', async () => {
    const result = await adapter.getConnections('person1');
    expect(result.success).toBe(true);
    expect(unwrap(result).length).toBeGreaterThan(0);
  });

  it('mock adapter gets node by id', async () => {
    const result = await adapter.getNode('person1');
    expect(result.success).toBe(true);
    expect(unwrap(result)?.name).toBe('Alice');
  });

  it('mock adapter gets edge by id', async () => {
    const result = await adapter.getEdge('e1');
    expect(result.success).toBe(true);
    expect(unwrap(result)?.type).toBe('works_at');
  });

  it('mock adapter returns stats', async () => {
    const result = await adapter.getGraphStats('test');
    expect(result.success).toBe(true);
    expect(unwrap(result).nodeCount).toBe(4);
    expect(unwrap(result).edgeCount).toBe(4);
  });
});

describe('Query Builder Chaining', () => {
  it('supports full method chaining', () => {
    const p = variable('p');

    const query = GraphQueryBuilder.select()
      .where(p, 'type', 'Person')
      .filter('age', 'gt', 18)
      .filter('age', 'lt', 65)
      .orderBy('name', 'asc')
      .limit(100)
      .build();

    expect(query.patterns).toHaveLength(1);
    expect(query.filters).toHaveLength(2);
    expect(query.orderBy).toHaveLength(1);
    expect(query.limit).toBe(100);
  });

  it('builds query with multiple variables', () => {
    const p = variable('p');
    const c = variable('c');
    const city = variable('city');

    const query = GraphQueryBuilder.select()
      .where(p, 'type', 'Person')
      .where(p, 'WORKS_AT', c)
      .where(c, 'LOCATED_IN', city)
      .filter('p.age', 'gt', 25)
      .build();

    expect(query.patterns).toHaveLength(3);
    expect(query.filters).toHaveLength(1);
  });
});
