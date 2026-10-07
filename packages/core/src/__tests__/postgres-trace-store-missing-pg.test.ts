import { describe, it, expect, vi } from 'vitest';

vi.mock('pg', () => {
  throw new Error("Cannot find package 'pg'");
});

import { PostgresTraceStore } from '../learning/postgres-trace-store';

describe('PostgresTraceStore without pg', () => {
  it('tells how to install pg', async () => {
    const store = new PostgresTraceStore({ connectionString: 'postgresql://localhost/db' });

    await expect(store.connect()).rejects.toThrow(/pnpm add pg/);
  });
});
