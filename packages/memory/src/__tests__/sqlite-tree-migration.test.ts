import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteAdapter } from '../adapters/sqlite';

describe('SQLiteAdapter: entries written before trees', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function legacyDatabase(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cogitator-sqlite-tree-'));
    dirs.push(dir);
    const path = join(dir, 'memory.db');
    const db = new Database(path);
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE entries (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, message TEXT NOT NULL,
        tool_calls TEXT, tool_results TEXT, token_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, metadata TEXT,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );
    `);
    const at = new Date(0).toISOString();
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run('t', 'agent', '{}', at, at);
    const insert = db.prepare(
      'INSERT INTO entries (id, thread_id, message, token_count, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    for (const [i, id] of ['e1', 'e2', 'e3'].entries()) {
      insert.run(
        id,
        't',
        JSON.stringify({ role: 'user', content: id }),
        1,
        new Date(i * 1000).toISOString()
      );
    }
    db.close();
    return path;
  }

  it('chains them in the order they were added and keeps adding after the last', async () => {
    const adapter = new SQLiteAdapter({ provider: 'sqlite', path: legacyDatabase() });
    expect((await adapter.connect()).success).toBe(true);

    const thread = await adapter.getThread('t');
    const path = await adapter.getPath({ threadId: 't' });
    const added = await adapter.addEntry({
      threadId: 't',
      message: { role: 'user', content: 'e4' },
      tokenCount: 1,
    });

    expect(thread.success && thread.data?.activeLeafId).toBe('e3');
    expect(path.success && path.data.map((e) => [e.id, e.parentId])).toEqual([
      ['e1', null],
      ['e2', 'e1'],
      ['e3', 'e2'],
    ]);
    expect(added.success && added.data.parentId).toBe('e3');
    await adapter.disconnect();
  });

  it('migrates once, so a second connect changes nothing', async () => {
    const path = legacyDatabase();
    const first = new SQLiteAdapter({ provider: 'sqlite', path });
    await first.connect();
    await first.rewind('t', 'e2');
    await first.disconnect();

    const second = new SQLiteAdapter({ provider: 'sqlite', path });
    await second.connect();
    const thread = await second.getThread('t');

    expect(thread.success && thread.data?.activeLeafId).toBe('e2');
    await second.disconnect();
  });

  it('keeps the order of entries of the same moment through a VACUUM', async () => {
    const path = legacyDatabase();
    const adapter = new SQLiteAdapter({ provider: 'sqlite', path });
    await adapter.connect();
    const at = new Date(5000);
    for (const content of ['q', 'a', 'q2', 'a2']) {
      await adapter.addEntry({
        threadId: 't',
        message: { role: 'user', content },
        tokenCount: 1,
        createdAt: at,
      });
    }
    const before = await adapter.getEntries({ threadId: 't' });
    await adapter.disconnect();
    const db = new Database(path);
    db.exec('VACUUM');
    db.close();

    const reopened = new SQLiteAdapter({ provider: 'sqlite', path });
    await reopened.connect();
    const after = await reopened.getEntries({ threadId: 't' });

    const order = (read: typeof before) =>
      read.success ? read.data.map((entry) => [entry.id, entry.seq]) : [];
    expect(order(after)).toEqual(order(before));
    await reopened.disconnect();
  });

  it('ends a path read on a cycle a damaged database holds', async () => {
    const path = legacyDatabase();
    const adapter = new SQLiteAdapter({ provider: 'sqlite', path });
    await adapter.connect();
    await adapter.disconnect();
    const db = new Database(path);
    db.prepare("UPDATE entries SET parent_id = 'e3' WHERE id = 'e1'").run();
    db.close();

    const reopened = new SQLiteAdapter({ provider: 'sqlite', path });
    await reopened.connect();
    const read = await reopened.getPath({ threadId: 't', limit: 10 });

    expect(read.success && read.data.length).toBe(10);
    await reopened.disconnect();
  });
});
