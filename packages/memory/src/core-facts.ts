interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
  pragma(pragma: string): unknown;
}

interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface FactRow {
  key: string;
  value: string;
  updated_at: string;
}

interface HistoryRow {
  id: number;
  key: string;
  value: string;
  set_at: string;
}

export interface FactHistoryEntry {
  value: string;
  setAt: Date;
}

export type CoreFactsStoreConfig = { path: string; db?: never } | { db: Database; path?: never };

export class CoreFactsStore {
  private db: Database | null = null;
  private ownsDb: boolean;
  private path: string | null;
  private initialized = false;

  constructor(config: CoreFactsStoreConfig) {
    if ('db' in config && config.db) {
      this.db = config.db;
      this.ownsDb = false;
      this.path = null;
    } else {
      this.path = config.path;
      this.ownsDb = true;
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (!this.db) {
      let DatabaseCtor: new (path: string) => Database;
      const betterSqlite = await import('better-sqlite3');
      DatabaseCtor = betterSqlite.default as unknown as new (path: string) => Database;
      this.db = new DatabaseCtor(this.path!);

      if (this.path !== ':memory:') {
        this.db.pragma('journal_mode = WAL');
      }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS core_facts (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS core_facts_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        set_at TEXT NOT NULL
      );
    `);

    this.initialized = true;
  }

  async close(): Promise<void> {
    if (this.db && this.ownsDb) {
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
  }

  private ensureDb(): Database {
    if (!this.db) throw new Error('Not initialized');
    return this.db;
  }

  async set(key: string, value: string): Promise<void> {
    const db = this.ensureDb();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO core_facts (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, value, now);

    db.prepare(`INSERT INTO core_facts_history (key, value, set_at) VALUES (?, ?, ?)`).run(
      key,
      value,
      now
    );
  }

  async get(key: string): Promise<string | null> {
    const db = this.ensureDb();
    const row = db.prepare(`SELECT value FROM core_facts WHERE key = ?`).get(key) as
      | Pick<FactRow, 'value'>
      | undefined;
    return row?.value ?? null;
  }

  async getAll(): Promise<Record<string, string>> {
    const db = this.ensureDb();
    const rows = db.prepare(`SELECT key, value FROM core_facts ORDER BY key`).all() as FactRow[];
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  async delete(key: string): Promise<void> {
    const db = this.ensureDb();
    db.prepare(`DELETE FROM core_facts WHERE key = ?`).run(key);
  }

  async getHistory(key: string): Promise<FactHistoryEntry[]> {
    const db = this.ensureDb();
    const rows = db
      .prepare(`SELECT value, set_at FROM core_facts_history WHERE key = ? ORDER BY id ASC`)
      .all(key) as HistoryRow[];
    return rows.map((row) => ({
      value: row.value,
      setAt: new Date(row.set_at),
    }));
  }

  async formatForPrompt(): Promise<string> {
    const facts = await this.getAll();
    const keys = Object.keys(facts);
    if (keys.length === 0) return '';
    return keys.map((k) => `${k}: ${facts[k]}`).join('\n');
  }
}
