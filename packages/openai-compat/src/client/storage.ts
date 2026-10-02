import type { StoredThread, StoredAssistant } from './thread-manager';
import type { FilePurpose } from '../types/openai-types';

export interface StoredFile {
  id: string;
  content: Buffer;
  filename: string;
  created_at: number;
  purpose?: FilePurpose;
}

interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  del(key: string): Promise<number>;
  scan(cursor: string | number, ...args: (string | number)[]): Promise<[string, string[]]>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  quit(): Promise<unknown>;
}

type RedisConstructor = new (options: string | { host: string; port: number }) => RedisClientLike;

interface PgPoolLike {
  query<T>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
  end(): Promise<void>;
}

type PgPoolConstructor = new (options: { connectionString: string }) => PgPoolLike;

/**
 * Load an optional peer dependency. The specifier is kept dynamic so the
 * package compiles and bundles without the peer installed.
 */
async function importOptional(specifier: string, installHint: string): Promise<unknown> {
  try {
    return (await import(specifier)) as unknown;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new Error(installHint);
    }
    throw error;
  }
}

function resolveExport<T>(module: unknown, name: string): T {
  const mod = module as Record<string, unknown> & { default?: Record<string, unknown> | T };
  const candidate =
    mod[name] ??
    (typeof mod.default === 'object' && mod.default !== null
      ? (mod.default as Record<string, unknown>)[name]
      : undefined) ??
    mod.default;
  if (typeof candidate !== 'function') {
    throw new Error(`Unexpected module shape: missing ${name}`);
  }
  return candidate as T;
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
  private client: RedisClientLike | null = null;

  private config: RedisThreadStorageConfig;
  private keyPrefix: string;
  private ttl: number;

  constructor(config: RedisThreadStorageConfig = {}) {
    this.config = config;
    this.keyPrefix = config.keyPrefix ?? 'cogitator:openai:';
    this.ttl = config.ttl ?? 86400;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    const mod = await importOptional(
      'ioredis',
      'ioredis is required for RedisThreadStorage. Install it with: npm install ioredis'
    );
    const Redis = resolveExport<RedisConstructor>(mod, 'Redis');
    this.client = new Redis(
      this.config.url ?? {
        host: this.config.host ?? 'localhost',
        port: this.config.port ?? 6379,
      }
    );
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

  private async write(key: string, value: string): Promise<void> {
    const client = this.ensureClient();
    if (this.ttl > 0) {
      await client.set(key, value, 'EX', this.ttl);
    } else {
      await client.set(key, value);
    }
  }

  private async readAll(type: string): Promise<string[]> {
    const client = this.ensureClient();
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await client.scan(
        cursor,
        'MATCH',
        `${this.keyPrefix}${type}:*`,
        'COUNT',
        200
      );
      keys.push(...batch);
      cursor = next;
    } while (cursor !== '0');

    if (keys.length === 0) return [];
    const values = await client.mget(...keys);
    return values.filter((value): value is string => value !== null);
  }

  async saveThread(id: string, thread: StoredThread): Promise<void> {
    await this.write(this.key('thread', id), JSON.stringify(thread));
  }

  async loadThread(id: string): Promise<StoredThread | null> {
    const client = this.ensureClient();
    const data = await client.get(this.key('thread', id));
    return data ? (JSON.parse(data) as StoredThread) : null;
  }

  async deleteThread(id: string): Promise<boolean> {
    const client = this.ensureClient();
    const deleted = await client.del(this.key('thread', id));
    return deleted > 0;
  }

  async listThreads(): Promise<StoredThread[]> {
    return (await this.readAll('thread')).map((data) => JSON.parse(data) as StoredThread);
  }

  async saveAssistant(id: string, assistant: StoredAssistant): Promise<void> {
    await this.write(this.key('assistant', id), JSON.stringify(assistant));
  }

  async loadAssistant(id: string): Promise<StoredAssistant | null> {
    const client = this.ensureClient();
    const data = await client.get(this.key('assistant', id));
    return data ? (JSON.parse(data) as StoredAssistant) : null;
  }

  async deleteAssistant(id: string): Promise<boolean> {
    const client = this.ensureClient();
    const deleted = await client.del(this.key('assistant', id));
    return deleted > 0;
  }

  async listAssistants(): Promise<StoredAssistant[]> {
    return (await this.readAll('assistant')).map((data) => JSON.parse(data) as StoredAssistant);
  }

  async saveFile(id: string, file: StoredFile): Promise<void> {
    const serialized = {
      ...file,
      content: file.content.toString('base64'),
    };
    await this.write(this.key('file', id), JSON.stringify(serialized));
  }

  async loadFile(id: string): Promise<StoredFile | null> {
    const client = this.ensureClient();
    const data = await client.get(this.key('file', id));
    if (!data) return null;
    const parsed = JSON.parse(data) as Omit<StoredFile, 'content'> & { content: string };
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
    return (await this.readAll('file')).map((data) => {
      const parsed = JSON.parse(data) as Omit<StoredFile, 'content'> & { content: string };
      return { ...parsed, content: Buffer.from(parsed.content, 'base64') };
    });
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
  private pool: PgPoolLike | null = null;

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
    if (this.pool) return;
    const mod = await importOptional(
      'pg',
      'pg is required for PostgresThreadStorage. Install it with: npm install pg'
    );
    const Pool = resolveExport<PgPoolConstructor>(mod, 'Pool');
    const pool = new Pool({ connectionString: this.config.connectionString });

    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${this.schema}.${this.tableName} (
          type TEXT NOT NULL,
          id TEXT NOT NULL,
          data JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (type, id)
        )
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_${this.tableName}_type
        ON ${this.schema}.${this.tableName}(type)
      `);
    } catch (err) {
      await pool.end().catch(() => {});
      throw err;
    }
    this.pool = pool;
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
    return (result.rowCount ?? 0) > 0;
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
    return (result.rowCount ?? 0) > 0;
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
    return (result.rowCount ?? 0) > 0;
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
