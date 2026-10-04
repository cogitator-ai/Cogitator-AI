import { randomBytes } from 'node:crypto';
import { OpenAIEmbeddingService } from '@cogitator-ai/memory';
import type { EmbeddingService, OpenAIEmbeddingConfig } from '@cogitator-ai/types';
import pg from 'pg';
import { OPENROUTER_BASE_URL } from '../../llm.js';

/** A short random suffix for table, schema, key and collection names of one run. */
export function uniqueSuffix(): string {
  return randomBytes(4).toString('hex');
}

/**
 * A deterministic bag-of-words embedder (feature hashing). It needs no network, so the store
 * stages exercise vector search mechanics without depending on an embedding provider. Texts that
 * share words get a high cosine similarity, unrelated texts a low one.
 */
export class HashingEmbeddingService implements EmbeddingService {
  readonly model = 'gauntlet-hashing';

  constructor(readonly dimensions = 64) {}

  async embed(text: string): Promise<number[]> {
    return this.vector(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.vector(text));
  }

  private vector(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let hash = 2166136261;
      for (let i = 0; i < word.length; i++) {
        hash ^= word.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      vector[(hash >>> 0) % this.dimensions]! += 1;
    }
    const norm = Math.hypot(...vector) || 1;
    return vector.map((value) => value / norm);
  }
}

/** The embedding model the LLM stages use, served by OpenRouter's OpenAI-compatible API. */
export const EMBEDDING_MODEL = 'openai/text-embedding-3-small';

/**
 * Real embeddings without an OpenAI key: the memory package's OpenAI service pointed at
 * OpenRouter, which speaks the same `/embeddings` protocol. Uses the gauntlet's own key.
 */
export function openRouterEmbeddings(): OpenAIEmbeddingService {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
  return new OpenAIEmbeddingService({
    apiKey,
    baseUrl: OPENROUTER_BASE_URL,
    model: EMBEDDING_MODEL,
  });
}

/** The config section the runtime's `memory.embedding` takes for {@link openRouterEmbeddings}. */
export function openRouterEmbeddingConfig(): OpenAIEmbeddingConfig {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
  return { provider: 'openai', apiKey, baseUrl: OPENROUTER_BASE_URL, model: EMBEDDING_MODEL };
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** Runs `work` on a short-lived `pg` client. */
async function withPostgres<T>(
  connectionString: string,
  work: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

function assertIdentifier(name: string): void {
  if (!IDENTIFIER.test(name)) throw new Error(`Refusing to use ${name} as a Postgres identifier`);
}

/** Drops a Postgres schema with everything in it. */
export async function dropPostgresSchema(connectionString: string, schema: string): Promise<void> {
  assertIdentifier(schema);
  await withPostgres(connectionString, (client) =>
    client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  );
}

/** Rows of the embeddings table a Postgres memory schema holds. */
export async function countPostgresEmbeddings(
  connectionString: string,
  schema: string
): Promise<number> {
  assertIdentifier(schema);
  const { rows } = await withPostgres(connectionString, (client) =>
    client.query(`SELECT count(*)::int AS n FROM ${schema}.embeddings`)
  );
  return Number(rows[0]?.n ?? 0);
}

/** Plain text of a message content, whatever its shape. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) =>
        typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string'
          ? part.text
          : ''
      )
      .join('');
  }
  return '';
}
