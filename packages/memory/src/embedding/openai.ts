/**
 * OpenAI Embedding Service
 */

import type { EmbeddingService, OpenAIEmbeddingConfig } from '@cogitator-ai/types';
import { fetchWithRetry } from './retry';

const DEFAULT_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

/** Models that shorten their output to the requested `dimensions`. */
const SHORTENABLE_MODEL = 'text-embedding-3';

/**
 * The native size of a known OpenAI model, also when a gateway prefixes the id with a vendor, as
 * in `openai/text-embedding-3-small`.
 */
function nativeDimensions(model: string): number | undefined {
  const known = Object.keys(DEFAULT_DIMENSIONS).find((name) => model.includes(name));
  return known === undefined ? undefined : DEFAULT_DIMENSIONS[known];
}

export class OpenAIEmbeddingService implements EmbeddingService {
  readonly model: string;
  readonly dimensions: number;
  private customDimensions: boolean;

  private apiKey: string;
  private baseUrl: string;

  constructor(config: Omit<OpenAIEmbeddingConfig, 'provider'>) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'text-embedding-3-small';
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
    this.customDimensions = config.dimensions !== undefined;
    this.dimensions = config.dimensions ?? nativeDimensions(this.model) ?? 1536;
  }

  private get supportsDimensions(): boolean {
    return this.customDimensions && this.model.includes(SHORTENABLE_MODEL);
  }

  /**
   * A configured `dimensions` is what callers size their vector columns and collections by, so a
   * response of another size fails here instead of in the store.
   */
  private checkDimensions(embedding: number[]): number[] {
    if (this.customDimensions && embedding.length !== this.dimensions) {
      throw new Error(
        `OpenAI embedding failed: ${this.model} returned ${embedding.length}-dimensional vectors, but the service is configured with dimensions ${this.dimensions}. Only text-embedding-3 models can shorten their output, for other models set dimensions to the size they return`
      );
    }
    return embedding;
  }

  async embed(text: string): Promise<number[]> {
    if (!text) {
      throw new Error('Embedding text must not be empty');
    }

    const response = await fetchWithRetry(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
        ...(this.supportsDimensions ? { dimensions: this.dimensions } : {}),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI embedding failed: ${error}`);
    }

    const data = (await response.json()) as {
      data?: { embedding?: number[] }[];
    };

    const embedding = data.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) {
      throw new Error('OpenAI embedding failed: missing embedding in response');
    }

    return this.checkDimensions(embedding);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const response = await fetchWithRetry(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        ...(this.supportsDimensions ? { dimensions: this.dimensions } : {}),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI embedding failed: ${error}`);
    }

    const data = (await response.json()) as {
      data?: { embedding?: number[]; index?: number }[];
    };

    if (!Array.isArray(data.data)) {
      throw new Error('OpenAI batch embedding failed: missing data in response');
    }

    return data.data
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((item) => {
        if (!Array.isArray(item.embedding)) {
          throw new Error('OpenAI batch embedding failed: missing embedding in response');
        }
        return this.checkDimensions(item.embedding);
      });
  }
}
