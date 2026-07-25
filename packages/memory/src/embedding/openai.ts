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
    this.dimensions = config.dimensions ?? DEFAULT_DIMENSIONS[this.model] ?? 1536;
  }

  private get supportsDimensions(): boolean {
    return this.customDimensions && this.model.startsWith('text-embedding-3');
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

    return embedding;
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
        return item.embedding;
      });
  }
}
