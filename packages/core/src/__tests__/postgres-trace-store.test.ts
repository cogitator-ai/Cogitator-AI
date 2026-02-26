import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostgresTraceStore } from '../learning/postgres-trace-store';

const mockQuery = vi.fn();

vi.mock('pg', () => {
  const mockRelease = vi.fn();
  const mockConnect = vi.fn().mockResolvedValue({ release: mockRelease });
  const mockEnd = vi.fn().mockResolvedValue(undefined);

  class Pool {
    query = mockQuery;
    connect = mockConnect;
    end = mockEnd;
  }

  return {
    default: { Pool },
    Pool,
  };
});

describe('PostgresTraceStore', () => {
  describe('schema validation', () => {
    it('accepts valid schema names', () => {
      expect(
        () =>
          new PostgresTraceStore({
            connectionString: 'postgres://localhost/db',
            schema: 'cogitator',
          })
      ).not.toThrow();

      expect(
        () =>
          new PostgresTraceStore({
            connectionString: 'postgres://localhost/db',
            schema: '_private',
          })
      ).not.toThrow();

      expect(
        () =>
          new PostgresTraceStore({
            connectionString: 'postgres://localhost/db',
            schema: 'my_schema_v2',
          })
      ).not.toThrow();
    });

    it('uses default schema when not provided', () => {
      expect(
        () =>
          new PostgresTraceStore({
            connectionString: 'postgres://localhost/db',
          })
      ).not.toThrow();
    });

    it('rejects SQL injection via schema name', () => {
      expect(
        () =>
          new PostgresTraceStore({
            connectionString: 'postgres://localhost/db',
            schema: 'public; DROP TABLE users--',
          })
      ).toThrow('Invalid schema name');
    });

    it('rejects schema with spaces', () => {
      expect(
        () =>
          new PostgresTraceStore({
            connectionString: 'postgres://localhost/db',
            schema: 'my schema',
          })
      ).toThrow('Invalid schema name');
    });

    it('rejects schema starting with number', () => {
      expect(
        () =>
          new PostgresTraceStore({
            connectionString: 'postgres://localhost/db',
            schema: '123abc',
          })
      ).toThrow('Invalid schema name');
    });

    it('rejects schema with special characters', () => {
      expect(
        () =>
          new PostgresTraceStore({
            connectionString: 'postgres://localhost/db',
            schema: 'schema$name',
          })
      ).toThrow('Invalid schema name');
    });

    it('rejects empty schema', () => {
      expect(
        () =>
          new PostgresTraceStore({
            connectionString: 'postgres://localhost/db',
            schema: '',
          })
      ).toThrow('Invalid schema name');
    });
  });

  describe('pruneTraces', () => {
    let store: PostgresTraceStore;

    beforeEach(async () => {
      mockQuery.mockReset();
      mockQuery.mockResolvedValue({ rows: [] });
      store = new PostgresTraceStore({ connectionString: 'postgres://localhost/db' });
      await store.connect();
      mockQuery.mockClear();
    });

    it('deletes oldest traces by keeping newest N via DESC + OFFSET', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 5 });

      await store.pruneTraces('agent-1', 100);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain('ORDER BY created_at DESC');
      expect(sql).toContain('OFFSET');
      const params = mockQuery.mock.calls[0][1] as unknown[];
      expect(params).toEqual(['agent-1', 100]);
    });

    it('preserves demo traces during pruning', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      await store.pruneTraces('agent-1', 50);

      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain('is_demo = FALSE');
    });
  });

  describe('update with empty fields', () => {
    let store: PostgresTraceStore;

    beforeEach(async () => {
      mockQuery.mockReset();
      mockQuery.mockResolvedValue({ rows: [] });
      store = new PostgresTraceStore({ connectionString: 'postgres://localhost/db' });
      await store.connect();
      mockQuery.mockClear();
    });

    it('returns existing test without SQL when no fields to update', async () => {
      const existingTest = {
        id: 'abtest_123',
        agent_id: 'agent-1',
        name: 'test',
        status: 'running',
        control_instructions: 'a',
        treatment_instructions: 'b',
        treatment_allocation: 0.5,
        min_sample_size: 100,
        max_duration: '3600000',
        confidence_level: 0.95,
        metric_to_optimize: 'score',
        control_results: {
          sampleSize: 0,
          successRate: 0,
          avgScore: 0,
          avgLatency: 0,
          totalCost: 0,
          scores: [],
        },
        treatment_results: {
          sampleSize: 0,
          successRate: 0,
          avgScore: 0,
          avgLatency: 0,
          totalCost: 0,
          scores: [],
        },
        created_at: '2024-01-01T00:00:00Z',
        started_at: null,
        completed_at: null,
      };
      mockQuery.mockResolvedValueOnce({ rows: [existingTest] });

      const result = await store.update('abtest_123', {});

      const updateCalls = mockQuery.mock.calls.filter((call) => {
        const sql = call[0] as string;
        return sql.startsWith('UPDATE');
      });
      expect(updateCalls).toHaveLength(0);
      expect(result).toHaveProperty('id', 'abtest_123');
    });
  });

  describe('updateMetrics with empty fields', () => {
    let store: PostgresTraceStore;

    beforeEach(async () => {
      mockQuery.mockReset();
      mockQuery.mockResolvedValue({ rows: [] });
      store = new PostgresTraceStore({ connectionString: 'postgres://localhost/db' });
      await store.connect();
      mockQuery.mockClear();
    });

    it('returns early without executing SQL when no metrics provided', async () => {
      await store.updateMetrics('ver_123', {});

      expect(mockQuery).not.toHaveBeenCalled();
    });
  });
});
