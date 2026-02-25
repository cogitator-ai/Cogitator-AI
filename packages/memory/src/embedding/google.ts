/**
 * Google AI Embedding Service
 * Uses Gemini gemini-embedding-001 model
 */

import type { EmbeddingService, GoogleEmbeddingConfig } from '@cogitator-ai/types';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export class GoogleEmbeddingService implements EmbeddingService {
  readonly model: string;
  readonly dimensions: number;
  private customDimensions: boolean;

  private apiKey: string;

  constructor(config: Omit<GoogleEmbeddingConfig, 'provider'>) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'gemini-embedding-001';
    this.dimensions = config.dimensions ?? 3072;
    this.customDimensions = config.dimensions !== undefined;
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(
      `${BASE_URL}/models/${this.model}:embedContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `models/${this.model}`,
          content: { parts: [{ text }] },
          ...(this.customDimensions ? { outputDimensionality: this.dimensions } : {}),
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Google embedding failed: ${error}`);
    }

    const data = (await response.json()) as {
      embedding: { values: number[] };
    };

    return data.embedding.values;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(
      `${BASE_URL}/models/${this.model}:batchEmbedContents?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: `models/${this.model}`,
            content: { parts: [{ text }] },
            ...(this.customDimensions ? { outputDimensionality: this.dimensions } : {}),
          })),
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Google batch embedding failed: ${error}`);
    }

    const data = (await response.json()) as {
      embeddings: { values: number[] }[];
    };

    return data.embeddings.map((e) => e.values);
  }
}
