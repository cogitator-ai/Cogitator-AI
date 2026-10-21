import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Evidence, GraphEdge, GraphNode } from '@cogitator-ai/types';
import { PostgresGraphAdapter } from '../knowledge-graph/graph-adapter';

type QueryResult = { rows: Record<string, unknown>[] };

const nodeRow = (id: string, name: string): Record<string, unknown> => ({
  id,
  agent_id: 'agent1',
  type: 'person',
  name,
  aliases: [],
  description: null,
  properties: {},
  confidence: 1,
  source: 'user',
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
  last_accessed_at: '2024-01-01T00:00:00.000Z',
  access_count: 0,
  metadata: {},
});

const newNode: Omit<
  GraphNode,
  'id' | 'createdAt' | 'updatedAt' | 'lastAccessedAt' | 'accessCount'
> = {
  agentId: 'agent1',
  type: 'person',
  name: 'Alice',
  aliases: [],
  properties: {},
  confidence: 1,
  source: 'user',
};

describe('PostgresGraphAdapter', () => {
  const query = vi.fn<(text: string, values?: unknown[]) => Promise<QueryResult>>();
  let adapter: PostgresGraphAdapter;

  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
    adapter = new PostgresGraphAdapter({
      pool: { query, connect: vi.fn(), end: vi.fn() },
    });
  });

  it('indexes node embeddings with HNSW, which works on the empty table', async () => {
    await adapter.initialize();

    const statements = query.mock.calls.map(([text]) => text.replace(/\s+/g, ' ').trim());
    expect(statements).toContain(
      'CREATE INDEX IF NOT EXISTS idx_graph_nodes_embedding ON cogitator.graph_nodes USING hnsw (embedding vector_cosine_ops)'
    );
    expect(statements.some((text) => /ivfflat/i.test(text))).toBe(false);
  });

  it('returns a failed result when schema initialization fails', async () => {
    query.mockRejectedValueOnce(new Error('permission denied for schema cogitator'));

    const res = await adapter.addNode(newNode);

    expect(res).toEqual({ success: false, error: 'permission denied for schema cogitator' });
  });

  it.each([
    ['addNode', () => adapter.addNode(newNode)],
    ['getNode', () => adapter.getNode('node_1')],
    ['queryNodes', () => adapter.queryNodes({ agentId: 'agent1' })],
    ['deleteNode', () => adapter.deleteNode('node_1')],
    ['getEdge', () => adapter.getEdge('edge_1')],
    ['clearGraph', () => adapter.clearGraph('agent1')],
    ['getGraphStats', () => adapter.getGraphStats('agent1')],
  ])('%s returns a failed result when the query fails', async (_name, call) => {
    await adapter.initialize();
    query.mockRejectedValueOnce(new Error('connection terminated'));

    const res = await call();

    expect(res).toEqual({ success: false, error: 'connection terminated' });
  });

  it('traverse reports a neighbor lookup failure instead of a partial result', async () => {
    await adapter.initialize();
    query.mockImplementation(async (text) => {
      if (text.includes('JOIN')) throw new Error('connection terminated');
      if (text.includes('SELECT * FROM')) return { rows: [nodeRow('node_1', 'Alice')] };
      return { rows: [] };
    });

    const res = await adapter.traverse({
      agentId: 'agent1',
      startNodeId: 'node_1',
      maxDepth: 2,
      direction: 'both',
    });

    expect(res).toEqual({ success: false, error: 'connection terminated' });
  });

  it('mergeNodes reports a failed source delete', async () => {
    await adapter.initialize();
    query.mockImplementation(async (text) => {
      if (text.startsWith('DELETE FROM') && text.includes('graph_nodes')) {
        throw new Error('deadlock detected');
      }
      if (text.includes('SELECT * FROM')) return { rows: [nodeRow('node_2', 'Bob')] };
      return { rows: [] };
    });

    const res = await adapter.mergeNodes('node_1', ['node_2']);

    expect(res).toEqual({ success: false, error: 'deadlock detected' });
  });

  describe('evidence', () => {
    const evidence: Evidence[] = [
      { entryId: 'entry_1', quote: 'Alice runs the Lisbon office' },
      { fileRange: { path: 'org.md', start: 10, end: 14 }, quote: 'Lisbon' },
    ];

    const newEdge: Omit<GraphEdge, 'id' | 'createdAt' | 'updatedAt'> = {
      agentId: 'agent1',
      sourceNodeId: 'node_1',
      targetNodeId: 'node_2',
      type: 'works_at',
      weight: 1,
      bidirectional: false,
      properties: {},
      confidence: 1,
      source: 'user',
    };

    const edgeRow = (stored: Evidence[] | null): Record<string, unknown> => ({
      id: 'edge_1',
      agent_id: 'agent1',
      source_node_id: 'node_1',
      target_node_id: 'node_2',
      type: 'works_at',
      label: null,
      weight: 1,
      bidirectional: false,
      properties: {},
      confidence: 1,
      source: 'user',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
      valid_from: null,
      valid_until: null,
      metadata: {},
      evidence: stored,
    });

    const sent = (fragment: string) => {
      const call = query.mock.calls.find(([text]) => text.includes(fragment));
      if (!call) throw new Error(`No query containing ${fragment}`);
      return { text: call[0], values: call[1] ?? [] };
    };

    it('adds the evidence column to new and existing tables', async () => {
      await adapter.initialize();

      const statements = query.mock.calls.map(([text]) => text.replace(/\s+/g, ' ').trim());
      for (const table of ['graph_nodes', 'graph_edges']) {
        expect(
          statements.some((text) =>
            new RegExp(`CREATE TABLE IF NOT EXISTS cogitator\\.${table} \\(.*evidence JSONB`).test(
              text
            )
          )
        ).toBe(true);
        expect(statements).toContain(
          `ALTER TABLE cogitator.${table} ADD COLUMN IF NOT EXISTS evidence JSONB`
        );
      }
    });

    it.each([
      [
        'addNode',
        () => adapter.addNode({ ...newNode, evidence }),
        'INSERT INTO cogitator.graph_nodes',
        13,
      ],
      [
        'addEdge',
        () => adapter.addEdge({ ...newEdge, evidence }),
        'INSERT INTO cogitator.graph_edges',
        16,
      ],
    ])('%s sends evidence as JSON text cast to jsonb', async (_name, add, fragment, position) => {
      const res = await add();

      const { text, values } = sent(fragment);
      expect(text).toContain(`$${position}::jsonb`);
      expect(JSON.parse(values[position - 1] as string)).toEqual(evidence);
      expect(res.success && res.data.evidence).toEqual(evidence);
    });

    it.each([
      ['addNode', () => adapter.addNode(newNode), 'INSERT INTO cogitator.graph_nodes', 13],
      ['addEdge', () => adapter.addEdge(newEdge), 'INSERT INTO cogitator.graph_edges', 16],
    ])('%s stores NULL for an item without evidence', async (_name, add, fragment, position) => {
      const res = await add();

      expect(sent(fragment).values[position - 1]).toBeNull();
      expect(res.success && res.data).not.toHaveProperty('evidence');
    });

    it('reads node evidence back and leaves it out of nodes without it', async () => {
      await adapter.initialize();
      query.mockImplementation(async (text) =>
        text.includes('SELECT * FROM')
          ? { rows: [{ ...nodeRow('node_1', 'Alice'), evidence }, nodeRow('node_2', 'Bob')] }
          : { rows: [] }
      );

      const res = await adapter.queryNodes({ agentId: 'agent1' });

      expect(res.success).toBe(true);
      if (!res.success) return;
      expect(res.data[0].evidence).toEqual(evidence);
      expect(res.data[1]).not.toHaveProperty('evidence');
    });

    it('reads edge evidence back and leaves it out of edges without it', async () => {
      await adapter.initialize();
      query.mockImplementation(async (text) =>
        text.includes('SELECT * FROM') ? { rows: [edgeRow(evidence), edgeRow(null)] } : { rows: [] }
      );

      const res = await adapter.getEdgesBetween('node_1', 'node_2');

      expect(res.success).toBe(true);
      if (!res.success) return;
      expect(res.data[0].evidence).toEqual(evidence);
      expect(res.data[1]).not.toHaveProperty('evidence');
    });

    it('reads the evidence of neighbors and of the edges to them', async () => {
      await adapter.initialize();
      query.mockImplementation(async (text) =>
        text.includes('JOIN')
          ? {
              rows: [
                {
                  ...nodeRow('node_2', 'Bob'),
                  evidence,
                  edge_id: 'edge_1',
                  edge_agent_id: 'agent1',
                  edge_type: 'knows',
                  source_node_id: 'node_1',
                  target_node_id: 'node_2',
                  weight: 1,
                  bidirectional: false,
                  edge_properties: {},
                  edge_confidence: 1,
                  edge_source: 'user',
                  edge_metadata: {},
                  edge_evidence: evidence.slice(1),
                  edge_created_at: '2024-01-01T00:00:00.000Z',
                  edge_updated_at: '2024-01-01T00:00:00.000Z',
                },
              ],
            }
          : { rows: [] }
      );

      const res = await adapter.getNeighbors('node_1');

      expect(sent('JOIN').text).toMatch(/n\.evidence,[\s\S]*e\.evidence as edge_evidence/);
      expect(res.success).toBe(true);
      if (!res.success) return;
      expect(res.data[0].node.evidence).toEqual(evidence);
      expect(res.data[0].edge.evidence).toEqual(evidence.slice(1));
    });

    it.each([
      [
        'updateNode',
        () => adapter.updateNode('node_1', { evidence }),
        'UPDATE cogitator.graph_nodes SET',
        { ...nodeRow('node_1', 'Alice'), evidence },
      ],
      [
        'updateEdge',
        () => adapter.updateEdge('edge_1', { evidence }),
        'UPDATE cogitator.graph_edges SET',
        edgeRow(evidence),
      ],
    ])('%s replaces the evidence', async (_name, update, fragment, stored) => {
      await adapter.initialize();
      query.mockImplementation(async (text) =>
        text.includes(fragment) ? { rows: [stored] } : { rows: [] }
      );

      const res = await update();

      const { text, values } = sent(fragment);
      expect(text).toContain('evidence = $1::jsonb');
      expect(JSON.parse(values[0] as string)).toEqual(evidence);
      expect(res.success && res.data.evidence).toEqual(evidence);
    });

    describe('mergeNodes', () => {
      const extra: Evidence = { toolCallId: 'call_9', quote: 'Lisbon office' };
      const stored = new Map<string, Record<string, unknown>>();

      beforeEach(async () => {
        await adapter.initialize();
        stored.clear();
        query.mockImplementation(async (text, values = []) => {
          if (text.includes('SELECT * FROM cogitator.graph_nodes WHERE id = $1')) {
            const row = stored.get(values[0] as string);
            return { rows: row ? [row] : [] };
          }
          if (text.startsWith('DELETE FROM cogitator.graph_nodes WHERE id = $1')) {
            stored.delete(values[0] as string);
            return { rows: [] };
          }
          if (text.startsWith('UPDATE cogitator.graph_nodes SET') && text.includes('RETURNING *')) {
            const id = values.at(-1) as string;
            const row = { ...stored.get(id) };
            if (text.includes('evidence = $1::jsonb'))
              row.evidence = JSON.parse(values[0] as string);
            stored.set(id, row);
            return { rows: [row] };
          }
          return { rows: [] };
        });
      });

      const put = (id: string, own?: Evidence[]) =>
        stored.set(id, { ...nodeRow(id, id), ...(own ? { evidence: own } : {}) });

      it('gives the target its own evidence and that of every source once, in order', async () => {
        put('node_t', [evidence[0]]);
        put('node_a', [evidence[1], evidence[0]]);
        put('node_b');
        put('node_c', [{ ...evidence[1] }, extra]);

        const res = await adapter.mergeNodes('node_t', ['node_a', 'node_b', 'node_c']);

        expect(res.success && res.data.evidence).toEqual([evidence[0], evidence[1], extra]);
        expect(stored.get('node_t')?.evidence).toEqual([evidence[0], evidence[1], extra]);
      });

      it('leaves evidence absent when no merged node has any', async () => {
        put('node_t');
        put('node_a');

        const res = await adapter.mergeNodes('node_t', ['node_a']);

        expect(res.success).toBe(true);
        expect(res.success && res.data).not.toHaveProperty('evidence');
        expect(query.mock.calls.some(([text]) => text.includes('evidence = $'))).toBe(false);
      });
    });

    it('leaves evidence alone when an update does not carry it', async () => {
      await adapter.initialize();
      query.mockImplementation(async (text) =>
        text.includes('UPDATE cogitator.graph_nodes SET')
          ? { rows: [nodeRow('node_1', 'Alicia')] }
          : { rows: [] }
      );

      await adapter.updateNode('node_1', { name: 'Alicia' });

      expect(sent('UPDATE cogitator.graph_nodes SET').text).not.toContain('evidence');
    });
  });
});
