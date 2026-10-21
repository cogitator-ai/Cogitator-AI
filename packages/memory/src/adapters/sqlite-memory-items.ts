/**
 * Memory items in SQLite, over any connection shaped like `better-sqlite3`
 */

import type {
  MemoryEntity,
  MemoryEntityFilter,
  MemoryItem,
  MemoryItemAdapter,
  MemoryItemFilter,
  MemoryResult,
} from '@cogitator-ai/types';
import { entityNames } from '../memory-items';
import {
  memoryEntityFromJson,
  memoryItemFromJson,
  type StoredMemoryEntity,
  type StoredMemoryItem,
} from './memory-item-json';

/** The prepared statement methods the memory item tables need */
export interface SqliteItemsStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/**
 * The database the memory item tables live in. A `better-sqlite3` `Database` satisfies it, and
 * so does the narrower one `CoreFactsStore` declares, so both can keep memory items.
 */
export interface SqliteItemsDatabase {
  prepare(sql: string): SqliteItemsStatement;
  exec(sql: string): void;
}

/**
 * Each item is kept whole as JSON in `data`, beside the columns its filters read, its scope
 * among them. Times are milliseconds, so `recorded_at` sorts in time order. Every normalized name of an entity is a
 * row of `memory_entity_names`, which is how entities are found by name.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_items (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    slot TEXT,
    entity_id TEXT,
    user_id TEXT,
    project_id TEXT,
    thread_id TEXT,
    recorded_at INTEGER NOT NULL,
    expired_at INTEGER,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memory_items_slot ON memory_items(agent_id, slot);
  CREATE INDEX IF NOT EXISTS idx_memory_items_entity ON memory_items(agent_id, entity_id);
  CREATE INDEX IF NOT EXISTS idx_memory_items_recorded ON memory_items(agent_id, recorded_at, id);
  CREATE INDEX IF NOT EXISTS idx_memory_items_user ON memory_items(agent_id, user_id);

  CREATE TABLE IF NOT EXISTS memory_entities (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memory_entities_agent ON memory_entities(agent_id);

  CREATE TABLE IF NOT EXISTS memory_entity_names (
    entity_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (entity_id, name)
  );
  CREATE INDEX IF NOT EXISTS idx_memory_entity_names_name ON memory_entity_names(agent_id, name);
`;

interface DataRow {
  data: string;
}

/** The columns of an item's scope, beside the scope field each holds */
const SCOPE_COLUMNS = [
  ['user_id', 'userId'],
  ['project_id', 'projectId'],
  ['thread_id', 'threadId'],
] as const;

/**
 * Adds the scope columns to a `memory_items` table made before it had them, filled from the
 * scope each item holds
 */
function addScopeColumns(db: SqliteItemsDatabase): void {
  const columns = db.prepare('PRAGMA table_info(memory_items)').all() as { name: string }[];
  if (columns.length === 0) return;
  const missing = SCOPE_COLUMNS.filter(
    ([column]) => !columns.some((present) => present.name === column)
  );
  if (missing.length === 0) return;
  atomically(db, () => {
    for (const [column, field] of missing) {
      db.exec(`ALTER TABLE memory_items ADD COLUMN ${column} TEXT`);
      db.exec(`UPDATE memory_items SET ${column} = json_extract(data, '$.scope.${field}')`);
    }
  });
}

function itemFrom(data: string): MemoryItem {
  return memoryItemFromJson(JSON.parse(data) as StoredMemoryItem);
}

function entityFrom(data: string): MemoryEntity {
  return memoryEntityFromJson(JSON.parse(data) as StoredMemoryEntity);
}

const placeholders = (values: readonly unknown[]) => values.map(() => '?').join(', ');

/** The SQL condition that `column` is one of `values`, which never holds for no values */
function oneOf(column: string, values: readonly unknown[]): string {
  return values.length === 0 ? '1 = 0' : `${column} IN (${placeholders(values)})`;
}

function succeed<T>(data: T): MemoryResult<T> {
  return { success: true, data };
}

function attempt<T>(work: () => T): Promise<MemoryResult<T>> {
  try {
    return Promise.resolve(succeed(work()));
  } catch (err) {
    return Promise.resolve({ success: false, error: (err as Error).message });
  }
}

/**
 * Runs `work` in a savepoint, so it is atomic whether or not the connection is already in a
 * transaction
 */
function atomically(db: SqliteItemsDatabase, work: () => void): void {
  db.exec('SAVEPOINT memory_items');
  try {
    work();
    db.exec('RELEASE memory_items');
  } catch (err) {
    db.exec('ROLLBACK TO memory_items');
    db.exec('RELEASE memory_items');
    throw err;
  }
}

/**
 * A {@link MemoryItemAdapter} over the SQLite database `db`, whose tables it creates when they
 * are missing. `SQLiteAdapter` keeps its items through it, and so does `CoreFactsStore`.
 */
export function sqliteMemoryItems(db: SqliteItemsDatabase): MemoryItemAdapter {
  addScopeColumns(db);
  db.exec(SCHEMA);

  return {
    putItem: (item) =>
      attempt(() => {
        const data = JSON.stringify(item);
        db.prepare(
          `INSERT INTO memory_items
             (id, agent_id, kind, status, slot, entity_id, user_id, project_id, thread_id,
              recorded_at, expired_at, data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             agent_id = excluded.agent_id,
             kind = excluded.kind,
             status = excluded.status,
             slot = excluded.slot,
             entity_id = excluded.entity_id,
             user_id = excluded.user_id,
             project_id = excluded.project_id,
             thread_id = excluded.thread_id,
             recorded_at = excluded.recorded_at,
             expired_at = excluded.expired_at,
             data = excluded.data`
        ).run(
          item.id,
          item.scope.agentId,
          item.kind,
          item.status,
          item.slot ?? null,
          item.entityId ?? null,
          item.scope.userId ?? null,
          item.scope.projectId ?? null,
          item.scope.threadId ?? null,
          item.recordedAt.getTime(),
          item.expiredAt?.getTime() ?? null,
          data
        );
        return itemFrom(data);
      }),

    getItem: (itemId) =>
      attempt(() => {
        const row = db.prepare('SELECT data FROM memory_items WHERE id = ?').get(itemId) as
          DataRow | undefined;
        return row ? itemFrom(row.data) : null;
      }),

    findItems: (filter: MemoryItemFilter) =>
      attempt(() => {
        const where = ['agent_id = ?'];
        const params: unknown[] = [filter.agentId];
        for (const [column, values] of [
          ['id', filter.ids],
          ['slot', filter.slots],
          ['entity_id', filter.entityIds],
          ['kind', filter.kinds],
          ['status', filter.statuses],
        ] as const) {
          if (values === undefined) continue;
          where.push(oneOf(column, values));
          params.push(...values);
        }
        const param = (value: string) => {
          params.push(value);
          return '?';
        };
        for (const [column, field] of SCOPE_COLUMNS) {
          const visible = filter.visibleTo?.[field];
          if (filter.visibleTo !== undefined) {
            where.push(
              visible === undefined
                ? `${column} IS NULL`
                : `(${column} IS NULL OR ${column} = ${param(visible)})`
            );
          }
          const exact = filter.scope?.[field];
          if (filter.scope !== undefined) {
            where.push(exact === undefined ? `${column} IS NULL` : `${column} = ${param(exact)}`);
          }
        }
        if (filter.includeExpired !== true) {
          where.push('(expired_at IS NULL OR expired_at > ?)');
          params.push(Date.now());
        }
        const rows = db
          .prepare(
            `SELECT data FROM memory_items WHERE ${where.join(' AND ')}
             ORDER BY recorded_at ASC, id ASC`
          )
          .all(...params) as DataRow[];
        return rows.map((row) => itemFrom(row.data));
      }),

    deleteItems: (itemIds) =>
      attempt(() => {
        if (itemIds.length === 0) return;
        db.prepare(`DELETE FROM memory_items WHERE ${oneOf('id', itemIds)}`).run(...itemIds);
      }),

    putEntity: (entity) =>
      attempt(() => {
        const data = JSON.stringify(entity);
        atomically(db, () => {
          db.prepare(
            `INSERT INTO memory_entities (id, agent_id, data) VALUES (?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET agent_id = excluded.agent_id, data = excluded.data`
          ).run(entity.id, entity.scope.agentId, data);
          db.prepare('DELETE FROM memory_entity_names WHERE entity_id = ?').run(entity.id);
          const named = db.prepare(
            'INSERT INTO memory_entity_names (entity_id, agent_id, name) VALUES (?, ?, ?)'
          );
          for (const name of entityNames(entity)) {
            named.run(entity.id, entity.scope.agentId, name);
          }
        });
        return entityFrom(data);
      }),

    findEntities: (filter: MemoryEntityFilter) =>
      attempt(() => {
        const where = ['e.agent_id = ?'];
        const params: unknown[] = [filter.agentId];
        if (filter.ids !== undefined) {
          where.push(oneOf('e.id', filter.ids));
          params.push(...filter.ids);
        }
        if (filter.names !== undefined) {
          where.push(
            `EXISTS (SELECT 1 FROM memory_entity_names n
                     WHERE n.entity_id = e.id AND n.agent_id = e.agent_id
                       AND ${oneOf('n.name', filter.names)})`
          );
          params.push(...filter.names);
        }
        const rows = db
          .prepare(
            `SELECT e.data FROM memory_entities e WHERE ${where.join(' AND ')} ORDER BY e.rowid`
          )
          .all(...params) as DataRow[];
        return rows.map((row) => entityFrom(row.data));
      }),

    deleteEntities: (entityIds) =>
      attempt(() => {
        if (entityIds.length === 0) return;
        atomically(db, () => {
          db.prepare(`DELETE FROM memory_entity_names WHERE ${oneOf('entity_id', entityIds)}`).run(
            ...entityIds
          );
          db.prepare(`DELETE FROM memory_entities WHERE ${oneOf('id', entityIds)}`).run(
            ...entityIds
          );
        });
      }),
  };
}
