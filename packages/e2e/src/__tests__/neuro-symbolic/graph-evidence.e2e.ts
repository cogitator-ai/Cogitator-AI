import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PostgresGraphAdapter } from '@cogitator-ai/neuro-symbolic';
import type { Evidence, GraphEdge, GraphNode } from '@cogitator-ai/types';

const postgresUrl = process.env.TEST_POSTGRES_URL;

const tag = randomUUID().replace(/-/g, '').slice(0, 8);
const agentId = `agent-${tag}`;

const evidence: Evidence[] = [
  { entryId: 'entry_3', quote: 'Bob reports to Carol since the reorg' },
  {
    toolCallId: 'call_2',
    fileRange: { path: 'org/chart.json', start: 40, end: 44 },
    quote: 'Carol',
  },
];

function unwrap<T>(result: { success: true; data: T } | { success: false; error: string }): T {
  if (!result.success) throw new Error(result.error);
  return result.data;
}

const node = (
  name: string
): Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt' | 'lastAccessedAt' | 'accessCount'> => ({
  agentId,
  type: 'person',
  name,
  aliases: [],
  properties: {},
  confidence: 0.9,
  source: 'extracted',
});

const edge = (
  sourceNodeId: string,
  targetNodeId: string
): Omit<GraphEdge, 'id' | 'createdAt' | 'updatedAt'> => ({
  agentId,
  sourceNodeId,
  targetNodeId,
  type: 'related_to',
  label: 'reports to',
  weight: 1,
  bidirectional: false,
  properties: {},
  confidence: 0.9,
  source: 'extracted',
});

async function roundTrip(graph: PostgresGraphAdapter): Promise<void> {
  const bob = unwrap(await graph.addNode({ ...node('Bob'), evidence }));
  const carol = unwrap(await graph.addNode(node('Carol')));
  const reportsTo = unwrap(await graph.addEdge({ ...edge(bob.id, carol.id), evidence }));
  const manages = unwrap(await graph.addEdge(edge(carol.id, bob.id)));

  expect(unwrap(await graph.getNode(bob.id))?.evidence).toEqual(evidence);
  expect(unwrap(await graph.getNode(carol.id))).not.toHaveProperty('evidence');
  expect(unwrap(await graph.getEdge(reportsTo.id))?.evidence).toEqual(evidence);
  expect(unwrap(await graph.getEdge(manages.id))).not.toHaveProperty('evidence');

  const neighbors = unwrap(await graph.getNeighbors(carol.id, 'incoming'));
  const fromBob = neighbors.find((n) => n.edge.id === reportsTo.id);
  expect(fromBob?.node.evidence).toEqual(evidence);
  expect(fromBob?.edge.evidence).toEqual(evidence);

  unwrap(await graph.updateNode(carol.id, { evidence: evidence.slice(1) }));
  unwrap(await graph.updateNode(carol.id, { description: 'Head of platform' }));
  expect(unwrap(await graph.getNode(carol.id))?.evidence).toEqual(evidence.slice(1));

  unwrap(await graph.updateEdge(manages.id, { evidence: evidence.slice(0, 1) }));
  unwrap(await graph.updateEdge(manages.id, { weight: 0.5 }));
  expect(unwrap(await graph.getEdge(manages.id))?.evidence).toEqual(evidence.slice(0, 1));
}

/** Merges nodes with overlapping evidence into one and nodes without any into another */
async function mergeRoundTrip(graph: PostgresGraphAdapter): Promise<void> {
  const [first, second] = evidence;
  const third: Evidence = { entryId: 'entry_merge', quote: 'the same person' };
  const target = unwrap(await graph.addNode({ ...node('M1'), evidence: [first] }));
  const overlapping = unwrap(await graph.addNode({ ...node('M2'), evidence: [second, first] }));
  const bare = unwrap(await graph.addNode(node('M3')));
  const copied = unwrap(await graph.addNode({ ...node('M4'), evidence: [{ ...second }, third] }));

  const merged = unwrap(await graph.mergeNodes(target.id, [overlapping.id, bare.id, copied.id]));
  expect(merged.evidence).toEqual([first, second, third]);
  expect(unwrap(await graph.getNode(target.id))?.evidence).toEqual([first, second, third]);

  const plainTarget = unwrap(await graph.addNode(node('P1')));
  const plainSource = unwrap(await graph.addNode(node('P2')));
  unwrap(await graph.mergeNodes(plainTarget.id, [plainSource.id]));
  expect(unwrap(await graph.getNode(plainTarget.id))).not.toHaveProperty('evidence');
}

describe.skipIf(!postgresUrl)('Neuro-Symbolic: evidence in the Postgres graph', () => {
  const schema = `ns_evidence_${tag}`;
  const legacySchema = `ns_evidence_legacy_${tag}`;
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: postgresUrl, max: 2 });
  });

  afterAll(async () => {
    for (const name of [schema, legacySchema]) {
      await pool.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
    }
    await pool.end();
  });

  it('keeps the evidence of nodes and edges, and none for items without it', async () => {
    const graph = new PostgresGraphAdapter({
      connectionString: postgresUrl!,
      schema,
      vectorDimensions: 3,
      poolSize: 2,
    });
    unwrap(await graph.connect());
    try {
      await roundTrip(graph);
      await mergeRoundTrip(graph);
    } finally {
      await graph.disconnect();
    }
  });

  it('adds the evidence column to tables from before it', async () => {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await pool.query(`CREATE SCHEMA ${legacySchema}`);
    await pool.query(`
      CREATE TABLE ${legacySchema}.graph_nodes (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
        aliases TEXT[] DEFAULT '{}', description TEXT, properties JSONB DEFAULT '{}',
        embedding vector(3), confidence REAL DEFAULT 0.5, source TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
        last_accessed_at TIMESTAMPTZ DEFAULT NOW(), access_count INTEGER DEFAULT 0,
        metadata JSONB DEFAULT '{}'
      )
    `);
    await pool.query(`
      CREATE TABLE ${legacySchema}.graph_edges (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
        source_node_id TEXT NOT NULL REFERENCES ${legacySchema}.graph_nodes(id) ON DELETE CASCADE,
        target_node_id TEXT NOT NULL REFERENCES ${legacySchema}.graph_nodes(id) ON DELETE CASCADE,
        type TEXT NOT NULL, label TEXT, weight REAL DEFAULT 1.0,
        bidirectional BOOLEAN DEFAULT false, properties JSONB DEFAULT '{}',
        confidence REAL DEFAULT 0.5, source TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
        valid_from TIMESTAMPTZ, valid_until TIMESTAMPTZ, metadata JSONB DEFAULT '{}'
      )
    `);
    await pool.query(
      `INSERT INTO ${legacySchema}.graph_nodes (id, agent_id, type, name, source)
       VALUES ('node_old', $1, 'person', 'Old', 'user')`,
      [agentId]
    );

    const graph = new PostgresGraphAdapter({
      connectionString: postgresUrl!,
      schema: legacySchema,
      vectorDimensions: 3,
      poolSize: 2,
    });
    unwrap(await graph.connect());
    try {
      expect(unwrap(await graph.getNode('node_old'))).not.toHaveProperty('evidence');
      await roundTrip(graph);
    } finally {
      await graph.disconnect();
    }
  });
});
