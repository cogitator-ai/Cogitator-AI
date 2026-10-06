import { describe, it, expect, vi } from 'vitest';

vi.mock('pg', () => {
  throw new Error("Cannot find package 'pg' imported from adapters/postgres.js");
});

vi.mock('better-sqlite3', () => {
  throw new Error("Cannot find package 'better-sqlite3'");
});

import { PostgresAdapter } from '../adapters/postgres';
import { SQLiteGraphAdapter } from '../knowledge-graph/sqlite-graph-adapter';

describe('adapters without their database driver', () => {
  it('tells how to install pg', async () => {
    const adapter = new PostgresAdapter({
      provider: 'postgres',
      connectionString: 'postgresql://localhost/db',
    });

    const result = await adapter.connect();

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/pnpm add pg/);
  });

  it('tells how to install better-sqlite3 for the SQLite knowledge graph', async () => {
    const graph = new SQLiteGraphAdapter({ path: ':memory:' });

    await expect(graph.initialize()).rejects.toThrow(/pnpm add better-sqlite3/);
  });
});
