import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { MemoryItem, MemoryItemScope } from '@cogitator-ai/types';
import { sqliteMemoryItems } from '../adapters/sqlite-memory-items';

const at = new Date('2026-01-01T00:00:00.000Z');

function item(id: string, scope: MemoryItemScope): MemoryItem {
  return {
    id,
    kind: 'fact',
    content: `item ${id}`,
    status: 'active',
    trust: 'user',
    confidence: 0.9,
    scope,
    evidence: [],
    verified: true,
    saidAt: at,
    sessionAt: at,
    recordedAt: at,
  };
}

describe('sqliteMemoryItems on a table from before the scope columns', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = new BetterSqlite3(':memory:');
    db.exec(`
      CREATE TABLE memory_items (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        slot TEXT,
        entity_id TEXT,
        recorded_at INTEGER NOT NULL,
        expired_at INTEGER,
        data TEXT NOT NULL
      )
    `);
    const insert = db.prepare(
      `INSERT INTO memory_items (id, agent_id, kind, status, recorded_at, data)
       VALUES (?, 'a1', 'fact', 'active', ?, ?)`
    );
    for (const written of [
      item('wide', { agentId: 'a1' }),
      item('u1', { agentId: 'a1', userId: 'u1' }),
      item('u1-t1', { agentId: 'a1', userId: 'u1', threadId: 't1' }),
      item('u2-p1', { agentId: 'a1', userId: 'u2', projectId: 'p1' }),
    ]) {
      insert.run(written.id, at.getTime(), JSON.stringify(written));
    }
  });

  afterEach(() => {
    db.close();
  });

  it('adds the columns, fills them from each item and indexes the user', async () => {
    const adapter = sqliteMemoryItems(db);

    const rows = db
      .prepare('SELECT id, user_id, project_id, thread_id FROM memory_items ORDER BY id')
      .all();
    expect(rows).toEqual([
      { id: 'u1', user_id: 'u1', project_id: null, thread_id: null },
      { id: 'u1-t1', user_id: 'u1', project_id: null, thread_id: 't1' },
      { id: 'u2-p1', user_id: 'u2', project_id: 'p1', thread_id: null },
      { id: 'wide', user_id: null, project_id: null, thread_id: null },
    ]);
    const indexes = db.prepare('PRAGMA index_list(memory_items)').all() as { name: string }[];
    expect(indexes.map((index) => index.name)).toContain('idx_memory_items_user');

    const visible = await adapter.findItems({
      agentId: 'a1',
      visibleTo: { agentId: 'a1', userId: 'u1', threadId: 't1' },
    });
    expect(visible.success && visible.data.map((found) => found.id).sort()).toEqual([
      'u1',
      'u1-t1',
      'wide',
    ]);
  });

  it('leaves the columns as they are when they are already there', () => {
    sqliteMemoryItems(db);
    db.prepare("UPDATE memory_items SET user_id = 'moved' WHERE id = 'u1'").run();

    sqliteMemoryItems(db);

    expect(db.prepare("SELECT user_id FROM memory_items WHERE id = 'u1'").get()).toEqual({
      user_id: 'moved',
    });
  });
});
