import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PostgresAdapter, PostgresGraphAdapter, SQLiteGraphAdapter } from '@cogitator-ai/memory';
import type { Evidence, GraphEdge, GraphNode } from '@cogitator-ai/types';

const postgresUrl = process.env.TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!postgresUrl);

const tag = randomUUID().replace(/-/g, '').slice(0, 8);

const evidence: Evidence[] = [
  { entryId: 'entry_1', quote: 'Alice moved to the Lisbon office in March' },
  { toolCallId: 'call_7', quote: '"office": "Lisbon"' },
  { fileRange: { path: 'docs/team.md', start: 12, end: 18 }, quote: 'Lisbon' },
];

function unwrap<T>(result: { success: true; data: T } | { success: false; error: string }): T {
  if (!result.success) throw new Error(result.error);
  return result.data;
}

const node = (
  name: string
): Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt' | 'lastAccessedAt' | 'accessCount'> => ({
  agentId: `agent-${tag}`,
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
  agentId: `agent-${tag}`,
  sourceNodeId,
  targetNodeId,
  type: 'works_at',
  weight: 1,
  bidirectional: false,
  properties: {},
  confidence: 0.9,
  source: 'extracted',
});

/** Writes nodes and edges with and without evidence and reads every one of them back */
async function graphRoundTrip(graph: PostgresGraphAdapter | SQLiteGraphAdapter): Promise<void> {
  const alice = unwrap(await graph.addNode({ ...node('Alice'), evidence }));
  const lisbon = unwrap(await graph.addNode(node('Lisbon')));
  const worksAt = unwrap(await graph.addEdge({ ...edge(alice.id, lisbon.id), evidence }));
  const hosts = unwrap(await graph.addEdge(edge(lisbon.id, alice.id)));

  expect(unwrap(await graph.getNode(alice.id))?.evidence).toEqual(evidence);
  expect(unwrap(await graph.getNode(lisbon.id))).not.toHaveProperty('evidence');
  expect(unwrap(await graph.getEdge(worksAt.id))?.evidence).toEqual(evidence);
  expect(unwrap(await graph.getEdge(hosts.id))).not.toHaveProperty('evidence');

  const listed = unwrap(await graph.queryNodes({ agentId: `agent-${tag}` }));
  expect(listed.find((n) => n.id === alice.id)?.evidence).toEqual(evidence);
  expect(listed.find((n) => n.id === lisbon.id)).not.toHaveProperty('evidence');

  const neighbors = unwrap(await graph.getNeighbors(lisbon.id, 'incoming'));
  const fromAlice = neighbors.find((n) => n.edge.id === worksAt.id);
  expect(fromAlice?.node.evidence).toEqual(evidence);
  expect(fromAlice?.edge.evidence).toEqual(evidence);

  unwrap(await graph.updateNode(lisbon.id, { evidence: evidence.slice(2) }));
  unwrap(await graph.updateNode(lisbon.id, { name: 'Lisboa' }));
  expect(unwrap(await graph.getNode(lisbon.id))?.evidence).toEqual(evidence.slice(2));

  unwrap(await graph.updateEdge(hosts.id, { evidence: evidence.slice(1, 2) }));
  unwrap(await graph.updateEdge(hosts.id, { weight: 0.4 }));
  expect(unwrap(await graph.getEdge(hosts.id))?.evidence).toEqual(evidence.slice(1, 2));
}

/** Merges nodes with overlapping evidence into one and nodes without any into another */
async function mergeRoundTrip(graph: PostgresGraphAdapter | SQLiteGraphAdapter): Promise<void> {
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

describe('Memory: evidence in the SQLite graph', () => {
  it('keeps the evidence of nodes and edges across a reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-graph-'));
    const path = join(dir, 'graph.db');
    try {
      const graph = new SQLiteGraphAdapter({ path });
      await graph.initialize();
      await graph.addNode({ ...node('Reopened'), evidence });
      await graph.close();

      const reopened = new SQLiteGraphAdapter({ path });
      await reopened.initialize();
      const found = unwrap(await reopened.getNodeByName(`agent-${tag}`, 'Reopened'));
      expect(found?.evidence).toEqual(evidence);
      await graphRoundTrip(reopened);
      await mergeRoundTrip(reopened);
      await reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describePostgres('Memory: evidence in Postgres', () => {
  const factsSchema = `evidence_facts_${tag}`;
  const legacySchema = `evidence_legacy_${tag}`;
  const graphSchema = `evidence_graph_${tag}`;
  const legacyGraphSchema = `evidence_legacy_graph_${tag}`;
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: postgresUrl, max: 2 });
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  });

  afterAll(async () => {
    for (const schema of [factsSchema, legacySchema, graphSchema, legacyGraphSchema]) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
    await pool.end();
  });

  async function memoryIn(schema: string): Promise<PostgresAdapter> {
    const adapter = new PostgresAdapter({
      provider: 'postgres',
      connectionString: postgresUrl!,
      schema,
    });
    unwrap(await adapter.connect());
    return adapter;
  }

  async function factsRoundTrip(adapter: PostgresAdapter, agentId: string): Promise<void> {
    const fact = {
      agentId,
      content: 'Alice works from the Lisbon office',
      category: 'workplace',
      confidence: 0.8,
      source: 'inferred' as const,
    };
    const proven = unwrap(await adapter.addFact({ ...fact, evidence }));
    const bare = unwrap(await adapter.addFact({ ...fact, content: 'Alice likes tea' }));

    const facts = unwrap(await adapter.getFacts(agentId));
    expect(facts.find((f) => f.id === proven.id)?.evidence).toEqual(evidence);
    expect(facts.find((f) => f.id === bare.id)).not.toHaveProperty('evidence');

    const searched = unwrap(await adapter.searchFacts(agentId, 'Lisbon'));
    expect(searched.map((f) => f.evidence)).toEqual([evidence]);

    const updated = unwrap(await adapter.updateFact(bare.id, { evidence: evidence.slice(0, 1) }));
    expect(updated.evidence).toEqual(evidence.slice(0, 1));
    unwrap(await adapter.updateFact(bare.id, { confidence: 0.95 }));
    const reread = unwrap(await adapter.getFacts(agentId));
    expect(reread.find((f) => f.id === bare.id)?.evidence).toEqual(evidence.slice(0, 1));
  }

  it('keeps the evidence of facts, and none for facts without it', async () => {
    const adapter = await memoryIn(factsSchema);
    try {
      await factsRoundTrip(adapter, `agent-${tag}`);
    } finally {
      await adapter.disconnect();
    }
  });

  it('adds the evidence column to a facts table from before it', async () => {
    await pool.query(`CREATE SCHEMA ${legacySchema}`);
    await pool.query(`
      CREATE TABLE ${legacySchema}.facts (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        content TEXT NOT NULL,
        category TEXT NOT NULL,
        confidence REAL DEFAULT 1.0,
        source TEXT NOT NULL,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ
      )
    `);
    await pool.query(
      `INSERT INTO ${legacySchema}.facts (id, agent_id, content, category, source)
       VALUES ('fact_old', $1, 'Alice joined in 2019', 'history', 'user')`,
      [`legacy-${tag}`]
    );

    const adapter = await memoryIn(legacySchema);
    try {
      const old = unwrap(await adapter.getFacts(`legacy-${tag}`));
      expect(old).toHaveLength(1);
      expect(old[0]).not.toHaveProperty('evidence');
      await factsRoundTrip(adapter, `legacy-${tag}`);
    } finally {
      await adapter.disconnect();
    }
  });

  it('keeps the evidence of graph nodes and edges', async () => {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${graphSchema}`);
    const graph = new PostgresGraphAdapter({ pool, schema: graphSchema, vectorDimensions: 3 });
    await graph.initialize();
    await graphRoundTrip(graph);
    await mergeRoundTrip(graph);
  });

  it('adds the evidence column to graph tables from before it', async () => {
    await pool.query(`CREATE SCHEMA ${legacyGraphSchema}`);
    await pool.query(`
      CREATE TABLE ${legacyGraphSchema}.graph_nodes (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
        aliases TEXT[] DEFAULT '{}', description TEXT, properties JSONB DEFAULT '{}',
        embedding vector(3), confidence REAL NOT NULL DEFAULT 1.0, source TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
        last_accessed_at TIMESTAMPTZ DEFAULT NOW(), access_count INTEGER DEFAULT 0,
        metadata JSONB DEFAULT '{}'
      )
    `);
    await pool.query(`
      CREATE TABLE ${legacyGraphSchema}.graph_edges (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
        source_node_id TEXT NOT NULL REFERENCES ${legacyGraphSchema}.graph_nodes(id) ON DELETE CASCADE,
        target_node_id TEXT NOT NULL REFERENCES ${legacyGraphSchema}.graph_nodes(id) ON DELETE CASCADE,
        type TEXT NOT NULL, label TEXT, weight REAL NOT NULL DEFAULT 1.0,
        bidirectional BOOLEAN DEFAULT FALSE, properties JSONB DEFAULT '{}',
        confidence REAL NOT NULL DEFAULT 1.0, source TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
        valid_from TIMESTAMPTZ, valid_until TIMESTAMPTZ, metadata JSONB DEFAULT '{}'
      )
    `);
    await pool.query(
      `INSERT INTO ${legacyGraphSchema}.graph_nodes (id, agent_id, type, name, source)
       VALUES ('node_old', $1, 'person', 'Old', 'user')`,
      [`agent-${tag}`]
    );

    const graph = new PostgresGraphAdapter({
      pool,
      schema: legacyGraphSchema,
      vectorDimensions: 3,
    });
    await graph.initialize();

    expect(unwrap(await graph.getNode('node_old'))).not.toHaveProperty('evidence');
    await graphRoundTrip(graph);
  });
});
