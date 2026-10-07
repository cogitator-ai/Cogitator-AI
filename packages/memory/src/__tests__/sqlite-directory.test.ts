import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAdapter } from '../adapters/sqlite';

describe('SQLiteAdapter database directory', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('creates the directories of a database file that do not exist yet', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cogitator-sqlite-'));
    dirs.push(root);
    const path = join(root, 'data', 'nested', 'memory.db');

    const adapter = new SQLiteAdapter({ provider: 'sqlite', path });
    const connected = await adapter.connect();

    expect(connected.success).toBe(true);
    expect(existsSync(path)).toBe(true);
    await adapter.disconnect();
  });

  it('opens an in-memory database without touching the file system', async () => {
    const adapter = new SQLiteAdapter({ provider: 'sqlite', path: ':memory:' });

    expect((await adapter.connect()).success).toBe(true);
    expect(existsSync(':memory:')).toBe(false);
    await adapter.disconnect();
  });
});
