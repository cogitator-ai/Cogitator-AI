import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { countTokens, GoogleEmbeddingService, OpenAIEmbeddingService } from '@cogitator-ai/memory';
import type { EmbeddingService } from '@cogitator-ai/types';
import { OPENROUTER_BASE_URL } from '../llm.js';

/** The model every run embeds with, whichever provider serves it */
export const EMBEDDING_MODEL = 'gemini-embedding-001';
export const EMBEDDING_DIMENSIONS = 3072;

export const EMBEDDING_PROVIDERS = ['google', 'openrouter'] as const;
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];

/** The variable that holds each provider's key */
export const EMBEDDING_KEYS: Record<EmbeddingProvider, string> = {
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

/**
 * The provider `--embeddings` names, or by default Google when its key is set and OpenRouter
 * otherwise. `undefined` for a name that is no provider.
 */
export function embeddingProvider(
  name: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): EmbeddingProvider | undefined {
  if (name === undefined) return env[EMBEDDING_KEYS.google] ? 'google' : 'openrouter';
  return EMBEDDING_PROVIDERS.find((provider) => provider === name);
}

/**
 * `gemini-embedding-001` from Google's API or through OpenRouter, which returns the same vectors.
 * The service names the model, not the route, so both share the cache and a run can switch
 * providers midway.
 */
export class BenchEmbeddingService implements EmbeddingService {
  readonly model = EMBEDDING_MODEL;
  readonly dimensions = EMBEDDING_DIMENSIONS;
  private readonly inner: EmbeddingService;

  constructor(
    readonly provider: EmbeddingProvider,
    apiKey: string
  ) {
    this.inner =
      provider === 'google'
        ? new GoogleEmbeddingService({ apiKey, model: EMBEDDING_MODEL })
        : new OpenAIEmbeddingService({
            apiKey,
            baseUrl: OPENROUTER_BASE_URL,
            model: `google/${EMBEDDING_MODEL}`,
            dimensions: EMBEDDING_DIMENSIONS,
          });
  }

  embed(text: string): Promise<number[]> {
    return this.inner.embed(text);
  }

  embedBatch(texts: string[]): Promise<number[][]> {
    return this.inner.embedBatch(texts);
  }
}

interface Deferred {
  promise: Promise<number[]>;
  resolve(vector: number[]): void;
  reject(error: unknown): void;
}

function deferred(): Deferred {
  let resolve!: (vector: number[]) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<number[]>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/**
 * An embedding service that keeps every vector it computes in a SQLite file, keyed by the model
 * and the text, so a later run (another strategy, another phase) pays only for texts it has not
 * seen. A text already on its way to the provider is not sent again by a concurrent call.
 * `embeddedTokens` counts what reached the provider.
 */
export class CachedEmbeddingService implements EmbeddingService {
  private readonly db: Database.Database;
  private readonly read: Database.Statement<[string], { vector: Buffer }>;
  private readonly write: Database.Statement<[string, Buffer]>;
  private readonly inFlight = new Map<string, Promise<number[]>>();
  embeddedTokens = 0;

  /**
   * `onMiss` is told the tokens of each request about to reach the provider, and can refuse it by
   * throwing (a budget that ran out).
   */
  constructor(
    private readonly inner: EmbeddingService,
    path: string,
    private readonly onMiss?: (tokens: number) => void,
    private readonly batchSize = 100
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec('CREATE TABLE IF NOT EXISTS vectors (key TEXT PRIMARY KEY, vector BLOB NOT NULL)');
    this.read = this.db.prepare('SELECT vector FROM vectors WHERE key = ?');
    this.write = this.db.prepare('INSERT OR REPLACE INTO vectors (key, vector) VALUES (?, ?)');
  }

  get model(): string {
    return this.inner.model;
  }

  get dimensions(): number {
    return this.inner.dimensions;
  }

  async embed(text: string): Promise<number[]> {
    const [vector] = await this.embedBatch([text]);
    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: Promise<number[]>[] = [];
    const misses: { text: string; key: string; vector: Deferred }[] = [];
    for (const text of texts) {
      const key = this.key(text);
      const row = this.read.get(key);
      if (row) {
        results.push(
          Promise.resolve(Array.from(new Float32Array(new Uint8Array(row.vector).buffer)))
        );
        continue;
      }
      const pending = this.inFlight.get(key);
      if (pending) {
        results.push(pending);
        continue;
      }
      const vector = deferred();
      this.inFlight.set(key, vector.promise);
      misses.push({ text, key, vector });
      results.push(vector.promise);
    }
    for (let start = 0; start < misses.length; start += this.batchSize) {
      const chunk = misses.slice(start, start + this.batchSize);
      try {
        const tokens = chunk.reduce((sum, miss) => sum + countTokens(miss.text), 0);
        this.onMiss?.(tokens);
        const computed = await this.inner.embedBatch(chunk.map((miss) => miss.text));
        if (computed.length !== chunk.length) {
          throw new Error(
            `Embedding returned ${computed.length} vectors for ${chunk.length} texts`
          );
        }
        this.embeddedTokens += tokens;
        this.db.transaction(() => {
          chunk.forEach((miss, i) => {
            this.write.run(miss.key, Buffer.from(new Float32Array(computed[i]).buffer));
          });
        })();
        chunk.forEach((miss, i) => miss.vector.resolve(computed[i]));
      } catch (error) {
        for (const miss of misses.slice(start)) miss.vector.reject(error);
        break;
      } finally {
        for (const miss of chunk) this.inFlight.delete(miss.key);
      }
    }
    for (const miss of misses) this.inFlight.delete(miss.key);
    return Promise.all(results);
  }

  close(): void {
    this.db.close();
  }

  private key(text: string): string {
    return createHash('sha256')
      .update(`${this.inner.model}\0${this.inner.dimensions}\0`)
      .update(text)
      .digest('hex');
  }
}

/** Waits before each retry of a rate-limited embedding request: the provider's quota is per minute. */
const RATE_LIMIT_WAITS_MS = [15_000, 30_000, 60_000, 60_000, 60_000];

const isRateLimit = (error: unknown): boolean =>
  error instanceof Error && /\b429\b|RESOURCE_EXHAUSTED/.test(error.message);

/**
 * An embedding service that waits out the provider's per-minute rate limit: the service's own
 * retries back off for seconds, while a quota spent for the minute needs up to a minute.
 */
export class RateLimitedEmbeddingService implements EmbeddingService {
  constructor(
    private readonly inner: EmbeddingService,
    private readonly waitsMs: readonly number[] = RATE_LIMIT_WAITS_MS
  ) {}

  get model(): string {
    return this.inner.model;
  }

  get dimensions(): number {
    return this.inner.dimensions;
  }

  embed(text: string): Promise<number[]> {
    return this.retry(() => this.inner.embed(text));
  }

  embedBatch(texts: string[]): Promise<number[][]> {
    return this.retry(() => this.inner.embedBatch(texts));
  }

  private async retry<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        const wait = this.waitsMs[attempt];
        if (wait === undefined || !isRateLimit(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }
}
