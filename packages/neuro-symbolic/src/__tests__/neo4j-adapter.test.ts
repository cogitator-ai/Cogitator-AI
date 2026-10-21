import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Evidence, GraphEdge, GraphNode, MemoryResult } from '@cogitator-ai/types';
import { Neo4jGraphAdapter } from '../knowledge-graph/adapters/neo4j-adapter';

type Properties = Record<string, unknown>;

interface StoredEdge {
  properties: Properties;
  sourceId: string;
  targetId: string;
}

/**
 * Just enough of Neo4j for single nodes and edges: properties are kept as given, a null leaves a
 * property unset, and `SET x.key = $param` writes a parameter the same way
 */
const store = {
  nodes: new Map<string, Properties>(),
  edges: new Map<string, StoredEdge>(),
  queries: [] as { query: string; params: Properties }[],
};

function withoutNulls(params: Properties, keys: string[]): Properties {
  const properties: Properties = {};
  for (const key of keys) {
    if (params[key] !== null && params[key] !== undefined) properties[key] = params[key];
  }
  return properties;
}

function applySets(target: Properties, alias: string, query: string, params: Properties): void {
  for (const [, key, param] of query.matchAll(new RegExp(`${alias}\\.(\\w+) = \\$(\\w+)`, 'g'))) {
    if (params[param] === null) delete target[key];
    else target[key] = params[param];
  }
}

function record(values: Record<string, unknown>) {
  return { get: (key: string) => values[key], toObject: () => values };
}

const NODE_KEYS = [
  'id',
  'agentId',
  'type',
  'name',
  'aliases',
  'description',
  'properties',
  'embedding',
  'confidence',
  'source',
  'metadata',
  'evidence',
  'createdAt',
  'updatedAt',
  'lastAccessedAt',
];

const EDGE_KEYS = [
  'id',
  'agentId',
  'type',
  'label',
  'weight',
  'bidirectional',
  'properties',
  'confidence',
  'source',
  'validFrom',
  'validUntil',
  'metadata',
  'evidence',
  'createdAt',
  'updatedAt',
];

async function run(query: string, params: Properties = {}) {
  store.queries.push({ query, params });
  if (query.startsWith('CREATE (n:GraphNode')) {
    const node = { ...withoutNulls(params, NODE_KEYS), accessCount: 0 };
    store.nodes.set(params.id as string, node);
    return { records: [record({ n: { properties: node } })] };
  }
  if (query.includes('CREATE (s)-[r:RELATION')) {
    const edge = {
      properties: withoutNulls(params, EDGE_KEYS),
      sourceId: params.sourceNodeId as string,
      targetId: params.targetNodeId as string,
    };
    store.edges.set(params.id as string, edge);
    return {
      records: [record({ r: { properties: edge.properties }, sourceId: edge.sourceId })],
    };
  }
  if (query.includes('MATCH (n:GraphNode {id: $nodeId})')) {
    const node = store.nodes.get(params.nodeId as string);
    if (!node) return { records: [] };
    applySets(node, 'n', query, params);
    return { records: [record({ n: { properties: node } })] };
  }
  if (query.includes('[r:RELATION {id: $edgeId}]')) {
    const edge = store.edges.get(params.edgeId as string);
    if (!edge) return { records: [] };
    applySets(edge.properties, 'r', query, params);
    return {
      records: [
        record({
          r: { properties: edge.properties },
          sourceId: edge.sourceId,
          targetId: edge.targetId,
        }),
      ],
    };
  }
  return { records: [] };
}

vi.mock('neo4j-driver', () => ({
  default: {
    auth: { basic: () => ({}) },
    driver: () => ({
      session: () => ({ run, executeWrite: vi.fn(), close: async () => undefined }),
      close: async () => undefined,
    }),
  },
}));

function unwrap<T>(result: MemoryResult<T>): T {
  if (!result.success) throw new Error(result.error);
  return result.data;
}

const evidence: Evidence[] = [
  { entryId: 'entry_1', quote: 'Alice works at Acme' },
  { toolCallId: 'call_1', fileRange: { path: 'staff.csv', start: 2, end: 2 }, quote: 'Acme' },
];

const newNode = (
  name: string
): Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt' | 'lastAccessedAt' | 'accessCount'> => ({
  agentId: 'agent',
  type: 'person',
  name,
  aliases: [],
  properties: {},
  confidence: 1,
  source: 'user',
});

const newEdge = (
  sourceNodeId: string,
  targetNodeId: string
): Omit<GraphEdge, 'id' | 'createdAt' | 'updatedAt'> => ({
  agentId: 'agent',
  sourceNodeId,
  targetNodeId,
  type: 'works_at',
  weight: 1,
  bidirectional: false,
  properties: {},
  confidence: 1,
  source: 'user',
});

describe('Neo4jGraphAdapter evidence', () => {
  let adapter: Neo4jGraphAdapter;

  beforeEach(async () => {
    store.nodes.clear();
    store.edges.clear();
    store.queries = [];
    adapter = new Neo4jGraphAdapter({ uri: 'bolt://localhost:7687', username: 'u', password: 'p' });
    expect((await adapter.connect()).success).toBe(true);
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  it('stores node evidence as a JSON string property and reads it back', async () => {
    const added = await adapter.addNode({ ...newNode('Alice'), evidence });
    if (!added.success) throw new Error(added.error);

    expect(typeof store.nodes.get(added.data.id)?.evidence).toBe('string');
    const read = await adapter.getNode(added.data.id);
    expect(read.success && read.data?.evidence).toEqual(evidence);
  });

  it('leaves the property unset for a node without evidence and reads none back', async () => {
    const added = await adapter.addNode(newNode('Bob'));
    if (!added.success) throw new Error(added.error);

    expect(store.nodes.get(added.data.id)).not.toHaveProperty('evidence');
    const read = await adapter.getNode(added.data.id);
    expect(read.success && read.data).not.toHaveProperty('evidence');
  });

  it('stores edge evidence and leaves it out of edges without it', async () => {
    const alice = await adapter.addNode(newNode('Alice'));
    const acme = await adapter.addNode(newNode('Acme'));
    if (!alice.success || !acme.success) throw new Error('nodes not added');

    const withEvidence = await adapter.addEdge({
      ...newEdge(alice.data.id, acme.data.id),
      evidence,
    });
    const without = await adapter.addEdge(newEdge(acme.data.id, alice.data.id));
    if (!withEvidence.success || !without.success) throw new Error('edges not added');

    const read = await adapter.getEdge(withEvidence.data.id);
    expect(read.success && read.data?.evidence).toEqual(evidence);
    const plain = await adapter.getEdge(without.data.id);
    expect(plain.success && plain.data).not.toHaveProperty('evidence');
  });

  it('replaces evidence on update and keeps it when an update does not carry it', async () => {
    const alice = await adapter.addNode(newNode('Alice'));
    const acme = await adapter.addNode(newNode('Acme'));
    if (!alice.success || !acme.success) throw new Error('nodes not added');
    const edge = await adapter.addEdge(newEdge(alice.data.id, acme.data.id));
    if (!edge.success) throw new Error(edge.error);

    const node = await adapter.updateNode(alice.data.id, { evidence });
    expect(node.success && node.data.evidence).toEqual(evidence);
    const renamed = await adapter.updateNode(alice.data.id, { name: 'Alicia' });
    expect(renamed.success && renamed.data.evidence).toEqual(evidence);
    expect(store.queries.at(-1)?.query).not.toContain('evidence');

    const updated = await adapter.updateEdge(edge.data.id, { evidence });
    expect(updated.success && updated.data.evidence).toEqual(evidence);
    const reweighed = await adapter.updateEdge(edge.data.id, { weight: 0.5 });
    expect(reweighed.success && reweighed.data.evidence).toEqual(evidence);
  });

  it('merges the evidence of merged nodes once each, the target first', async () => {
    const extra: Evidence = { entryId: 'entry_5', quote: 'Acme' };
    const target = unwrap(await adapter.addNode({ ...newNode('Alice'), evidence: [evidence[0]] }));
    const first = unwrap(
      await adapter.addNode({ ...newNode('Ali'), evidence: [evidence[1], evidence[0]] })
    );
    const plain = unwrap(await adapter.addNode(newNode('A.')));
    const second = unwrap(
      await adapter.addNode({ ...newNode('Alice S.'), evidence: [{ ...evidence[1] }, extra] })
    );

    const merged = unwrap(await adapter.mergeNodes(target.id, [first.id, plain.id, second.id]));

    expect(merged.evidence).toEqual([evidence[0], evidence[1], extra]);
    expect(JSON.parse(store.nodes.get(target.id)?.evidence as string)).toEqual(merged.evidence);
  });

  it('leaves evidence absent when no merged node has any', async () => {
    const target = unwrap(await adapter.addNode(newNode('Alice')));
    const source = unwrap(await adapter.addNode(newNode('Ali')));

    const merged = unwrap(await adapter.mergeNodes(target.id, [source.id]));

    expect(merged).not.toHaveProperty('evidence');
    expect(store.nodes.get(target.id)).not.toHaveProperty('evidence');
  });
});
