import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { GraphNode } from '@cogitator-ai/types';
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
});
