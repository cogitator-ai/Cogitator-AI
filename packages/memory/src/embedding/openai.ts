/**
 * OpenAI Embedding Service
 */

import type { EmbeddingService, OpenAIEmbeddingConfig } from '@cogitator-ai/types';

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

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
        ...(this.customDimensions ? { dimensions: this.dimensions } : {}),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI embedding failed: ${error}`);
    }

    const data = (await response.json()) as {
      data: { embedding: number[] }[];
    };

    return data.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        ...(this.customDimensions ? { dimensions: this.dimensions } : {}),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI embedding failed: ${error}`);
    }

    const data = (await response.json()) as {
      data: { embedding: number[]; index: number }[];
    };

    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
