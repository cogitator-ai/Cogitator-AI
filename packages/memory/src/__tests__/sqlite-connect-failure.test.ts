import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteAdapter } from '../adapters/sqlite';

describe('SQLiteAdapter connect failure', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('closes the database and stays disconnected when the schema cannot be created', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cogitator-sqlite-'));
    dirs.push(dir);
    const path = join(dir, 'memory.db');
    const existing = new Database(path);
    existing.exec('CREATE TABLE entries (id TEXT PRIMARY KEY)');
    existing.close();

    const adapter = new SQLiteAdapter({ provider: 'sqlite', path });
    const connected = await adapter.connect();

    expect(connected.success).toBe(false);
    if (!connected.success) expect(connected.error).toMatch(/thread_id/);
    expect(await adapter.getThread('t1')).toEqual({ success: false, error: 'Not connected' });
  });
});
