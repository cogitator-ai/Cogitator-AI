import type { StoredThread, StoredAssistant } from './thread-manager';

export interface StoredFile {
  id: string;
  content: Buffer;
  filename: string;
  created_at: number;
}

/**
 * Storage interface for ThreadManager persistence.
 *
 * Implementations can store data in memory, Redis, PostgreSQL, or other backends.
 */
export interface ThreadStorage {
  saveThread(id: string, thread: StoredThread): Promise<void>;
  loadThread(id: string): Promise<StoredThread | null>;
  deleteThread(id: string): Promise<boolean>;
  listThreads(): Promise<StoredThread[]>;

  saveAssistant(id: string, assistant: StoredAssistant): Promise<void>;
  loadAssistant(id: string): Promise<StoredAssistant | null>;
  deleteAssistant(id: string): Promise<boolean>;
  listAssistants(): Promise<StoredAssistant[]>;

  saveFile(id: string, file: StoredFile): Promise<void>;
  loadFile(id: string): Promise<StoredFile | null>;
  deleteFile(id: string): Promise<boolean>;
  listFiles(): Promise<StoredFile[]>;

  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
}

/**
 * In-memory storage implementation (default, non-persistent).
 *
 * Data is lost when the process restarts.
 */
export class InMemoryThreadStorage implements ThreadStorage {
  private threads = new Map<string, StoredThread>();
  private assistants = new Map<string, StoredAssistant>();
  private files = new Map<string, StoredFile>();

  async saveThread(id: string, thread: StoredThread): Promise<void> {
    this.threads.set(id, thread);
  }

  async loadThread(id: string): Promise<StoredThread | null> {
    return this.threads.get(id) ?? null;
  }

  async deleteThread(id: string): Promise<boolean> {
    return this.threads.delete(id);
  }

  async listThreads(): Promise<StoredThread[]> {
    return Array.from(this.threads.values());
  }

  async saveAssistant(id: string, assistant: StoredAssistant): Promise<void> {
    this.assistants.set(id, assistant);
  }

  async loadAssistant(id: string): Promise<StoredAssistant | null> {
    return this.assistants.get(id) ?? null;
  }

  async deleteAssistant(id: string): Promise<boolean> {
    return this.assistants.delete(id);
  }

  async listAssistants(): Promise<StoredAssistant[]> {
    return Array.from(this.assistants.values());
  }

  async saveFile(id: string, file: StoredFile): Promise<void> {
    this.files.set(id, file);
  }

  async loadFile(id: string): Promise<StoredFile | null> {
    return this.files.get(id) ?? null;
  }

  async deleteFile(id: string): Promise<boolean> {
    return this.files.delete(id);
  }

  async listFiles(): Promise<StoredFile[]> {
    return Array.from(this.files.values());
  }
}

export interface RedisThreadStorageConfig {
  url?: string;
  host?: string;
  port?: number;
  keyPrefix?: string;
  ttl?: number;
}

/**
 * Redis storage implementation for ThreadManager.
 *
 * Requires ioredis to be installed as a peer dependency.
 *
 * @example
 * ```ts
 * const storage = new RedisThreadStorage({
 *   url: 'redis://localhost:6379',
 *   keyPrefix: 'openai:',
 *   ttl: 86400,
 * });
 * await storage.connect();
 *
 * const manager = new ThreadManager(storage);
 * ```
 */
export class RedisThreadStorage implements ThreadStorage {
  private client: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, option: string, ttl: number): Promise<unknown>;
    del(key: string): Promise<number>;
    keys(pattern: string): Promise<string[]>;
    quit(): Promise<unknown>;
  } | null = null;

  private config: RedisThreadStorageConfig;
  private keyPrefix: string;
  private ttl: number;

  constructor(config: RedisThreadStorageConfig = {}) {
    this.config = config;
    this.keyPrefix = config.keyPrefix ?? 'cogitator:openai:';
    this.ttl = config.ttl ?? 86400;
  }

  async connect(): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Redis = require('ioredis');
      this.client = new Redis(
        this.config.url ?? {
          host: this.config.host ?? 'localhost',
          port: this.config.port ?? 6379,
        }
      );
    } catch {
      throw new Error(
        'ioredis is required for RedisThreadStorage. Install it with: npm install ioredis'
      );
    }
  }

  async disconnect(): Promise<void> {
    await this.client?.quit();
    this.client = null;
  }

  private ensureClient() {
    if (!this.client) {
      throw new Error('RedisThreadStorage not connected. Call connect() first.');
    }
    return this.client;
  }

  private key(type: string, id: string): string {
    return `${this.keyPrefix}${type}:${id}`;
  }

  async saveThread(id: string, thread: StoredThread): Promise<void> {
    const client = this.ensureClient();
    await client.set(this.key('thread', id), JSON.stringify(thread), 'EX', this.ttl);
  }

  async loadThread(id: string): Promise<StoredThread | null> {
    const client = this.ensureClient();
    const data = await client.get(this.key('thread', id));
    return data ? JSON.parse(data) : null;
  }

  async deleteThread(id: string): Promise<boolean> {
    const client = this.ensureClient();
    const deleted = await client.del(this.key('thread', id));
    return deleted > 0;
  }

  async listThreads(): Promise<StoredThread[]> {
    const client = this.ensureClient();
    const keys = await client.keys(`${this.keyPrefix}thread:*`);
    const threads: StoredThread[] = [];
    for (const key of keys) {
      const data = await client.get(key);
      if (data) threads.push(JSON.parse(data));
    }
    return threads;
  }

  async saveAssistant(id: string, assistant: StoredAssistant): Promise<void> {
    const client = this.ensureClient();
    await client.set(this.key('assistant', id), JSON.stringify(assistant), 'EX', this.ttl);
  }

  async loadAssistant(id: string): Promise<StoredAssistant | null> {
    const client = this.ensureClient();
    const data = await client.get(this.key('assistant', id));
    return data ? JSON.parse(data) : null;
  }

  async deleteAssistant(id: string): Promise<boolean> {
    const client = this.ensureClient();
    const deleted = await client.del(this.key('assistant', id));
    return deleted > 0;
  }

  async listAssistants(): Promise<StoredAssistant[]> {
    const client = this.ensureClient();
    const keys = await client.keys(`${this.keyPrefix}assistant:*`);
    const assistants: StoredAssistant[] = [];
    for (const key of keys) {
      const data = await client.get(key);
      if (data) assistants.push(JSON.parse(data));
    }
    return assistants;
  }

  async saveFile(id: string, file: StoredFile): Promise<void> {
    const client = this.ensureClient();
    const serialized = {
      ...file,
      content: file.content.toString('base64'),
    };
    await client.set(this.key('file', id), JSON.stringify(serialized), 'EX', this.ttl);
  }

  async loadFile(id: string): Promise<StoredFile | null> {
    const client = this.ensureClient();
    const data = await client.get(this.key('file', id));
    if (!data) return null;
    const parsed = JSON.parse(data);
    return {
      ...parsed,
      content: Buffer.from(parsed.content, 'base64'),
    };
  }

  async deleteFile(id: string): Promise<boolean> {
    const client = this.ensureClient();
    const deleted = await client.del(this.key('file', id));
    return deleted > 0;
  }

  async listFiles(): Promise<StoredFile[]> {
    const client = this.ensureClient();
    const keys = await client.keys(`${this.keyPrefix}file:*`);
    const files: StoredFile[] = [];
    for (const key of keys) {
      const data = await client.get(key);
      if (data) {
        const parsed = JSON.parse(data);
        files.push({
          ...parsed,
          content: Buffer.from(parsed.content, 'base64'),
        });
      }
    }
    return files;
  }
}

export interface PostgresThreadStorageConfig {
  connectionString: string;
  schema?: string;
  tableName?: string;
}

/**
 * PostgreSQL storage implementation for ThreadManager.
 *
 * Requires pg to be installed as a peer dependency.
 * Automatically creates required tables on first connect.
 *
 * @example
 * ```ts
 * const storage = new PostgresThreadStorage({
 *   connectionString: 'postgresql://user:pass@localhost/db',
 *   tableName: 'openai_threads',
 * });
 * await storage.connect();
 *
 * const manager = new ThreadManager(storage);
 * ```
 */
export class PostgresThreadStorage implements ThreadStorage {
  private pool: {
    query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
    end(): Promise<void>;
  } | null = null;

  private config: PostgresThreadStorageConfig;
  private schema: string;
  private tableName: string;

  private static readonly IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

  private static validateIdentifier(value: string, name: string): void {
    if (!PostgresThreadStorage.IDENTIFIER_REGEX.test(value)) {
      throw new Error(
        `Invalid ${name}: "${value}". Must match /^[a-zA-Z_][a-zA-Z0-9_]*$/ to prevent SQL injection.`
      );
    }
  }

  constructor(config: PostgresThreadStorageConfig) {
    this.config = config;
    this.schema = config.schema ?? 'public';
    this.tableName = config.tableName ?? 'openai_compat_data';
    PostgresThreadStorage.validateIdentifier(this.schema, 'schema');
    PostgresThreadStorage.validateIdentifier(this.tableName, 'tableName');
  }

  async connect(): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Pool } = require('pg');
      this.pool = new Pool({ connectionString: this.config.connectionString });

      await this.pool!.query(`
        CREATE TABLE IF NOT EXISTS ${this.schema}.${this.tableName} (
          type TEXT NOT NULL,
          id TEXT NOT NULL,
          data JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (type, id)
        )
      `);

      await this.pool!.query(`
        CREATE INDEX IF NOT EXISTS idx_${this.tableName}_type
        ON ${this.schema}.${this.tableName}(type)
      `);
    } catch (err) {
      if (err instanceof Error && err.message.includes('Cannot find module')) {
        throw new Error(
          'pg is required for PostgresThreadStorage. Install it with: npm install pg'
        );
      }
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }

  private ensurePool() {
    if (!this.pool) {
      throw new Error('PostgresThreadStorage not connected. Call connect() first.');
    }
    return this.pool;
  }

  async saveThread(id: string, thread: StoredThread): Promise<void> {
    const pool = this.ensurePool();
    await pool.query(
      `INSERT INTO ${this.schema}.${this.tableName} (type, id, data)
       VALUES ('thread', $1, $2)
       ON CONFLICT (type, id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [id, JSON.stringify(thread)]
    );
  }

  async loadThread(id: string): Promise<StoredThread | null> {
    const pool = this.ensurePool();
    const result = await pool.query<{ data: StoredThread }>(
      `SELECT data FROM ${this.schema}.${this.tableName} WHERE type = 'thread' AND id = $1`,
      [id]
    );
    return result.rows[0]?.data ?? null;
  }

  async deleteThread(id: string): Promise<boolean> {
    const pool = this.ensurePool();
    const result = await pool.query(
      `DELETE FROM ${this.schema}.${this.tableName} WHERE type = 'thread' AND id = $1`,
      [id]
    );
    return (result as unknown as { rowCount: number }).rowCount > 0;
  }

  async listThreads(): Promise<StoredThread[]> {
    const pool = this.ensurePool();
    const result = await pool.query<{ data: StoredThread }>(
      `SELECT data FROM ${this.schema}.${this.tableName} WHERE type = 'thread'`
    );
    return result.rows.map((r) => r.data);
  }

  async saveAssistant(id: string, assistant: StoredAssistant): Promise<void> {
    const pool = this.ensurePool();
    await pool.query(
      `INSERT INTO ${this.schema}.${this.tableName} (type, id, data)
       VALUES ('assistant', $1, $2)
       ON CONFLICT (type, id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [id, JSON.stringify(assistant)]
    );
  }

  async loadAssistant(id: string): Promise<StoredAssistant | null> {
    const pool = this.ensurePool();
    const result = await pool.query<{ data: StoredAssistant }>(
      `SELECT data FROM ${this.schema}.${this.tableName} WHERE type = 'assistant' AND id = $1`,
      [id]
    );
    return result.rows[0]?.data ?? null;
  }

  async deleteAssistant(id: string): Promise<boolean> {
    const pool = this.ensurePool();
    const result = await pool.query(
      `DELETE FROM ${this.schema}.${this.tableName} WHERE type = 'assistant' AND id = $1`,
      [id]
    );
    return (result as unknown as { rowCount: number }).rowCount > 0;
  }

  async listAssistants(): Promise<StoredAssistant[]> {
    const pool = this.ensurePool();
    const result = await pool.query<{ data: StoredAssistant }>(
      `SELECT data FROM ${this.schema}.${this.tableName} WHERE type = 'assistant'`
    );
    return result.rows.map((r) => r.data);
  }

  async saveFile(id: string, file: StoredFile): Promise<void> {
    const pool = this.ensurePool();
    const serialized = {
      ...file,
      content: file.content.toString('base64'),
    };
    await pool.query(
      `INSERT INTO ${this.schema}.${this.tableName} (type, id, data)
       VALUES ('file', $1, $2)
       ON CONFLICT (type, id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [id, JSON.stringify(serialized)]
    );
  }

  async loadFile(id: string): Promise<StoredFile | null> {
    const pool = this.ensurePool();
    const result = await pool.query<{ data: { content: string } & Omit<StoredFile, 'content'> }>(
      `SELECT data FROM ${this.schema}.${this.tableName} WHERE type = 'file' AND id = $1`,
      [id]
    );
    if (!result.rows[0]) return null;
    const parsed = result.rows[0].data;
    return {
      ...parsed,
      content: Buffer.from(parsed.content, 'base64'),
    };
  }

  async deleteFile(id: string): Promise<boolean> {
    const pool = this.ensurePool();
    const result = await pool.query(
      `DELETE FROM ${this.schema}.${this.tableName} WHERE type = 'file' AND id = $1`,
      [id]
    );
    return (result as unknown as { rowCount: number }).rowCount > 0;
  }

  async listFiles(): Promise<StoredFile[]> {
    const pool = this.ensurePool();
    const result = await pool.query<{ data: { content: string } & Omit<StoredFile, 'content'> }>(
      `SELECT data FROM ${this.schema}.${this.tableName} WHERE type = 'file'`
    );
    return result.rows.map((r) => ({
      ...r.data,
      content: Buffer.from(r.data.content, 'base64'),
    }));
  }
}

/**
 * Create a thread storage based on configuration.
 *
 * @param config - Storage configuration
 * @returns Configured storage instance (not connected - call connect() if needed)
 *
 * @example
 * ```ts
 * // In-memory (default)
 * const storage = createThreadStorage();
 *
 * // Redis
 * const storage = createThreadStorage({
 *   type: 'redis',
 *   url: 'redis://localhost:6379',
 * });
 * await storage.connect();
 *
 * // PostgreSQL
 * const storage = createThreadStorage({
 *   type: 'postgres',
 *   connectionString: 'postgresql://...',
 * });
 * await storage.connect();
 * ```
 */
export function createThreadStorage(
  config?:
    | { type: 'memory' }
    | ({ type: 'redis' } & RedisThreadStorageConfig)
    | ({ type: 'postgres' } & PostgresThreadStorageConfig)
): ThreadStorage {
  if (!config || config.type === 'memory') {
    return new InMemoryThreadStorage();
  }

  if (config.type === 'redis') {
    return new RedisThreadStorage(config);
  }

  if (config.type === 'postgres') {
    return new PostgresThreadStorage(config);
  }

  return new InMemoryThreadStorage();
}
