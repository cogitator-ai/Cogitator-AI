import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { countTokens } from '@cogitator-ai/memory';
import type { EmbeddingService } from '@cogitator-ai/types';

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
