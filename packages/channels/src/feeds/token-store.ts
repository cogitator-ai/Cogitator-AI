import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { StoredToken, TokenStore } from '@cogitator-ai/types';
import {
  createIfMissing,
  type PgClient,
  queueFor,
  type SerialQueue,
  TABLE_NAME,
  writeFileAtomic,
} from './storage';

function isStoredToken(value: unknown): value is StoredToken {
  if (typeof value !== 'object' || value === null) return false;
  const token = value as Record<string, unknown>;
  return (
    typeof token.value === 'string' &&
    typeof token.issuedAt === 'number' &&
    (token.expiresAt === undefined || typeof token.expiresAt === 'number')
  );
}

/** Tokens in memory: they are gone when the process ends. For tests and one-off scripts. */
export class MemoryTokenStore implements TokenStore {
  private readonly tokens = new Map<string, StoredToken>();

  async get(key: string): Promise<StoredToken | undefined> {
    const token = this.tokens.get(key);
    return token ? { ...token } : undefined;
  }

  async set(key: string, token: StoredToken): Promise<void> {
    this.tokens.set(key, { ...token });
  }

  async delete(key: string): Promise<void> {
    this.tokens.delete(key);
  }
}

export interface FileTokenStoreOptions {
  /** The JSON file, readable by its owner only (default `~/.cogitator/tokens.json`). */
  path?: string;
}

/**
 * Tokens in one JSON file, written atomically with owner-only permissions,
 * for a single process. Stores of one process on the same file take turns,
 * so a Bluesky session and a Threads token kept in one file never overwrite
 * each other. Several processes need `PostgresTokenStore`.
 */
export class FileTokenStore implements TokenStore {
  readonly path: string;
  private readonly queue: SerialQueue;

  constructor(options: FileTokenStoreOptions = {}) {
    this.path = options.path ?? join(homedir(), '.cogitator', 'tokens.json');
    this.queue = queueFor(this.path);
  }

  async get(key: string): Promise<StoredToken | undefined> {
    return this.queue.run(async () => (await this.read())[key]);
  }

  async set(key: string, token: StoredToken): Promise<void> {
    await this.queue.run(async () => {
      const tokens = await this.read();
      tokens[key] = { ...token };
      await writeFileAtomic(this.path, `${JSON.stringify(tokens, null, 2)}\n`);
    });
  }

  async delete(key: string): Promise<void> {
    await this.queue.run(async () => {
      const tokens = await this.read();
      if (!(key in tokens)) return;
      delete tokens[key];
      await writeFileAtomic(this.path, `${JSON.stringify(tokens, null, 2)}\n`);
    });
  }

  private async read(): Promise<Record<string, StoredToken>> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${this.path} is not a token file: expected a JSON object`);
    }
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, StoredToken] =>
        isStoredToken(entry[1])
      )
    );
  }
}

export interface PostgresTokenStoreOptions {
  client: PgClient;
  /** Table name (default `cogitator_tokens`), created on first use. */
  table?: string;
}

/** Tokens in a Postgres table, shared by every process that renews them. */
export class PostgresTokenStore implements TokenStore {
  private readonly client: PgClient;
  private readonly table: string;
  private ready?: Promise<void>;

  constructor(options: PostgresTokenStoreOptions) {
    const table = options.table ?? 'cogitator_tokens';
    if (!TABLE_NAME.test(table)) throw new Error(`Invalid token table name: ${table}`);
    this.client = options.client;
    this.table = table;
  }

  async get(key: string): Promise<StoredToken | undefined> {
    await this.ensureTable();
    const { rows } = await this.client.query(
      `SELECT value, issued_at, expires_at FROM ${this.table} WHERE key = $1`,
      [key]
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      value: String(row.value),
      issuedAt: Number(row.issued_at),
      ...(row.expires_at !== null && row.expires_at !== undefined
        ? { expiresAt: Number(row.expires_at) }
        : {}),
    };
  }

  async set(key: string, token: StoredToken): Promise<void> {
    await this.ensureTable();
    await this.client.query(
      `INSERT INTO ${this.table} (key, value, issued_at, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, issued_at = EXCLUDED.issued_at,
             expires_at = EXCLUDED.expires_at, updated_at = now()`,
      [key, token.value, token.issuedAt, token.expiresAt ?? null]
    );
  }

  async delete(key: string): Promise<void> {
    await this.ensureTable();
    await this.client.query(`DELETE FROM ${this.table} WHERE key = $1`, [key]);
  }

  private ensureTable(): Promise<void> {
    this.ready ??= createIfMissing(
      this.client,
      `CREATE TABLE IF NOT EXISTS ${this.table} (
         key text PRIMARY KEY,
         value text NOT NULL,
         issued_at bigint NOT NULL,
         expires_at bigint,
         updated_at timestamptz NOT NULL DEFAULT now()
       )`
    ).catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }
}
