import type BetterSqlite3 from 'better-sqlite3';

/**
 * The prepared statement methods the SQLite stores call, typed against the installed
 * `better-sqlite3` so a method it no longer has, or one whose signature changed, fails to compile.
 */
export type SqliteStatement = Pick<BetterSqlite3.Statement<unknown[]>, 'run' | 'get' | 'all'>;

/** The database methods the SQLite stores call, typed against the installed `better-sqlite3`. */
export interface SqliteDatabase extends Pick<BetterSqlite3.Database, 'exec' | 'close' | 'pragma'> {
  prepare(source: string): SqliteStatement;
}
