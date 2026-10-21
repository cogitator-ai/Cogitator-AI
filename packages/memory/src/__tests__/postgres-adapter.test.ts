import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PostgresAdapter } from '../adapters/postgres';
import type {
  Evidence,
  MemoryEntity,
  MemoryItem,
  Message,
  ToolCall,
  ToolResult,
} from '@cogitator-ai/types';

/** How node-pg turns a JS parameter into the text it sends to the server. */
const { prepareValue } = createRequire(import.meta.url)('pg/lib/utils.js') as {
  prepareValue(value: unknown): unknown;
};

type QueryResult = { rows: Record<string, unknown>[] };

const mockPool = {
  query: vi.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>(),
  connect: vi.fn(),
  end: vi.fn().mockResolvedValue(undefined),
};

const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK)\b|set_config\(/;

const mockPoolClient = {
  query: vi.fn(async (sql: string, params?: unknown[]): Promise<QueryResult> =>
    TRANSACTION_CONTROL.test(sql) ? { rows: [] } : mockPool.query(sql, params)
  ),
  release: vi.fn(),
};
mockPool.connect.mockResolvedValue(mockPoolClient);

/** The SQL and the parameters, as node-pg serializes them, of the first query containing `fragment`. */
function sentToPostgres(fragment: string): { sql: string; params: unknown[] } {
  const call = mockPool.query.mock.calls.find(([sql]) => sql.includes(fragment));
  if (!call) throw new Error(`No query containing ${fragment}`);
  const [sql, params = []] = call;
  return { sql, params: params.map((param) => prepareValue(param)) };
}

/** Parses a JSONB parameter the way Postgres would, failing on anything that is not JSON text. */
function asJsonb(param: unknown): unknown {
  if (param === null) return null;
  if (typeof param !== 'string') throw new Error(`JSONB parameter sent as ${typeof param}`);
  return JSON.parse(param);
}

/** What a database with pgvector answers to the adapter's schema probes. */
/**
 * Rows a working database answers with: pgvector installed, a thread with no entries yet for a
 * new entry, the seq of an inserted entry, and the entry a delete looks up
 */
function withPgvector(sql: string): QueryResult | undefined {
  if (sql.includes("to_regtype('vector')")) return { rows: [{ available: true }] };
  if (sql.includes('SELECT active_leaf_id FROM')) return { rows: [{ active_leaf_id: null }] };
  if (sql.includes('RETURNING seq')) return { rows: [{ seq: 1 }] };
  if (sql.includes('SELECT thread_id, parent_id FROM') || sql.includes('SELECT thread_id FROM')) {
    return { rows: [{ thread_id: 'thread_123', parent_id: null }] };
  }
  return undefined;
}

vi.mock('pg', () => {
  class Pool {
    query = mockPool.query;
    connect = mockPool.connect;
    end = mockPool.end;
  }
  return {
    default: { Pool },
    Pool,
  };
});

describe('PostgresAdapter', () => {
  let adapter: PostgresAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockPool.query.mockImplementation(async (sql: string) => withPgvector(sql) ?? { rows: [] });
    adapter = new PostgresAdapter({
      provider: 'postgres',
      connectionString: 'postgresql://localhost:5432/test',
    });
    await adapter.connect();
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  describe('connect/disconnect', () => {
    it('connects and initializes schema', async () => {
      const newAdapter = new PostgresAdapter({
        provider: 'postgres',
        connectionString: 'postgresql://localhost:5432/test',
      });

      const result = await newAdapter.connect();

      expect(result.success).toBe(true);
      expect(mockPool.query.mock.calls.map(([sql]) => sql)).toContain(
        'CREATE SCHEMA IF NOT EXISTS cogitator'
      );
    });

    it('uses custom schema name', async () => {
      vi.clearAllMocks();
      mockPool.query.mockImplementation(async (sql: string) => withPgvector(sql) ?? { rows: [] });

      const newAdapter = new PostgresAdapter({
        provider: 'postgres',
        connectionString: 'postgresql://localhost:5432/test',
        schema: 'custom_schema',
      });

      await newAdapter.connect();

      expect(mockPool.query.mock.calls.map(([sql]) => sql)).toContain(
        'CREATE SCHEMA IF NOT EXISTS custom_schema'
      );
    });

    it('disconnects and closes pool', async () => {
      await adapter.disconnect();

      expect(mockPool.end).toHaveBeenCalled();
    });
  });

  describe('thread operations', () => {
    it('creates a thread', async () => {
      mockPool.query.mockImplementationOnce(async (_sql: string, params: unknown[] = []) => ({
        rows: [
          {
            id: params[0],
            agent_id: params[1],
            metadata: JSON.parse(String(params[2])),
            created_at: params[3],
            updated_at: params[3],
          },
        ],
      }));

      const result = await adapter.createThread('agent1', { foo: 'bar' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toMatch(/^thread_/);
        expect(result.data.agentId).toBe('agent1');
        expect(result.data.metadata).toEqual({ foo: 'bar' });
      }
    });

    it('gets a thread', async () => {
      const now = new Date().toISOString();
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'thread_123',
            agent_id: 'agent1',
            metadata: { key: 'value' },
            created_at: now,
            updated_at: now,
          },
        ],
      });

      const result = await adapter.getThread('thread_123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.id).toBe('thread_123');
        expect(result.data?.agentId).toBe('agent1');
        expect(result.data?.createdAt).toBeInstanceOf(Date);
      }
    });

    it('returns null for non-existent thread', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await adapter.getThread('nonexistent');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeNull();
      }
    });

    it('updates thread metadata', async () => {
      const now = new Date().toISOString();
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'thread_123',
            agent_id: 'agent1',
            metadata: { a: 1, b: 2 },
            created_at: now,
            updated_at: now,
          },
        ],
      });

      const result = await adapter.updateThread('thread_123', { b: 2 });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.metadata).toEqual({ a: 1, b: 2 });
      }
    });

    it('returns error for updating non-existent thread', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await adapter.updateThread('nonexistent', {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('not found');
      }
    });

    it('deletes thread', async () => {
      const result = await adapter.deleteThread('thread_123');

      expect(result.success).toBe(true);
      expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM'), [
        'thread_123',
      ]);
    });
  });

  describe('listThreads', () => {
    it('filters by agent, metadata containment and update time, one past the page', async () => {
      const updatedAfter = new Date('2026-01-01T00:00:00.000Z');

      const result = await adapter.listThreads({
        agentId: 'agent1',
        metadata: { userId: 'u1', archived: false },
        updatedAfter,
        limit: 10,
      });

      expect(result.success).toBe(true);
      const { sql, params } = sentToPostgres('ORDER BY date_trunc');
      expect(sql).toContain('agent_id = $1');
      expect(sql).toContain('metadata @> $2::jsonb');
      expect(sql).toContain('>= ($3::timestamptz AT TIME ZONE');
      expect(sql).toMatch(/DESC, id COLLATE "C" DESC\s+LIMIT \$4/);
      expect(asJsonb(params[1])).toEqual({ userId: 'u1', archived: false });
      expect(params[2]).toBe(updatedAfter.toISOString());
      expect(params[3]).toBe('11');
    });

    it('hands out a cursor that continues after the last thread at millisecond precision', async () => {
      const at = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
      const row = (id: string, ms: number) => ({
        id,
        agent_id: 'agent1',
        metadata: {},
        created_at: at(ms),
        updated_at: at(ms),
      });
      mockPool.query.mockResolvedValueOnce({ rows: [row('b', 2), row('a', 1)] });

      const first = await adapter.listThreads({ agentId: 'agent1', limit: 1 });

      expect(first.success).toBe(true);
      if (!first.success || !first.data.nextCursor) throw new Error('expected a next page');
      expect(first.data.threads.map((thread) => thread.id)).toEqual(['b']);

      mockPool.query.mockClear();
      await adapter.listThreads({ agentId: 'agent1', limit: 1, cursor: first.data.nextCursor });

      const { sql, params } = sentToPostgres('ORDER BY date_trunc');
      expect(sql).toContain(
        `(date_trunc('milliseconds', updated_at AT TIME ZONE 'UTC'), id COLLATE "C") < ` +
          `($2::timestamptz AT TIME ZONE 'UTC', $3)`
      );
      expect(params.slice(1)).toEqual([at(2), 'b', '2']);
    });

    it('refuses a bad page size or cursor without querying', async () => {
      const queries = mockPool.query.mock.calls.length;

      expect((await adapter.listThreads({ limit: 0 })).success).toBe(false);
      expect((await adapter.listThreads({ cursor: 'nope' })).success).toBe(false);
      expect(mockPool.query.mock.calls.length).toBe(queries);
    });

    it('creates an index that serves the listing order', () => {
      expect(sentToPostgres('idx_threads_agent_updated').sql).toContain(
        `agent_id, (date_trunc('milliseconds', updated_at AT TIME ZONE 'UTC')), (id COLLATE "C")`
      );
    });
  });

  describe('entry operations', () => {
    it('adds an entry', async () => {
      const message: Message = { role: 'user', content: 'Hello' };
      const result = await adapter.addEntry({
        threadId: 'thread_123',
        message,
        tokenCount: 10,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toMatch(/^entry_/);
        expect(result.data.message).toEqual(message);
      }
    });

    it('gets entries for thread', async () => {
      const now = new Date().toISOString();
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'entry_123',
            thread_id: 'thread_123',
            message: { role: 'user', content: 'Hello' },
            tool_calls: null,
            tool_results: null,
            token_count: 10,
            metadata: {},
            created_at: now,
          },
        ],
      });

      const result = await adapter.getEntries({ threadId: 'thread_123' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].id).toBe('entry_123');
      }
    });

    it('gets entries with time range filter', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await adapter.getEntries({
        threadId: 'thread_123',
        after: new Date('2024-01-01'),
        before: new Date('2024-12-31'),
      });

      const lastCall = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
      expect(lastCall[0]).toContain('created_at <');
      expect(lastCall[0]).toContain('created_at >');
    });

    it('gets entries with limit', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await adapter.getEntries({ threadId: 'thread_123', limit: 5 });

      const lastCall = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
      expect(lastCall[0]).toContain('LIMIT');
      expect(lastCall[1]).toContain(5);
    });

    it('breaks ties of creation time by insertion order', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await adapter.getEntries({ threadId: 'thread_123', limit: 5 });

      const { sql } = sentToPostgres('FROM cogitator.entries WHERE thread_id');
      expect(sql).toContain('ORDER BY created_at DESC, seq DESC');
      expect(sql).toContain('ORDER BY created_at ASC, seq ASC');
      expect(sentToPostgres('ADD COLUMN IF NOT EXISTS seq').sql).toContain('seq BIGINT');
      expect(sentToPostgres('ALTER COLUMN seq SET DEFAULT').sql).toContain('nextval(');
      expect(sentToPostgres('CREATE SEQUENCE IF NOT EXISTS').sql).toContain('entries_seq');
    });

    it('refuses a limit that is not a whole number of 0 or more', async () => {
      const queries = mockPool.query.mock.calls.length;

      expect((await adapter.getEntries({ threadId: 'thread_123', limit: -1 })).success).toBe(false);
      expect((await adapter.getEntries({ threadId: 'thread_123', limit: 1.5 })).success).toBe(
        false
      );
      expect(mockPool.query.mock.calls.length).toBe(queries);
    });

    it('leaves out columns that hold NULL instead of returning null', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'entry_123',
            thread_id: 'thread_123',
            message: { role: 'user', content: 'Hello' },
            tool_calls: null,
            tool_results: null,
            token_count: 10,
            metadata: null,
            created_at: new Date().toISOString(),
          },
        ],
      });

      const result = await adapter.getEntries({ threadId: 'thread_123', includeToolCalls: true });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(Object.keys(result.data[0]).sort()).toEqual(
          [
            'createdAt',
            'formatVersion',
            'id',
            'message',
            'parentId',
            'threadId',
            'tokenCount',
            'type',
          ].sort()
        );
      }
    });

    it('gets single entry', async () => {
      const now = new Date().toISOString();
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'entry_123',
            thread_id: 'thread_123',
            message: { role: 'user', content: 'Hello' },
            tool_calls: null,
            tool_results: null,
            token_count: 10,
            metadata: {},
            created_at: now,
          },
        ],
      });

      const result = await adapter.getEntry('entry_123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.id).toBe('entry_123');
      }
    });

    it('deletes entry', async () => {
      const result = await adapter.deleteEntry('entry_123');

      expect(result.success).toBe(true);
      expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM'), [
        'entry_123',
      ]);
    });

    it('clears thread entries', async () => {
      const result = await adapter.clearThread('thread_123');

      expect(result.success).toBe(true);
      expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM'), [
        'thread_123',
      ]);
    });
  });

  describe('memory items', () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
    const full: MemoryItem = {
      id: 'mem_1',
      kind: 'preference',
      content: 'Ana prefers window seats',
      subject: 'Ana',
      entityId: 'ent_1',
      attribute: 'seat',
      value: 'window',
      slot: 'ent_1:seat',
      status: 'active',
      trust: 'user',
      confidence: 0.9,
      scope: { agentId: 'agent1', userId: 'u1' },
      evidence: [{ entryId: 'e1', quote: 'window seat please' }],
      verified: true,
      saidAt: at(1),
      sessionAt: at(2),
      about: { text: 'last Friday', start: at(3), end: at(4), precision: 'day' },
      validFrom: at(5),
      validTo: at(6),
      recordedAt: at(7),
      expiredAt: at(8),
      supersedes: ['mem_0'],
      metadata: { note: 'x' },
    };

    it('creates the item and entity tables with their indexes', () => {
      const statements = mockPool.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' '));
      expect(
        statements.some((sql) =>
          /CREATE TABLE IF NOT EXISTS cogitator\.memory_items \(.*item JSONB NOT NULL/.test(sql)
        )
      ).toBe(true);
      expect(statements).toContain(
        'CREATE INDEX IF NOT EXISTS idx_memory_items_slot ON cogitator.memory_items(agent_id, slot)'
      );
      expect(statements).toContain(
        'CREATE INDEX IF NOT EXISTS idx_memory_items_entity ON cogitator.memory_items(agent_id, entity_id)'
      );
      expect(statements).toContain(
        'CREATE INDEX IF NOT EXISTS idx_memory_items_user ON cogitator.memory_items(agent_id, user_id)'
      );
      expect(
        statements.some((sql) =>
          /memory_items \(.*user_id TEXT, project_id TEXT, thread_id TEXT,/.test(sql)
        )
      ).toBe(true);
      expect(sentToPostgres('idx_memory_items_recorded').sql).toContain(
        'agent_id, recorded_at, (id COLLATE "C")'
      );
      expect(statements).toContain(
        'CREATE INDEX IF NOT EXISTS idx_memory_entities_names ON cogitator.memory_entities USING GIN (names)'
      );
    });

    it('upserts an item with its filtered fields in columns and the whole item as JSON', async () => {
      const result = await adapter.putItem(full);

      const { sql, params } = sentToPostgres('INSERT INTO cogitator.memory_items');
      expect(sql).toContain('ON CONFLICT (id) DO UPDATE SET');
      expect(params.slice(0, 6)).toEqual([
        'mem_1',
        'agent1',
        'preference',
        'active',
        'ent_1:seat',
        'ent_1',
      ]);
      expect(params.slice(6, 9)).toEqual(['u1', null, null]);
      expect(new Date(String(params[9]))).toEqual(full.recordedAt);
      expect(new Date(String(params[10]))).toEqual(full.expiredAt);
      expect(asJsonb(params[11])).toEqual(JSON.parse(JSON.stringify(full)));
      expect(result).toEqual({ success: true, data: full });
    });

    it('reads an item back with its dates as dates and no field it never had', async () => {
      const bare: MemoryItem = {
        ...full,
        id: 'mem_2',
        about: { precision: 'approximate' },
      };
      for (const field of ['subject', 'entityId', 'validTo', 'expiredAt', 'supersedes'] as const) {
        delete bare[field];
      }
      mockPool.query.mockResolvedValueOnce({ rows: [{ item: JSON.parse(JSON.stringify(full)) }] });
      mockPool.query.mockResolvedValueOnce({ rows: [{ item: JSON.parse(JSON.stringify(bare)) }] });

      const read = await adapter.getItem('mem_1');
      const readBare = await adapter.getItem('mem_2');

      expect(read).toEqual({ success: true, data: full });
      expect(read.success && read.data?.about?.start).toBeInstanceOf(Date);
      expect(readBare).toEqual({ success: true, data: bare });
      expect(readBare.success && readBare.data).not.toHaveProperty('validTo');
    });

    it('finds items by every filter, oldest recorded first, without expired ones by default', async () => {
      await adapter.findItems({
        agentId: 'agent1',
        ids: ['mem_1'],
        slots: ['s'],
        entityIds: ['ent_1'],
        kinds: ['fact'],
        statuses: ['active'],
      });

      const { sql, params } = sentToPostgres(
        'SELECT item FROM cogitator.memory_items WHERE agent_id'
      );
      expect(sql.replace(/\s+/g, ' ')).toContain(
        'agent_id = $1 AND id = ANY($2::text[]) AND slot = ANY($3::text[]) AND ' +
          'entity_id = ANY($4::text[]) AND kind = ANY($5::text[]) AND status = ANY($6::text[]) ' +
          'AND (expired_at IS NULL OR expired_at > NOW()) ORDER BY recorded_at, id COLLATE "C"'
      );
      expect(params[0]).toBe('agent1');
    });

    it('finds items a scope sees: of no user, project or thread, or of the same one', async () => {
      await adapter.findItems({
        agentId: 'agent1',
        visibleTo: { agentId: 'agent1', userId: 'u1', threadId: 't1' },
      });

      const { sql, params } = sentToPostgres(
        'SELECT item FROM cogitator.memory_items WHERE agent_id'
      );
      expect(sql.replace(/\s+/g, ' ')).toContain(
        'agent_id = $1 AND (user_id IS NULL OR user_id = $2) AND project_id IS NULL AND ' +
          '(thread_id IS NULL OR thread_id = $3) AND (expired_at IS NULL'
      );
      expect(params).toEqual(['agent1', 'u1', 't1']);
    });

    it('finds items of exactly a scope', async () => {
      await adapter.findItems({
        agentId: 'agent1',
        statuses: ['active'],
        scope: { agentId: 'agent1', projectId: 'p1' },
      });

      const { sql, params } = sentToPostgres(
        'SELECT item FROM cogitator.memory_items WHERE agent_id'
      );
      expect(sql.replace(/\s+/g, ' ')).toContain(
        'agent_id = $1 AND status = ANY($2::text[]) AND user_id IS NULL AND ' +
          'project_id = $3 AND thread_id IS NULL AND (expired_at IS NULL'
      );
      expect([params[0], params[2]]).toEqual(['agent1', 'p1']);
    });

    it('finds expired items when asked to', async () => {
      await adapter.findItems({ agentId: 'agent1', includeExpired: true });

      const lastCall = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
      expect(lastCall[0]).not.toContain('expired_at');
      expect(lastCall[1]).toEqual(['agent1']);
    });

    it('deletes nothing without ids and the given ids otherwise', async () => {
      const before = mockPool.query.mock.calls.length;
      await adapter.deleteItems([]);
      await adapter.deleteEntities([]);
      expect(mockPool.query.mock.calls.length).toBe(before);

      await adapter.deleteItems(['mem_1', 'mem_2']);
      const lastCall = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
      expect(lastCall[0]).toContain(
        'DELETE FROM cogitator.memory_items WHERE id = ANY($1::text[])'
      );
      expect(lastCall[1]).toEqual([['mem_1', 'mem_2']]);
    });

    it('stores every normalized name of an entity and finds entities by them', async () => {
      const entity: MemoryEntity = {
        id: 'ent_1',
        scope: { agentId: 'agent1' },
        name: 'The Eiffel Tower',
        aliases: ['Tour  Eiffel'],
        firstSeenAt: at(1),
        lastSeenAt: at(2),
      };
      await adapter.putEntity(entity);
      const { params } = sentToPostgres('INSERT INTO cogitator.memory_entities');
      expect(params[2]).toBe('{"eiffel tower","tour eiffel"}');

      mockPool.query.mockResolvedValueOnce({
        rows: [{ entity: JSON.parse(JSON.stringify(entity)) }],
      });
      const found = await adapter.findEntities({ agentId: 'agent1', names: ['eiffel tower'] });

      expect(found).toEqual({ success: true, data: [entity] });
      const lastCall = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
      expect(lastCall[0]).toContain('names && $2::text[]');
      expect(lastCall[1]).toEqual(['agent1', ['eiffel tower']]);
    });
  });

  describe('fact operations', () => {
    const created = new Date('2026-01-01T00:00:00.000Z');
    const updated = new Date('2026-01-02T00:00:00.000Z');

    /** The first item of the fact `fact_123`, as `addFact` writes it */
    const firstItem = (fields: Partial<MemoryItem> = {}): MemoryItem => ({
      id: 'fact_123',
      kind: 'fact',
      content: 'User likes coffee',
      attribute: 'preferences',
      slot: 'fact:fact_123',
      status: 'active',
      trust: 'model',
      confidence: 0.9,
      scope: { agentId: 'agent1' },
      evidence: [],
      verified: false,
      saidAt: created,
      sessionAt: created,
      validFrom: created,
      recordedAt: created,
      metadata: { source: 'chat', category: 'preferences' },
      ...fields,
    });

    const factRow = (item: MemoryItem, createdAt: Date = item.recordedAt) => ({
      item: JSON.parse(JSON.stringify(item)) as Record<string, unknown>,
      created_at: createdAt,
    });

    /** The items written, in order */
    const writtenItems = (): MemoryItem[] =>
      mockPool.query.mock.calls
        .filter(([sql]) => sql.includes('INSERT INTO cogitator.memory_items'))
        .map(([, params = []]) => asJsonb(prepareValue(params[11])) as MemoryItem);

    /**
     * Keeps the items of one fact the way the table would: writes replace by id, lookups by id
     * find one, lookups by agent filter by status and expiry
     */
    function storedFact(items: MemoryItem[]): void {
      const table = new Map(items.map((item) => [item.id, factRow(item).item]));
      mockPool.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('INSERT INTO cogitator.memory_items')) {
          const item = asJsonb(prepareValue(params[11])) as Record<string, unknown>;
          table.set(String(item.id), item);
          return { rows: [] };
        }
        if (sql.includes('FROM cogitator.memory_items WHERE id = $1')) {
          const item = table.get(String(params[0]));
          return { rows: item ? [{ item }] : [] };
        }
        if (sql.includes('FROM cogitator.memory_items WHERE agent_id')) {
          const statuses = /status = ANY\(\$(\d+)/.exec(sql);
          const wanted = statuses ? (params[Number(statuses[1]) - 1] as string[]) : undefined;
          const rows = [...table.values()]
            .filter((item) => wanted === undefined || wanted.includes(String(item.status)))
            .filter(
              (item) =>
                !sql.includes('expired_at IS NULL') ||
                !('expiredAt' in item) ||
                new Date(String(item.expiredAt)) > new Date()
            )
            .map((item) => ({ item }));
          return { rows };
        }
        return withPgvector(sql) ?? { rows: [] };
      });
    }

    it('adds a fact as the first active item of its own slot', async () => {
      const result = await adapter.addFact({
        agentId: 'agent1',
        content: 'User prefers dark mode',
        category: 'preferences',
        confidence: 0.9,
        source: 'inferred',
        metadata: { userId: 'alice' },
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.id).toMatch(/^fact_/);
      expect(result.data.content).toBe('User prefers dark mode');
      const [item] = writtenItems();
      expect(item).toMatchObject({
        id: result.data.id,
        kind: 'fact',
        content: 'User prefers dark mode',
        attribute: 'preferences',
        slot: `fact:${result.data.id}`,
        status: 'active',
        trust: 'model',
        confidence: 0.9,
        scope: { agentId: 'agent1', userId: 'alice' },
        evidence: [],
        verified: false,
        metadata: { userId: 'alice', category: 'preferences' },
      });
      expect(item?.recordedAt).toBe(result.data.createdAt.toISOString());
    });

    it.each([
      ['user', 'user'],
      ['system', 'system'],
      ['inferred', 'model'],
    ] as const)('trusts a fact from %s as %s', async (source, trust) => {
      await adapter.addFact({ agentId: 'a', content: 'c', category: 'g', confidence: 1, source });

      expect(writtenItems()[0]?.trust).toBe(trust);
    });

    it('gets facts for agent from the current items of their slots', async () => {
      const current = firstItem({
        id: 'mem_2',
        content: 'User likes tea',
        trust: 'user',
        recordedAt: updated,
        expiredAt: new Date('2099-01-01T00:00:00.000Z'),
      });
      mockPool.query.mockResolvedValueOnce({ rows: [factRow(current, created)] });

      const result = await adapter.getFacts('agent1');

      expect(result).toEqual({
        success: true,
        data: [
          {
            id: 'fact_123',
            agentId: 'agent1',
            content: 'User likes tea',
            category: 'preferences',
            confidence: 0.9,
            source: 'user',
            metadata: { source: 'chat' },
            createdAt: created,
            updatedAt: updated,
            expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          },
        ],
      });
      const { sql, params } = sentToPostgres('SELECT latest.item');
      const flat = sql.replace(/\s+/g, ' ');
      expect(flat).toContain("latest.status = 'active'");
      expect(flat).toContain("latest.slot LIKE 'fact:%'");
      expect(flat).toContain('(latest.expired_at IS NULL OR latest.expired_at > NOW())');
      expect(flat).toContain(
        "ORDER BY (latest.item->>'confidence')::float8 DESC, latest.recorded_at DESC"
      );
      expect(params).toEqual(['agent1']);
    });

    it('gets facts by category', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await adapter.getFacts('agent1', 'preferences');

      const lastCall = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
      expect(lastCall[0]).toContain("latest.item->>'attribute' = $2");
      expect(lastCall[1]).toEqual(['agent1', 'preferences']);
    });

    it('updates the content of a fact with a new item that supersedes the current one', async () => {
      storedFact([firstItem()]);

      const result = await adapter.updateFact('fact_123', {
        content: 'User likes tea',
        confidence: 0.8,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data).toMatchObject({
        id: 'fact_123',
        content: 'User likes tea',
        confidence: 0.8,
        category: 'preferences',
        source: 'inferred',
        metadata: { source: 'chat' },
        createdAt: created,
      });
      const written = writtenItems();
      const added = written.filter((item) => item?.id !== 'fact_123').at(-1);
      const closed = written.filter((item) => item?.id === 'fact_123').at(-1);
      expect(added).toMatchObject({
        content: 'User likes tea',
        slot: 'fact:fact_123',
        status: 'active',
        confidence: 0.8,
        supersedes: ['fact_123'],
      });
      expect(added?.id).not.toBe('fact_123');
      expect(closed).toMatchObject({
        id: 'fact_123',
        content: 'User likes coffee',
        status: 'superseded',
        supersededBy: added?.id,
        validTo: added?.validFrom,
      });
      expect(result.data.updatedAt.toISOString()).toBe(added?.recordedAt);
    });

    it('starts an update after the current item even when the clock has not moved', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(created);
      try {
        storedFact([firstItem()]);

        await adapter.updateFact('fact_123', { content: 'User likes tea' });

        const written = writtenItems();
        const added = written.filter((item) => item?.id !== 'fact_123').at(-1);
        const closed = written.filter((item) => item?.id === 'fact_123').at(-1);
        expect(added).toMatchObject({ content: 'User likes tea', status: 'active' });
        expect(closed).toMatchObject({ status: 'superseded', supersededBy: added?.id });
        expect(new Date(String(added?.validFrom)).getTime()).toBeGreaterThan(created.getTime());
      } finally {
        vi.useRealTimers();
      }
    });

    it('corrects the current item when an update keeps the statement', async () => {
      storedFact([firstItem()]);

      const result = await adapter.updateFact('fact_123', {
        confidence: 0.5,
        category: 'drinks',
        metadata: { userId: 'bob' },
      });

      expect(writtenItems()).toEqual([
        expect.objectContaining({
          id: 'fact_123',
          content: 'User likes coffee',
          confidence: 0.5,
          attribute: 'drinks',
          scope: { agentId: 'agent1', userId: 'bob' },
          metadata: { userId: 'bob', category: 'drinks' },
        }),
      ]);
      expect(result.success && result.data).toMatchObject({
        id: 'fact_123',
        category: 'drinks',
        metadata: { userId: 'bob' },
      });
    });

    it('moves the expiry of a fact to the item that supersedes it', async () => {
      const expiresAt = new Date('2099-01-01T00:00:00.000Z');
      storedFact([firstItem({ expiredAt: expiresAt })]);

      const result = await adapter.updateFact('fact_123', { content: 'User likes tea' });

      const written = writtenItems();
      expect(written[0]).toMatchObject({ id: 'fact_123', status: 'active' });
      expect(written[0]).not.toHaveProperty('expiredAt');
      expect(written.at(-1)).toMatchObject({
        content: 'User likes tea',
        expiredAt: expiresAt.toISOString(),
      });
      expect(result.success && result.data.expiresAt).toEqual(expiresAt);
    });

    it('returns error for updating non-existent fact', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await adapter.updateFact('nonexistent', { content: 'test' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('not found');
      }
    });

    it('does not take an item of another slot for a fact', async () => {
      storedFact([firstItem({ id: 'mem_9', slot: 'ana:city' })]);

      const result = await adapter.updateFact('mem_9', { content: 'test' });

      expect(result).toEqual({ success: false, error: 'Fact not found: mem_9' });
      expect(writtenItems()).toEqual([]);
    });

    it('deletes a fact with every item of its slot', async () => {
      storedFact([firstItem({ status: 'superseded' }), firstItem({ id: 'mem_2' })]);

      const result = await adapter.deleteFact('fact_123');

      expect(result.success).toBe(true);
      const { params } = sentToPostgres('DELETE FROM cogitator.memory_items');
      expect(params[0]).toBe('{"fact_123","mem_2"}');
    });

    it('deletes nothing for a fact that is not there', async () => {
      const result = await adapter.deleteFact('fact_missing');

      expect(result.success).toBe(true);
      expect(() => sentToPostgres('DELETE FROM cogitator.memory_items')).toThrow();
    });

    it('searches facts', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [factRow(firstItem())] });

      const result = await adapter.searchFacts('agent1', 'coffee');

      expect(result.success && result.data.map((fact) => fact.id)).toEqual(['fact_123']);
      const lastCall = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
      expect(lastCall[0]).toContain("latest.item->>'content' ILIKE $2");
      expect(lastCall[1]).toEqual(['agent1', '%coffee%']);
    });

    it('searches for wildcards as they are', async () => {
      await adapter.searchFacts('agent1', '100%_off');

      const lastCall = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
      expect(lastCall[1]).toEqual(['agent1', '%100\\%\\_off%']);
    });
  });

  describe('facts written before memory items', () => {
    async function connectWithFacts(tables: {
      facts: boolean;
      legacy: boolean;
    }): Promise<string[]> {
      vi.clearAllMocks();
      mockPool.query.mockImplementation(async (sql: string) => {
        if (sql.includes('AS facts, to_regclass')) return { rows: [tables] };
        return withPgvector(sql) ?? { rows: [] };
      });
      const migrated = new PostgresAdapter({
        provider: 'postgres',
        connectionString: 'postgresql://localhost:5432/test',
      });
      await migrated.connect();
      await migrated.disconnect();
      return mockPool.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim());
    }

    it('moves every fact into an item with its id and keeps the old table as facts_legacy', async () => {
      const statements = await connectWithFacts({ facts: true, legacy: false });

      expect(statements).toContain(
        'ALTER TABLE cogitator.facts ADD COLUMN IF NOT EXISTS evidence JSONB'
      );
      const move = statements.find((sql) => sql.startsWith('INSERT INTO cogitator.memory_items'));
      expect(move).toContain("'fact:' || id AS slot");
      expect(move).toContain(
        "CASE f.source WHEN 'user' THEN 'user' WHEN 'system' THEN 'system' ELSE 'model' END"
      );
      expect(move).toContain("'verified', jsonb_array_length(f.evidence) > 0");
      expect(move).toContain("jsonb_build_object('category', f.category)");
      expect(move).toContain(
        "CASE WHEN jsonb_typeof(metadata -> 'userId') = 'string' THEN metadata ->> 'userId' END AS user_id"
      );
      expect(move).toContain('f.slot, NULL, f.user_id, f.at');
      expect(move).toContain('FROM cogitator.facts');
      expect(move).toContain('ON CONFLICT (id) DO NOTHING');
      expect(statements).toContain('ALTER TABLE cogitator.facts RENAME TO facts_legacy');
      expect(statements.some((sql) => sql.startsWith('DROP TABLE'))).toBe(false);
    });

    it('moves facts written after an earlier move into facts_legacy too', async () => {
      const statements = await connectWithFacts({ facts: true, legacy: true });

      expect(statements.some((sql) => sql.startsWith('INSERT INTO cogitator.memory_items'))).toBe(
        true
      );
      expect(
        statements.some(
          (sql) =>
            sql.startsWith('INSERT INTO cogitator.facts_legacy') &&
            sql.endsWith('ON CONFLICT (id) DO NOTHING')
        )
      ).toBe(true);
      expect(statements).toContain('DROP TABLE cogitator.facts');
      expect(statements).not.toContain('ALTER TABLE cogitator.facts RENAME TO facts_legacy');
    });

    it('moves nothing when there is no facts table', async () => {
      const statements = await connectWithFacts({ facts: false, legacy: false });

      expect(statements.some((sql) => sql.includes('FROM cogitator.facts'))).toBe(false);
      expect(
        statements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS cogitator.facts'))
      ).toBe(false);
    });
  });

  describe('fact evidence', () => {
    const evidence: Evidence[] = [
      { entryId: 'entry_1', quote: 'I take my coffee black' },
      { toolCallId: 'call_1', fileRange: { path: 'notes.md', start: 3, end: 9 }, quote: 'black' },
    ];

    const factItem = (stored: Evidence[]): MemoryItem => ({
      id: 'fact_1',
      kind: 'fact',
      content: 'Takes coffee black',
      attribute: 'preferences',
      slot: 'fact:fact_1',
      status: 'active',
      trust: 'model',
      confidence: 0.9,
      scope: { agentId: 'agent1' },
      evidence: stored,
      verified: stored.length > 0,
      saidAt: new Date('2026-01-01T00:00:00.000Z'),
      sessionAt: new Date('2026-01-01T00:00:00.000Z'),
      recordedAt: new Date('2026-01-01T00:00:00.000Z'),
      metadata: { category: 'preferences' },
    });

    const row = (item: MemoryItem) => ({
      item: JSON.parse(JSON.stringify(item)) as Record<string, unknown>,
      created_at: item.recordedAt,
    });

    const insertedItems = () =>
      mockPool.query.mock.calls
        .filter(([sql]) => sql.includes('INSERT INTO cogitator.memory_items'))
        .map(([sql, params = []]) => ({
          sql,
          item: asJsonb(prepareValue(params[11])) as MemoryItem,
        }));

    it('stores evidence in the item, verified, and an empty list for a fact without it', async () => {
      const fact = {
        agentId: 'agent1',
        content: 'Takes coffee black',
        category: 'preferences',
        confidence: 0.9,
        source: 'inferred' as const,
      };
      await adapter.addFact({ ...fact, evidence });
      await adapter.addFact(fact);

      const [proven, bare] = insertedItems();
      expect(proven?.sql).toContain('$12::jsonb');
      expect(proven?.item).toMatchObject({ evidence, verified: true });
      expect(bare?.item).toMatchObject({ evidence: [], verified: false });
    });

    it.each([
      ['getFacts', () => adapter.getFacts('agent1')],
      ['searchFacts', () => adapter.searchFacts('agent1', 'coffee')],
    ])('%s reads evidence back and leaves it out of facts without it', async (_name, read) => {
      mockPool.query.mockResolvedValueOnce({
        rows: [row(factItem(evidence)), row(factItem([]))],
      });

      const result = await read();

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data[0].evidence).toEqual(evidence);
      expect(result.data[1]).not.toHaveProperty('evidence');
    });

    it('updates evidence and returns the stored fact with it', async () => {
      mockPool.query.mockImplementation(async (sql: string) =>
        sql.includes('FROM cogitator.memory_items')
          ? { rows: [row(factItem([]))] }
          : (withPgvector(sql) ?? { rows: [] })
      );

      const result = await adapter.updateFact('fact_1', { evidence });

      const [updated] = insertedItems();
      expect(updated?.item).toMatchObject({ id: 'fact_1', evidence, verified: true });
      expect(result.success && result.data.evidence).toEqual(evidence);
    });

    it('leaves evidence alone when an update does not carry it', async () => {
      mockPool.query.mockImplementation(async (sql: string) =>
        sql.includes('FROM cogitator.memory_items')
          ? { rows: [row(factItem(evidence))] }
          : (withPgvector(sql) ?? { rows: [] })
      );

      await adapter.updateFact('fact_1', { content: 'Takes coffee black, no sugar' });

      const written = insertedItems().map(({ item }) => item);
      expect(written[0]).toMatchObject({ content: 'Takes coffee black, no sugar', evidence });
    });
  });

  describe('embedding operations', () => {
    it('adds an embedding', async () => {
      const result = await adapter.addEmbedding({
        sourceId: 'entry_123',
        sourceType: 'message',
        vector: [0.1, 0.2, 0.3],
        content: 'Hello world',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toMatch(/^emb_/);
        expect(result.data.vector).toEqual([0.1, 0.2, 0.3]);
      }
    });

    it('searches embeddings by vector', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'emb_123',
            source_id: 'entry_123',
            source_type: 'entry',
            vector: [0.1, 0.2, 0.3],
            content: 'Test content',
            metadata: {},
            created_at: new Date().toISOString(),
            score: 0.95,
          },
        ],
      });

      const result = await adapter.search({
        vector: [0.1, 0.2, 0.3],
        limit: 10,
        threshold: 0.7,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].score).toBe(0.95);
      }
    });

    it('requires vector for search', async () => {
      const result = await adapter.search({});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('requires vector');
      }
    });

    it('filters search by source type', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await adapter.search({
        vector: [0.1, 0.2, 0.3],
        filter: { sourceType: 'fact' },
      });

      const lastCall = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
      expect(lastCall[0]).toContain('source_type = ANY(');
      expect(lastCall[1]).toContainEqual(['fact']);
    });

    it('filters search by user, letting through embeddings of no user', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await adapter.search({ vector: [0.1, 0.2, 0.3], filter: { userId: 'alice' } });

      const [sql, params] = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
      expect(sql).toMatch(/\(metadata->>'userId' = \$\d+ OR metadata->>'userId' IS NULL\)/);
      expect(params).toContain('alice');
    });

    it('deletes an embedding', async () => {
      const result = await adapter.deleteEmbedding('emb_123');

      expect(result.success).toBe(true);
    });

    it('deletes embeddings by source', async () => {
      const result = await adapter.deleteBySource('entry_123');

      expect(result.success).toBe(true);
      expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('source_id = $1'), [
        'entry_123',
      ]);
    });
  });

  describe('error handling', () => {
    it('returns error when not connected', async () => {
      const disconnectedAdapter = new PostgresAdapter({
        provider: 'postgres',
        connectionString: 'postgresql://localhost:5432/test',
      });

      const result = await disconnectedAdapter.createThread('agent1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Not connected');
      }
    });

    it.each([
      ['getThread', () => adapter.getThread('thread_1')],
      ['updateThread', () => adapter.updateThread('thread_1', { a: 1 })],
      ['getEntries', () => adapter.getEntries({ threadId: 'thread_1' })],
      ['getEntry', () => adapter.getEntry('entry_1')],
      ['getFacts', () => adapter.getFacts('agent1')],
      ['updateFact', () => adapter.updateFact('fact_1', { content: 'x' })],
    ])('%s returns a failed result when the query fails', async (_name, call) => {
      mockPool.query.mockRejectedValueOnce(new Error('connection terminated'));

      const result = await call();

      expect(result).toEqual({ success: false, error: 'connection terminated' });
    });

    it('disconnect returns a failed result when closing the pool fails', async () => {
      mockPool.end.mockRejectedValueOnce(new Error('pool already ended'));

      const result = await adapter.disconnect();

      expect(result).toEqual({ success: false, error: 'pool already ended' });
      expect((await adapter.getThread('thread_1')).success).toBe(false);
    });
  });

  describe('createThread upsert', () => {
    it('returns the stored createdAt when the thread already exists', async () => {
      const storedCreatedAt = new Date('2024-01-01T00:00:00.000Z');
      mockPool.query.mockImplementationOnce(async (_sql: string, params: unknown[] = []) => ({
        rows: [
          {
            id: params[0],
            agent_id: params[1],
            metadata: JSON.parse(String(params[2])),
            created_at: storedCreatedAt.toISOString(),
            updated_at: params[3],
          },
        ],
      }));

      const result = await adapter.createThread('agent1', { v: 2 }, 'thread_existing');

      expect(mockPool.query).toHaveBeenLastCalledWith(
        expect.stringContaining('RETURNING *'),
        expect.any(Array)
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.createdAt).toEqual(storedCreatedAt);
        expect(result.data.updatedAt.getTime()).toBeGreaterThan(storedCreatedAt.getTime());
        expect(result.data.metadata).toEqual({ v: 2 });
      }
    });
  });

  describe('JSONB columns', () => {
    const toolCalls: ToolCall[] = [
      { id: 'call_1', name: 'book_table', arguments: { venue: 'Quillon', guests: 2 } },
    ];
    const toolResults: ToolResult[] = [
      { callId: 'call_1', name: 'book_table', result: { confirmation: 'QX-5521' } },
    ];

    it('sends tool calls and tool results as JSON text, not as Postgres array literals', async () => {
      const message: Message = { role: 'assistant', content: '' };
      const result = await adapter.addEntry({
        threadId: 'thread_1',
        message,
        toolCalls,
        toolResults,
        tokenCount: 1,
        metadata: { tags: ['booking'] },
      });

      expect(result.success).toBe(true);
      const { sql, params } = sentToPostgres('INSERT INTO cogitator.entries');
      expect(sql).toMatch(/\$3::jsonb, \$4::jsonb, \$5::jsonb, \$6, \$7::jsonb/);
      expect(asJsonb(params[2])).toEqual(message);
      expect(asJsonb(params[3])).toEqual(toolCalls);
      expect(asJsonb(params[4])).toEqual(toolResults);
      expect(asJsonb(params[6])).toEqual({ tags: ['booking'] });
    });

    it('stores NULL for an entry without tool calls', async () => {
      await adapter.addEntry({
        threadId: 'thread_1',
        message: { role: 'user', content: 'Hi' },
        tokenCount: 1,
      });

      const { params } = sentToPostgres('INSERT INTO cogitator.entries');
      expect(params[3]).toBeNull();
      expect(params[4]).toBeNull();
      expect(asJsonb(params[6])).toEqual({});
    });

    it.each([
      [
        'createThread',
        () => adapter.createThread('agent1', { tags: ['a'] }),
        'INSERT INTO cogitator.threads',
        2,
      ],
      [
        'updateThread',
        () => adapter.updateThread('thread_1', { tags: ['b'] }),
        'SET metadata = COALESCE',
        1,
      ],
      [
        'addEmbedding',
        () =>
          adapter.addEmbedding({
            sourceId: 'doc_1',
            sourceType: 'document',
            vector: [0.1, 0.2],
            content: 'Doc',
            metadata: { tags: ['e'] },
          }),
        'INSERT INTO cogitator.embeddings',
        5,
      ],
    ])('%s sends metadata as JSON text cast to jsonb', async (_name, call, fragment, index) => {
      await call();

      const { sql, params } = sentToPostgres(fragment);
      expect(sql).toContain(`$${index + 1}::jsonb`);
      expect(asJsonb(params[index])).toEqual({ tags: [expect.any(String)] });
    });
    it('addFact sends the item, metadata included, as JSON text cast to jsonb', async () => {
      await adapter.addFact({
        agentId: 'agent1',
        content: 'Likes tea',
        category: 'preference',
        confidence: 1,
        source: 'user',
        metadata: { tags: ['c'] },
      });

      const { sql, params } = sentToPostgres('INSERT INTO cogitator.memory_items');
      expect(sql).toContain('$12::jsonb');
      expect(asJsonb(params[11])).toMatchObject({
        metadata: { tags: ['c'], category: 'preference' },
      });
    });
  });

  describe('vector index', () => {
    async function connectWith(
      answer: (sql: string) => QueryResult | undefined
    ): Promise<{ fresh: PostgresAdapter; queries: string[] }> {
      vi.clearAllMocks();
      mockPool.query.mockImplementation(
        async (sql: string) => answer(sql) ?? withPgvector(sql) ?? { rows: [] }
      );
      const fresh = new PostgresAdapter({
        provider: 'postgres',
        connectionString: 'postgresql://localhost:5432/test',
      });
      const result = await fresh.connect();
      expect(result.success).toBe(true);
      const queries = mockPool.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim());
      return { fresh, queries };
    }

    it('builds an HNSW cosine index, which needs no rows to be trained on', async () => {
      const { queries } = await connectWith(() => undefined);

      expect(queries).toContainEqual(
        expect.stringMatching(
          /CREATE INDEX IF NOT EXISTS idx_embeddings_vector ON cogitator\.embeddings USING hnsw \(vector vector_cosine_ops\)/
        )
      );
      expect(queries.some((sql) => /ivfflat/i.test(sql))).toBe(false);
    });

    it('replaces the ivfflat index that earlier versions built on the empty table', async () => {
      const { queries } = await connectWith((sql) =>
        sql.includes('pg_indexes')
          ? {
              rows: [
                {
                  indexdef:
                    'CREATE INDEX idx_embeddings_vector ON cogitator.embeddings USING ivfflat (vector vector_cosine_ops) WITH (lists=100)',
                },
              ],
            }
          : undefined
      );

      const drop = queries.indexOf('DROP INDEX IF EXISTS cogitator.idx_embeddings_vector');
      const create = queries.findIndex((sql) => sql.includes('USING hnsw'));
      expect(drop).toBeGreaterThan(-1);
      expect(create).toBeGreaterThan(drop);
    });

    it('keeps an HNSW index that already exists', async () => {
      const { queries } = await connectWith((sql) =>
        sql.includes('pg_indexes')
          ? {
              rows: [
                {
                  indexdef:
                    'CREATE INDEX idx_embeddings_vector ON cogitator.embeddings USING hnsw (vector vector_cosine_ops)',
                },
              ],
            }
          : undefined
      );

      expect(queries.some((sql) => sql.startsWith('DROP INDEX'))).toBe(false);
      expect(queries.some((sql) => sql.includes('USING hnsw'))).toBe(false);
    });

    it('orders equally distant rows by id across all candidates the index computes', async () => {
      await adapter.search({ vector: [0.1, 0.2], limit: 3, threshold: 0 });

      const [sql, params] = mockPool.query.mock.calls.at(-1) ?? [''];
      const flat = sql.replace(/\s+/g, ' ');
      expect(flat).toMatch(
        /ORDER BY vector <=> \$1 LIMIT \$3 \) nearest ORDER BY score DESC, id LIMIT \$4/
      );
      expect(params).toEqual(['[0.1,0.2]', 0, 40, 3]);
    });

    it('does not cap a limit above the largest HNSW candidate list', async () => {
      await adapter.search({ vector: [0.1], limit: 5000, threshold: 0 });

      const [, params] = mockPool.query.mock.calls.at(-1) ?? [''];
      expect(params?.slice(-2)).toEqual([5000, 5000]);
    });

    it.each([
      ['0.8.0', 100, true],
      ['0.7.4', 100, false],
      ['0.8.5', 3, true],
    ])(
      'with pgvector %s a search for %i rows asks the index for enough candidates',
      async (version, limit, iterative) => {
        const { fresh } = await connectWith((sql) =>
          sql.includes('pg_extension') ? { rows: [{ extversion: version }] } : undefined
        );
        mockPoolClient.query.mockClear();
        await fresh.search({ vector: [0.1, 0.2], limit, threshold: 0 });

        const sent = mockPoolClient.query.mock.calls.map(([sql, params]) => ({ sql, params }));
        const settings = sent.find(({ sql }) => sql.includes('set_config'));
        expect(sent[0]?.sql).toBe('BEGIN');
        expect(settings?.params).toEqual([String(Math.max(40, limit))]);
        expect(settings?.sql.includes("'hnsw.iterative_scan', 'strict_order'")).toBe(iterative);
        const search = sent.find(({ sql }) => sql.includes('ORDER BY vector <=> $1'));
        expect(search?.params?.slice(-2)).toEqual([Math.max(40, limit), limit]);
        expect(sent.at(-1)?.sql).toBe('COMMIT');
        expect(mockPoolClient.release).toHaveBeenCalled();
      }
    );
  });

  describe('provider', () => {
    it('returns postgres as provider', () => {
      expect(adapter.provider).toBe('postgres');
    });
  });

  describe('vector dimensions', () => {
    it('allows setting custom dimensions before connect', () => {
      const freshAdapter = new PostgresAdapter({
        provider: 'postgres',
        connectionString: 'postgresql://test:test@localhost:5432/test',
      });
      freshAdapter.setVectorDimensions(1536);
    });

    it('throws when setting dimensions after connect', () => {
      expect(() => adapter.setVectorDimensions(1536)).toThrow(
        'Cannot change vector dimensions after connecting'
      );
    });

    it('rejects invalid dimensions', () => {
      const freshAdapter = new PostgresAdapter({
        provider: 'postgres',
        connectionString: 'postgresql://test:test@localhost:5432/test',
      });
      expect(() => freshAdapter.setVectorDimensions(0)).toThrow();
      expect(() => freshAdapter.setVectorDimensions(-1)).toThrow();
      expect(() => freshAdapter.setVectorDimensions(NaN)).toThrow();
    });
  });
});
