declare module 'better-sqlite3' {
  interface Statement {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  interface Database {
    prepare(sql: string): Statement;
    exec(sql: string): void;
    close(): void;
    pragma(pragma: string): unknown;
  }

  interface DatabaseConstructor {
    new (filename: string, options?: { readonly?: boolean; fileMustExist?: boolean }): Database;
  }

  const Database: DatabaseConstructor;
  export default Database;
}

declare module 'mongodb' {
  interface MongoClient {
    connect(): Promise<void>;
    close(): Promise<void>;
    db(name?: string): Db;
  }

  interface Db {
    collection<T = Document>(name: string): Collection<T>;
  }

  interface Collection<T = Document> {
    createIndex(keys: Record<string, 1 | -1>, options?: { unique?: boolean }): Promise<string>;
    insertOne(doc: T): Promise<{ insertedId: unknown }>;
    findOne(filter: Record<string, unknown>): Promise<T | null>;
    find(filter: Record<string, unknown>): Cursor<T>;
    updateOne(
      filter: Record<string, unknown>,
      update: { $set: Partial<T> }
    ): Promise<{ modifiedCount: number }>;
    deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount: number }>;
    deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount: number }>;
  }

  interface Cursor<T> {
    sort(sort: Record<string, 1 | -1>): Cursor<T>;
    limit(n: number): Cursor<T>;
    toArray(): Promise<T[]>;
  }

  interface Document {
    _id?: unknown;
  }

  export class MongoClient {
    constructor(uri: string);
    connect(): Promise<void>;
    close(): Promise<void>;
    db(name?: string): Db;
  }
}
