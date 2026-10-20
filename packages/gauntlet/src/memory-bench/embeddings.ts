import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { countTokens } from '@cogitator-ai/memory';
import type { EmbeddingService } from '@cogitator-ai/types';

/**
 * An embedding service that keeps every vector it computes in a SQLite file, keyed by the model
 * and the text, so a later run (another strategy, another phase) pays only for texts it has not
 * seen. `embeddedTokens` counts what reached the provider.
 */
export class CachedEmbeddingService implements EmbeddingService {
  private readonly db: Database.Database;
  private readonly read: Database.Statement<[string], { vector: Buffer }>;
  private readonly write: Database.Statement<[string, Buffer]>;
  embeddedTokens = 0;

  constructor(
    private readonly inner: EmbeddingService,
    path: string,
    private readonly batchSize = 100
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
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
    const keys = texts.map((text) => this.key(text));
    const vectors: (number[] | undefined)[] = keys.map((key) => {
      const row = this.read.get(key);
      return row ? Array.from(new Float32Array(new Uint8Array(row.vector).buffer)) : undefined;
    });
    const missing = [...new Set(texts.filter((_, i) => vectors[i] === undefined))];
    for (let start = 0; start < missing.length; start += this.batchSize) {
      const chunk = missing.slice(start, start + this.batchSize);
      const computed = await this.inner.embedBatch(chunk);
      if (computed.length !== chunk.length) {
        throw new Error(`Embedding returned ${computed.length} vectors for ${chunk.length} texts`);
      }
      this.embeddedTokens += chunk.reduce((sum, text) => sum + countTokens(text), 0);
      const store = this.db.transaction(() => {
        chunk.forEach((text, i) => {
          this.write.run(this.key(text), Buffer.from(new Float32Array(computed[i]).buffer));
        });
      });
      store();
      const byText = new Map(chunk.map((text, i) => [text, computed[i]]));
      texts.forEach((text, i) => {
        vectors[i] ??= byText.get(text);
      });
    }
    return vectors.map((vector, i) => {
      if (!vector) throw new Error(`No embedding for text ${i}`);
      return vector;
    });
  }

  close(): void {
    this.db.close();
  }

  private key(text: string): string {
    return createHash('sha256').update(this.inner.model).update('\0').update(text).digest('hex');
  }
}
