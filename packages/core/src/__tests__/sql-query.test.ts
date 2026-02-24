import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sqlQuery } from '../tools/sql-query';

vi.mock('pg', () => {
  const mockQuery = vi.fn();
  const mockConnect = vi.fn().mockResolvedValue(undefined);
  const mockEnd = vi.fn().mockResolvedValue(undefined);

  class Client {
    query = mockQuery;
    connect = mockConnect;
    end = mockEnd;
  }

  return {
    default: { Client },
    Client,
  };
});

vi.mock('better-sqlite3', () => {
  const mockPrepare = vi.fn();
  const mockClose = vi.fn();

  class Database {
    prepare = mockPrepare;
    close = mockClose;
  }

  return { default: Database };
});

describe('sql-query tool', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('has correct metadata', () => {
    expect(sqlQuery.name).toBe('sql_query');
    expect(sqlQuery.description).toContain('SQL');
    expect(sqlQuery.category).toBe('database');
    expect(sqlQuery.tags).toContain('sql');
  });

  describe('connection handling', () => {
    it('returns error when no connection string provided', async () => {
      delete process.env.DATABASE_URL;

      const result = await sqlQuery.execute({ query: 'SELECT 1' });

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('No connection string');
    });

    it('uses DATABASE_URL env var when connectionString not provided', async () => {
      process.env.DATABASE_URL = 'postgres://user:pass@localhost/db';

      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [{ id: 1 }],
      });

      await sqlQuery.execute({ query: 'SELECT 1' });

      expect(mockInstance.connect).toHaveBeenCalled();
    });
  });

  describe('read-only mode', () => {
    it('blocks non-SELECT queries when readOnly is true (default)', async () => {
      process.env.DATABASE_URL = 'postgres://localhost/db';

      const result = await sqlQuery.execute({ query: 'DELETE FROM users' });

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('Only SELECT queries are allowed');
    });

    it('blocks INSERT when readOnly is true', async () => {
      process.env.DATABASE_URL = 'postgres://localhost/db';

      const result = await sqlQuery.execute({
        query: 'INSERT INTO users (name) VALUES ($1)',
        params: ['test'],
      });

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('Only SELECT queries');
    });

    it('blocks UPDATE when readOnly is true', async () => {
      process.env.DATABASE_URL = 'postgres://localhost/db';

      const result = await sqlQuery.execute({
        query: 'UPDATE users SET name = $1',
        params: ['test'],
      });

      expect(result).toHaveProperty('error');
    });

    it('allows SELECT queries when readOnly is true', async () => {
      process.env.DATABASE_URL = 'postgres://localhost/db';

      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [{ id: 1, name: 'test' }],
      });

      const result = await sqlQuery.execute({ query: 'SELECT * FROM users' });

      expect(result).not.toHaveProperty('error');
    });

    it('allows WITH queries (CTEs) when readOnly is true', async () => {
      process.env.DATABASE_URL = 'postgres://localhost/db';

      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [{ count: 5 }],
      });

      const result = await sqlQuery.execute({
        query:
          'WITH active AS (SELECT * FROM users WHERE active = true) SELECT COUNT(*) FROM active',
      });

      expect(result).not.toHaveProperty('error');
    });

    it('allows SHOW queries', async () => {
      process.env.DATABASE_URL = 'postgres://localhost/db';

      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [{ version: 'PostgreSQL 15.0' }],
      });

      const result = await sqlQuery.execute({ query: 'SHOW server_version' });

      expect(result).not.toHaveProperty('error');
    });

    it('allows EXPLAIN queries', async () => {
      process.env.DATABASE_URL = 'postgres://localhost/db';

      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [{ 'QUERY PLAN': 'Seq Scan on users' }],
      });

      const result = await sqlQuery.execute({ query: 'EXPLAIN SELECT * FROM users' });

      expect(result).not.toHaveProperty('error');
    });

    it('allows mutations when readOnly is false', async () => {
      process.env.DATABASE_URL = 'postgres://localhost/db';

      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [],
      });

      const result = await sqlQuery.execute({
        query: 'DELETE FROM users WHERE id = $1',
        params: [1],
        readOnly: false,
      });

      expect(result).not.toHaveProperty('error');
    });
  });

  describe('PostgreSQL queries', () => {
    beforeEach(() => {
      process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/testdb';
    });

    it('executes SELECT and returns results', async () => {
      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
      });

      const result = await sqlQuery.execute({ query: 'SELECT * FROM users' });

      expect(result).toMatchObject({
        rows: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
        rowCount: 2,
        truncated: false,
        database: 'postgres',
      });
      expect((result as { executionTime: number }).executionTime).toBeGreaterThanOrEqual(0);
    });

    it('passes query parameters', async () => {
      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [{ id: 1, name: 'Alice' }],
      });

      await sqlQuery.execute({
        query: 'SELECT * FROM users WHERE id = $1',
        params: [1],
      });

      expect(mockInstance.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM users WHERE id = $1'),
        [1]
      );
    });

    it('truncates results when exceeding maxRows', async () => {
      const { Client } = await import('pg');
      const mockInstance = new Client();

      const manyRows = Array.from({ length: 11 }, (_, i) => ({ id: i }));
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: manyRows,
      });

      const result = await sqlQuery.execute({
        query: 'SELECT * FROM big_table',
        maxRows: 10,
      });

      expect((result as { rows: unknown[] }).rows).toHaveLength(10);
      expect((result as { truncated: boolean }).truncated).toBe(true);
    });

    it('adds LIMIT to query if not present', async () => {
      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [{ id: 1 }],
      });

      await sqlQuery.execute({ query: 'SELECT * FROM users' });

      const calledQuery = (mockInstance.query as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(calledQuery).toContain('LIMIT');
    });

    it('does not add LIMIT if already present', async () => {
      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [{ id: 1 }],
      });

      await sqlQuery.execute({ query: 'SELECT * FROM users LIMIT 5' });

      const calledQuery = (mockInstance.query as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(calledQuery).toBe('SELECT * FROM users LIMIT 5');
    });

    it('handles query errors gracefully', async () => {
      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('relation "nonexistent" does not exist')
      );

      const result = await sqlQuery.execute({ query: 'SELECT * FROM nonexistent' });

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('does not exist');
      expect((result as { database: string }).database).toBe('postgres');
    });

    it('cleans up connection on success', async () => {
      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      await sqlQuery.execute({ query: 'SELECT 1' });

      expect(mockInstance.end).toHaveBeenCalled();
    });

    it('cleans up connection on error', async () => {
      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Query failed'));

      await sqlQuery.execute({ query: 'SELECT 1' });

      expect(mockInstance.end).toHaveBeenCalled();
    });
  });

  describe('SQLite queries', () => {
    it('detects SQLite from .db extension', async () => {
      const Database = (await import('better-sqlite3')).default;
      const mockDb = new Database('test.db');
      const mockStmt = { all: vi.fn().mockReturnValue([{ id: 1 }]) };
      (mockDb.prepare as ReturnType<typeof vi.fn>).mockReturnValue(mockStmt);

      const result = await sqlQuery.execute({
        query: 'SELECT * FROM users',
        connectionString: '/path/to/test.db',
      });

      expect((result as { database: string }).database).toBe('sqlite');
    });

    it('detects SQLite from .sqlite extension', async () => {
      const Database = (await import('better-sqlite3')).default;
      const mockDb = new Database('test.sqlite');
      const mockStmt = { all: vi.fn().mockReturnValue([]) };
      (mockDb.prepare as ReturnType<typeof vi.fn>).mockReturnValue(mockStmt);

      const result = await sqlQuery.execute({
        query: 'SELECT 1',
        connectionString: 'data.sqlite',
      });

      expect((result as { database: string }).database).toBe('sqlite');
    });

    it('detects SQLite from :memory:', async () => {
      const Database = (await import('better-sqlite3')).default;
      const mockDb = new Database(':memory:');
      const mockStmt = { all: vi.fn().mockReturnValue([]) };
      (mockDb.prepare as ReturnType<typeof vi.fn>).mockReturnValue(mockStmt);

      const result = await sqlQuery.execute({
        query: 'SELECT 1',
        connectionString: ':memory:',
      });

      expect((result as { database: string }).database).toBe('sqlite');
    });

    it('executes SQLite SELECT and returns results', async () => {
      const Database = (await import('better-sqlite3')).default;
      const mockDb = new Database('test.db');
      const mockStmt = {
        all: vi.fn().mockReturnValue([
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ]),
      };
      (mockDb.prepare as ReturnType<typeof vi.fn>).mockReturnValue(mockStmt);

      const result = await sqlQuery.execute({
        query: 'SELECT * FROM users',
        connectionString: 'test.db',
      });

      expect(result).toMatchObject({
        rows: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
        rowCount: 2,
        truncated: false,
        database: 'sqlite',
      });
    });

    it('passes parameters to SQLite query', async () => {
      const Database = (await import('better-sqlite3')).default;
      const mockDb = new Database('test.db');
      const mockStmt = { all: vi.fn().mockReturnValue([{ id: 1 }]) };
      (mockDb.prepare as ReturnType<typeof vi.fn>).mockReturnValue(mockStmt);

      await sqlQuery.execute({
        query: 'SELECT * FROM users WHERE id = ?',
        connectionString: 'test.db',
        params: [1],
      });

      expect(mockStmt.all).toHaveBeenCalledWith(1);
    });

    it('closes SQLite connection after query', async () => {
      const Database = (await import('better-sqlite3')).default;
      const mockDb = new Database('test.db');
      const mockStmt = { all: vi.fn().mockReturnValue([]) };
      (mockDb.prepare as ReturnType<typeof vi.fn>).mockReturnValue(mockStmt);

      await sqlQuery.execute({
        query: 'SELECT 1',
        connectionString: 'test.db',
      });

      expect(mockDb.close).toHaveBeenCalled();
    });
  });

  describe('SQL injection prevention', () => {
    beforeEach(() => {
      process.env.DATABASE_URL = 'postgres://localhost/db';
    });

    it('blocks multi-statement injection via semicolon', async () => {
      const result = await sqlQuery.execute({
        query: 'SELECT 1; DROP TABLE users',
      });

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('Only SELECT queries');
    });

    it('blocks SELECT with embedded DROP', async () => {
      const result = await sqlQuery.execute({
        query: "SELECT * FROM users WHERE name = 'x' UNION SELECT 1; DROP TABLE users--",
      });

      expect(result).toHaveProperty('error');
    });

    it('blocks SELECT with INSERT keyword', async () => {
      const result = await sqlQuery.execute({
        query: "SELECT * FROM users WHERE id = 1 UNION INSERT INTO admin VALUES ('hacked')",
      });

      expect(result).toHaveProperty('error');
    });

    it('blocks SELECT with TRUNCATE', async () => {
      const result = await sqlQuery.execute({
        query: 'SELECT 1; TRUNCATE TABLE users',
      });

      expect(result).toHaveProperty('error');
    });

    it('allows SELECT with string containing dangerous keywords', async () => {
      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [{ name: "Drop it like it's hot" }],
      });

      const result = await sqlQuery.execute({
        query: "SELECT * FROM songs WHERE title = 'DROP TABLE beats'",
      });

      expect(result).not.toHaveProperty('error');
    });

    it('blocks GRANT statement', async () => {
      const result = await sqlQuery.execute({
        query: 'GRANT ALL ON users TO attacker',
      });

      expect(result).toHaveProperty('error');
    });

    it('blocks ALTER TABLE', async () => {
      const result = await sqlQuery.execute({
        query: 'ALTER TABLE users ADD COLUMN backdoor TEXT',
      });

      expect(result).toHaveProperty('error');
    });
  });

  describe('database detection', () => {
    it('detects postgres from postgres:// URL', async () => {
      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      const result = await sqlQuery.execute({
        query: 'SELECT 1',
        connectionString: 'postgres://localhost/db',
      });

      expect((result as { database: string }).database).toBe('postgres');
    });

    it('detects postgres from postgresql:// URL', async () => {
      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      const result = await sqlQuery.execute({
        query: 'SELECT 1',
        connectionString: 'postgresql://localhost/db',
      });

      expect((result as { database: string }).database).toBe('postgres');
    });

    it('allows explicit database override', async () => {
      const Database = (await import('better-sqlite3')).default;
      const mockDb = new Database(':memory:');
      const mockStmt = { all: vi.fn().mockReturnValue([]) };
      (mockDb.prepare as ReturnType<typeof vi.fn>).mockReturnValue(mockStmt);

      const result = await sqlQuery.execute({
        query: 'SELECT 1',
        connectionString: 'some-path',
        database: 'sqlite',
      });

      expect((result as { database: string }).database).toBe('sqlite');
    });
  });
});
