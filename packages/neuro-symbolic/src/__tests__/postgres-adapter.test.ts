import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Evidence } from '@cogitator-ai/types';
import { PostgresGraphAdapter } from '../knowledge-graph/adapters/postgres-adapter';

interface QueryResult {
  rows: Record<string, unknown>[];
}

type Query = (text: string, values?: unknown[]) => Promise<QueryResult>;

const database = {
  existingIndex: null as string | null,
  pgvectorVersion: '0.8.5' as string | null,
  searchRows: [] as Record<string, unknown>[],
};

const poolQuery = vi.fn<Query>();
const clientQuery = vi.fn<Query>();
const release = vi.fn<(destroy?: boolean) => void>();

function answer(text: string): QueryResult {
  if (text.includes('FROM pg_indexes')) {
    return { rows: database.existingIndex ? [{ indexdef: database.existingIndex }] : [] };
  }
  if (text.includes('FROM pg_extension')) {
    return { rows: database.pgvectorVersion ? [{ extversion: database.pgvectorVersion }] : [] };
  }
  if (text.includes('1 - (embedding <=> $1) as score')) return { rows: database.searchRows };
  return { rows: [] };
}

vi.mock('pg', () => {
  class Pool {
    query = poolQuery;
    connect = async () => ({ query: clientQuery, release });
    end = async () => undefined;
  }
  return { default: { Pool } };
});

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const poolStatements = () => poolQuery.mock.calls.map(([text]) => normalize(text));
const clientStatements = () => clientQuery.mock.calls.map(([text]) => normalize(text));

function nodeRow(id: string, score: number): Record<string, unknown> {
  return {
    id,
    agent_id: 'agent',
    type: 'person',
    name: id,
    aliases: [],
    description: null,
    properties: {},
    embedding: '[1,0]',
    confidence: 1,
    source: 'user',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    last_accessed_at: '2026-01-01T00:00:00.000Z',
    access_count: 0,
    metadata: {},
    score,
  };
}

describe('PostgresGraphAdapter against pgvector', () => {
  let adapter: PostgresGraphAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    database.existingIndex = null;
    database.pgvectorVersion = '0.8.5';
    database.searchRows = [];
    poolQuery.mockImplementation(async (text) => answer(text));
    clientQuery.mockImplementation(async (text) => answer(text));
    adapter = new PostgresGraphAdapter({
      connectionString: 'postgresql://localhost:5432/test',
      schema: 'kg',
      vectorDimensions: 2,
    });
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  it('indexes node embeddings with HNSW, which keeps full recall on a table indexed while empty', async () => {
    const connected = await adapter.connect();

    expect(connected.success).toBe(true);
    expect(poolStatements()).toContain(
      'CREATE INDEX IF NOT EXISTS idx_graph_nodes_embedding ON kg.graph_nodes USING hnsw (embedding vector_cosine_ops)'
    );
    expect(poolStatements().some((text) => /ivfflat/i.test(text))).toBe(false);
  });

  it('replaces the IVFFlat index earlier versions built', async () => {
    database.existingIndex =
      "CREATE INDEX idx_graph_nodes_embedding ON kg.graph_nodes USING ivfflat (embedding vector_cosine_ops) WITH (lists='100')";

    await adapter.connect();

    const statements = poolStatements();
    const drop = statements.indexOf('DROP INDEX IF EXISTS kg.idx_graph_nodes_embedding');
    const create = statements.findIndex((text) => text.includes('USING hnsw'));
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(drop);
  });

  it('keeps an HNSW index that already exists', async () => {
    database.existingIndex =
      'CREATE INDEX idx_graph_nodes_embedding ON kg.graph_nodes USING hnsw (embedding vector_cosine_ops)';

    await adapter.connect();

    expect(poolStatements().some((text) => /DROP INDEX|USING hnsw/.test(text))).toBe(false);
  });

  it('sizes the HNSW candidate list to the limit inside one transaction', async () => {
    await adapter.connect();
    database.searchRows = [nodeRow('b', 0.9), nodeRow('a', 0.9), nodeRow('c', 0.5)];

    const result = await adapter.searchNodesSemantic({
      agentId: 'agent',
      vector: [1, 0],
      limit: 60,
      threshold: 0.1,
      entityTypes: ['person'],
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.map((node) => node.id)).toEqual(['b', 'a', 'c']);

    const statements = clientStatements();
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    const settings = clientQuery.mock.calls[1];
    expect(normalize(settings[0])).toBe(
      "SELECT set_config('hnsw.ef_search', $1, true), set_config('hnsw.iterative_scan', 'strict_order', true)"
    );
    expect(settings[1]).toEqual(['60']);

    const [search, params] = clientQuery.mock.calls[2];
    expect(normalize(search)).toMatch(
      /ORDER BY embedding <=> \$1 LIMIT \$5 \) nearest ORDER BY score DESC, id LIMIT \$6$/
    );
    expect(params).toEqual(['[1,0]', 'agent', 0.1, ['person'], 60, 60]);
    expect(release).toHaveBeenCalledWith(false);
  });

  it('fetches at least the default candidate list so a small limit is a prefix of a large one', async () => {
    database.pgvectorVersion = '0.7.4';
    await adapter.connect();

    await adapter.searchNodesSemantic({ agentId: 'agent', vector: [1, 0], limit: 3 });

    const [settingsSql, settingsParams] = clientQuery.mock.calls[1];
    expect(normalize(settingsSql)).toBe("SELECT set_config('hnsw.ef_search', $1, true)");
    expect(settingsParams).toEqual(['40']);
    expect(clientQuery.mock.calls[2][1]).toEqual(['[1,0]', 'agent', 0.7, 40, 3]);
  });

  it('rolls back and reports a failed search', async () => {
    await adapter.connect();
    clientQuery.mockImplementation(async (text) => {
      if (text.includes('as score'))
        throw new Error('canceling statement due to statement timeout');
      return answer(text);
    });

    const result = await adapter.searchNodesSemantic({ agentId: 'agent', vector: [1, 0] });

    expect(result).toEqual({
      success: false,
      error: 'canceling statement due to statement timeout',
    });
    expect(clientStatements()).toContain('ROLLBACK');
    expect(release).toHaveBeenCalledWith(false);
  });

  describe('evidence', () => {
    const evidence: Evidence[] = [
      { entryId: 'entry_1', quote: 'Alice manages the Berlin team' },
      { fileRange: { path: 'teams.md', start: 5, end: 7 }, quote: 'Berlin' },
    ];

    function edgeRow(stored: Evidence[] | null): Record<string, unknown> {
      return {
        id: 'edge_1',
        agent_id: 'agent',
        source_node_id: 'a',
        target_node_id: 'b',
        type: 'related_to',
        label: null,
        weight: 1,
        bidirectional: false,
        properties: {},
        confidence: 1,
        source: 'user',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        valid_from: null,
        valid_until: null,
        metadata: {},
        evidence: stored,
      };
    }

    function sent(fragment: string): { text: string; values: unknown[] } {
      const call = poolQuery.mock.calls.find(([text]) => text.includes(fragment));
      if (!call) throw new Error(`No query containing ${fragment}`);
      return { text: call[0], values: call[1] ?? [] };
    }

    function answerWith(fragment: string, rows: Record<string, unknown>[]): void {
      poolQuery.mockImplementation(async (text) =>
        text.includes(fragment) ? { rows } : answer(text)
      );
    }

    const node = {
      agentId: 'agent',
      type: 'person' as const,
      name: 'Alice',
      aliases: [],
      properties: {},
      confidence: 1,
      source: 'user' as const,
    };
    const edge = {
      agentId: 'agent',
      sourceNodeId: 'a',
      targetNodeId: 'b',
      type: 'related_to' as const,
      weight: 1,
      bidirectional: false,
      properties: {},
      confidence: 1,
      source: 'user' as const,
    };

    it('adds the evidence column to new and existing tables', async () => {
      await adapter.connect();

      const statements = poolStatements();
      for (const table of ['graph_nodes', 'graph_edges']) {
        expect(
          statements.some((text) =>
            new RegExp(`CREATE TABLE IF NOT EXISTS kg\\.${table} \\(.*evidence JSONB`).test(text)
          )
        ).toBe(true);
        expect(statements).toContain(
          `ALTER TABLE kg.${table} ADD COLUMN IF NOT EXISTS evidence JSONB`
        );
      }
    });

    it('sends evidence as JSON text and NULL for items without it', async () => {
      await adapter.connect();

      await adapter.addNode({ ...node, evidence });
      await adapter.addEdge({ ...edge, evidence });
      const plainNode = await adapter.addNode(node);
      const plainEdge = await adapter.addEdge(edge);

      const nodeInserts = poolQuery.mock.calls.filter(([text]) =>
        text.includes('INSERT INTO kg.graph_nodes')
      );
      const edgeInserts = poolQuery.mock.calls.filter(([text]) =>
        text.includes('INSERT INTO kg.graph_edges')
      );
      expect(nodeInserts[0][0]).toContain('$13::jsonb');
      expect(JSON.parse(nodeInserts[0][1]?.[12] as string)).toEqual(evidence);
      expect(nodeInserts[1][1]?.[12]).toBeNull();
      expect(edgeInserts[0][0]).toContain('$16::jsonb');
      expect(JSON.parse(edgeInserts[0][1]?.[15] as string)).toEqual(evidence);
      expect(edgeInserts[1][1]?.[15]).toBeNull();
      expect(plainNode.success && plainNode.data).not.toHaveProperty('evidence');
      expect(plainEdge.success && plainEdge.data).not.toHaveProperty('evidence');
    });

    it('reads evidence back and leaves it out of rows without it', async () => {
      await adapter.connect();
      answerWith('SELECT * FROM kg.graph_edges', [edgeRow(evidence), edgeRow(null)]);

      const edges = await adapter.getEdgesBetween('a', 'b');

      expect(edges.success).toBe(true);
      if (!edges.success) return;
      expect(edges.data[0].evidence).toEqual(evidence);
      expect(edges.data[1]).not.toHaveProperty('evidence');

      answerWith('SET last_accessed_at = NOW()', [{ ...nodeRow('a', 1), evidence }]);
      const found = await adapter.getNode('a');
      expect(found.success && found.data?.evidence).toEqual(evidence);

      answerWith('SET last_accessed_at = NOW()', [{ ...nodeRow('b', 1), evidence: null }]);
      const plain = await adapter.getNode('b');
      expect(plain.success && plain.data).not.toHaveProperty('evidence');
    });

    it('reads the evidence of neighbors and of the edges to them', async () => {
      await adapter.connect();
      answerWith('e.evidence as e_evidence', [
        {
          e_id: 'edge_1',
          e_agent_id: 'agent',
          source_node_id: 'a',
          target_node_id: 'b',
          e_type: 'related_to',
          e_weight: 1,
          e_bidirectional: false,
          e_properties: {},
          e_confidence: 1,
          e_source: 'user',
          e_created_at: '2026-01-01T00:00:00.000Z',
          e_updated_at: '2026-01-01T00:00:00.000Z',
          e_metadata: {},
          e_evidence: evidence.slice(1),
          n_id: 'b',
          n_agent_id: 'agent',
          n_type: 'person',
          n_name: 'Bob',
          n_aliases: [],
          n_properties: {},
          n_confidence: 1,
          n_source: 'user',
          n_created_at: '2026-01-01T00:00:00.000Z',
          n_updated_at: '2026-01-01T00:00:00.000Z',
          n_last_accessed_at: '2026-01-01T00:00:00.000Z',
          n_access_count: 0,
          n_metadata: {},
          n_evidence: evidence,
        },
      ]);

      const neighbors = await adapter.getNeighbors('a', 'outgoing');

      expect(neighbors.success).toBe(true);
      if (!neighbors.success) return;
      expect(neighbors.data[0].node.evidence).toEqual(evidence);
      expect(neighbors.data[0].edge.evidence).toEqual(evidence.slice(1));
    });

    it.each([
      [
        'updateNode',
        (target: PostgresGraphAdapter) => target.updateNode('a', { evidence }),
        'UPDATE kg.graph_nodes SET',
        () => ({ ...nodeRow('a', 1), evidence }),
      ],
      [
        'updateEdge',
        (target: PostgresGraphAdapter) => target.updateEdge('edge_1', { evidence }),
        'UPDATE kg.graph_edges SET',
        () => edgeRow(evidence),
      ],
    ])('%s replaces the evidence', async (_name, update, fragment, stored) => {
      await adapter.connect();
      answerWith(fragment, [stored()]);

      const result = await update(adapter);

      const { text, values } = sent(fragment);
      expect(text).toContain('evidence = $1::jsonb');
      expect(JSON.parse(values[0] as string)).toEqual(evidence);
      expect(result.success && result.data.evidence).toEqual(evidence);
    });

    describe('mergeNodes', () => {
      const extra: Evidence = { toolCallId: 'call_4', quote: 'Berlin team' };
      const stored = new Map<string, Record<string, unknown>>();

      beforeEach(async () => {
        await adapter.connect();
        stored.clear();
        poolQuery.mockImplementation(async (text, values = []) => {
          if (text.includes('SET last_accessed_at = NOW()')) {
            const row = stored.get(values[0] as string);
            return { rows: row ? [row] : [] };
          }
          if (text.includes('UPDATE kg.graph_nodes SET updated_at = NOW()')) {
            const id = values.at(-1) as string;
            const row = { ...stored.get(id) };
            const position = /evidence = \$(\d+)::jsonb/.exec(text)?.[1];
            if (position) row.evidence = JSON.parse(values[Number(position) - 1] as string);
            stored.set(id, row);
            return { rows: [row] };
          }
          return answer(text);
        });
      });

      const put = (id: string, own?: Evidence[]) =>
        stored.set(id, { ...nodeRow(id, 1), ...(own ? { evidence: own } : {}) });

      it('gives the target its own evidence and that of every source once, in order', async () => {
        put('t', [evidence[0]]);
        put('a', [evidence[1], evidence[0]]);
        put('b');
        put('c', [{ ...evidence[1] }, extra]);

        const result = await adapter.mergeNodes('t', ['a', 'b', 'c']);

        expect(result.success && result.data.evidence).toEqual([evidence[0], evidence[1], extra]);
      });

      it('leaves evidence absent when no merged node has any', async () => {
        put('t');
        put('a');

        const result = await adapter.mergeNodes('t', ['a']);

        expect(result.success).toBe(true);
        expect(result.success && result.data).not.toHaveProperty('evidence');
        expect(poolStatements().some((text) => text.includes('evidence = $'))).toBe(false);
      });
    });

    it('leaves evidence alone when an update does not carry it', async () => {
      await adapter.connect();
      answerWith('UPDATE kg.graph_nodes SET', [nodeRow('a', 1)]);

      await adapter.updateNode('a', { name: 'Alicia' });

      expect(sent('UPDATE kg.graph_nodes SET').text).not.toContain('evidence');
    });
  });
});
