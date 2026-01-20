import { z } from 'zod';
import { tool } from '../tool';

const vectorSearchParams = z.object({
  query: z.string().min(1).describe('Search query (will be converted to embedding)'),
  collection: z.string().optional().describe('Collection/table name (default: "documents")'),
  topK: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Number of results to return (default: 5)'),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Minimum similarity threshold 0-1 (default: 0.7)'),
  filter: z.record(z.unknown()).optional().describe('Metadata filter as key-value pairs'),
  embeddingProvider: z
    .enum(['openai', 'ollama', 'google'])
    .optional()
    .describe('Embedding provider (auto-detects from API keys)'),
  embeddingModel: z.string().optional().describe('Embedding model (defaults vary by provider)'),
  connectionString: z
    .string()
    .optional()
    .describe('PostgreSQL connection string with pgvector. Defaults to DATABASE_URL env var.'),
});

export interface VectorSearchResult {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
}

export interface VectorSearchResponse {
  query: string;
  results: VectorSearchResult[];
  provider: string;
  model: string;
}

async function getEmbedding(
  text: string,
  provider: 'openai' | 'ollama' | 'google',
  model?: string
): Promise<number[]> {
  switch (provider) {
    case 'openai': {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('OPENAI_API_KEY not set');

      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          input: text,
          model: model ?? 'text-embedding-3-small',
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenAI embedding error: ${err}`);
      }

      const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
      return data.data[0].embedding;
    }

    case 'ollama': {
      const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
      const response = await fetch(`${baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model ?? 'nomic-embed-text',
          prompt: text,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Ollama embedding error: ${err}`);
      }

      const data = (await response.json()) as { embedding: number[] };
      return data.embedding;
    }

    case 'google': {
      const apiKey = process.env.GOOGLE_API_KEY;
      if (!apiKey) throw new Error('GOOGLE_API_KEY not set');

      const modelId = model ?? 'text-embedding-004';
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:embedContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: `models/${modelId}`,
            content: { parts: [{ text }] },
          }),
        }
      );

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Google embedding error: ${err}`);
      }

      const data = (await response.json()) as { embedding: { values: number[] } };
      return data.embedding.values;
    }
  }
}

function detectEmbeddingProvider(): 'openai' | 'ollama' | 'google' | null {
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST) return 'ollama';
  if (process.env.GOOGLE_API_KEY) return 'google';
  return null;
}

async function searchPgVector(
  connectionString: string,
  embedding: number[],
  collection: string,
  topK: number,
  threshold: number,
  filter?: Record<string, unknown>
): Promise<VectorSearchResult[]> {
  let pg: typeof import('pg');
  try {
    pg = await import('pg');
  } catch {
    throw new Error('pg package not installed. Run: pnpm add pg');
  }

  const client = new pg.default.Client({ connectionString });

  try {
    await client.connect();

    const vectorStr = `[${embedding.join(',')}]`;

    let filterClause = '';
    const params: unknown[] = [vectorStr, topK];

    if (filter && Object.keys(filter).length > 0) {
      const conditions = Object.entries(filter).map(([key, value], idx) => {
        params.push(JSON.stringify({ [key]: value }));
        return `metadata @> $${idx + 3}::jsonb`;
      });
      filterClause = `AND ${conditions.join(' AND ')}`;
    }

    const query = `
      SELECT
        id,
        content,
        metadata,
        1 - (embedding <=> $1::vector) as similarity
      FROM ${collection}
      WHERE 1 - (embedding <=> $1::vector) >= ${threshold}
      ${filterClause}
      ORDER BY embedding <=> $1::vector
      LIMIT $2
    `;

    const result = await client.query(query, params);

    return result.rows.map((row) => ({
      id: String(row.id),
      content: String(row.content ?? ''),
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      similarity: Number(row.similarity),
    }));
  } finally {
    await client.end();
  }
}

export const vectorSearch = tool({
  name: 'vector_search',
  description:
    'Perform semantic search using vector embeddings. Searches a PostgreSQL database with pgvector extension. Converts query to embedding and finds similar documents.',
  parameters: vectorSearchParams,
  category: 'database',
  tags: ['search', 'vector', 'embedding', 'semantic', 'similarity'],
  execute: async ({
    query,
    collection = 'documents',
    topK = 5,
    threshold = 0.7,
    filter,
    embeddingProvider,
    embeddingModel,
    connectionString,
  }) => {
    const provider = embeddingProvider ?? detectEmbeddingProvider();
    if (!provider) {
      return {
        error:
          'No embedding provider detected. Set OPENAI_API_KEY, GOOGLE_API_KEY, or OLLAMA_BASE_URL.',
      };
    }

    const connStr = connectionString ?? process.env.DATABASE_URL;
    if (!connStr) {
      return {
        error:
          'No database connection string. Set DATABASE_URL or pass connectionString parameter.',
      };
    }

    try {
      const embedding = await getEmbedding(query, provider, embeddingModel);

      const results = await searchPgVector(connStr, embedding, collection, topK, threshold, filter);

      const response: VectorSearchResponse = {
        query,
        results,
        provider,
        model: embeddingModel ?? getDefaultModel(provider),
      };

      return response;
    } catch (err) {
      return { error: (err as Error).message, query };
    }
  },
});

function getDefaultModel(provider: 'openai' | 'ollama' | 'google'): string {
  switch (provider) {
    case 'openai':
      return 'text-embedding-3-small';
    case 'ollama':
      return 'nomic-embed-text';
    case 'google':
      return 'text-embedding-004';
  }
}
