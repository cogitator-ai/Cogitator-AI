/**
 * Memory file versions in SQLite, over any connection shaped like `better-sqlite3`
 */

import {
  MEMORY_FILE_CONFLICT,
  type MemoryFileAdapter,
  type MemoryFileFilter,
  type MemoryFileVersion,
  type MemoryResult,
} from '@cogitator-ai/types';
import { fileKeyOf, matchesFileFilter } from '../memory-files';
import { memoryFileVersionFromJson, type StoredMemoryFileVersion } from './memory-item-json';
import type { SqliteItemsDatabase } from './sqlite-memory-items';

/**
 * Each version is kept whole as JSON in `data`, beside the columns its filters read. `file_key`
 * names its scope and path, and no two versions of one key hold one `sequence`, which is how two
 * writers are kept from adding the same version. Times are milliseconds.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_file_versions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    file_key TEXT NOT NULL,
    path TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    data TEXT NOT NULL,
    UNIQUE (file_key, sequence)
  );
  CREATE INDEX IF NOT EXISTS idx_memory_file_versions_agent
    ON memory_file_versions(agent_id, path, created_at);
`;

function versionFrom(data: string): MemoryFileVersion {
  return memoryFileVersionFromJson(JSON.parse(data) as StoredMemoryFileVersion);
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes('UNIQUE constraint failed');
}

/**
 * A {@link MemoryFileAdapter} over the SQLite database `db`, whose table it creates when it is
 * missing. `SQLiteAdapter` keeps its memory files through it.
 */
export function sqliteMemoryFiles(db: SqliteItemsDatabase): MemoryFileAdapter {
  db.exec(SCHEMA);

  const run = <T>(work: () => T): Promise<MemoryResult<T>> => {
    try {
      return Promise.resolve({ success: true, data: work() });
    } catch (err) {
      return Promise.resolve({
        success: false,
        error: isUniqueViolation(err) ? MEMORY_FILE_CONFLICT : (err as Error).message,
      });
    }
  };

  const atomically = (work: () => void): void => {
    db.exec('SAVEPOINT memory_files');
    try {
      work();
      db.exec('RELEASE memory_files');
    } catch (err) {
      db.exec('ROLLBACK TO memory_files');
      db.exec('RELEASE memory_files');
      throw err;
    }
  };

  return {
    putFileVersions: (versions) =>
      run(() => {
        const insert = db.prepare(
          `INSERT INTO memory_file_versions
             (id, agent_id, file_key, path, sequence, created_at, data)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        atomically(() => {
          for (const version of versions) {
            insert.run(
              version.id,
              version.scope.agentId,
              fileKeyOf(version.scope, version.path),
              version.path,
              version.sequence,
              version.createdAt.getTime(),
              JSON.stringify(version)
            );
          }
        });
        return versions.map((version) => versionFrom(JSON.stringify(version)));
      }),

    findFileVersions: (filter: MemoryFileFilter) =>
      run(() => {
        const conditions = ['agent_id = ?'];
        const params: unknown[] = [filter.agentId];
        if (filter.ids) {
          conditions.push(
            filter.ids.length === 0 ? '1 = 0' : `id IN (${filter.ids.map(() => '?').join(', ')})`
          );
          params.push(...filter.ids);
        }
        if (filter.paths) {
          conditions.push(
            filter.paths.length === 0
              ? '1 = 0'
              : `path IN (${filter.paths.map(() => '?').join(', ')})`
          );
          params.push(...filter.paths);
        }
        if (filter.prefix !== undefined) {
          conditions.push('substr(path, 1, ?) = ?');
          params.push(filter.prefix.length, filter.prefix);
        }
        const rows = db
          .prepare(
            `SELECT data FROM memory_file_versions WHERE ${conditions.join(' AND ')}
             ORDER BY created_at, sequence, id`
          )
          .all(...params) as { data: string }[];
        return rows
          .map((row) => versionFrom(row.data))
          .filter((version) => matchesFileFilter(version, filter));
      }),

    redactFileVersions: (ids, redaction) =>
      run(() => {
        const read = db.prepare('SELECT data FROM memory_file_versions WHERE id = ?');
        const write = db.prepare('UPDATE memory_file_versions SET data = ? WHERE id = ?');
        atomically(() => {
          for (const id of new Set(ids)) {
            const row = read.get(id) as { data: string } | undefined;
            if (!row) continue;
            const version = versionFrom(row.data);
            write.run(
              JSON.stringify({
                ...version,
                content: redaction.content,
                sha256: redaction.sha256,
                redacted: {
                  at: redaction.at,
                  ...(redaction.reason !== undefined && { reason: redaction.reason }),
                },
              }),
              id
            );
          }
        });
      }),

    deleteFileVersions: (ids) =>
      run(() => {
        const remove = db.prepare('DELETE FROM memory_file_versions WHERE id = ?');
        atomically(() => {
          for (const id of new Set(ids)) remove.run(id);
        });
      }),
  };
}
