import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
});
