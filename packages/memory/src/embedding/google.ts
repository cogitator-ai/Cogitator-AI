/**
 * Google AI Embedding Service
 * Uses Gemini gemini-embedding-001 model
 */

import type { EmbeddingService, GoogleEmbeddingConfig } from '@cogitator-ai/types';
import { fetchWithRetry } from './retry';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const BATCH_LIMIT = 100;

export class GoogleEmbeddingService implements EmbeddingService {
  readonly model: string;
  readonly dimensions: number;
  private customDimensions: boolean;

  private apiKey: string;
  private baseUrl: string;

  constructor(config: Omit<GoogleEmbeddingConfig, 'provider'>) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'gemini-embedding-001';
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.dimensions = config.dimensions ?? 3072;
    this.customDimensions = config.dimensions !== undefined;
  }

  async embed(text: string): Promise<number[]> {
    if (!text) {
      throw new Error('Embedding text must not be empty');
    }

    const response = await fetchWithRetry(`${this.baseUrl}/models/${this.model}:embedContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
        ...(this.customDimensions ? { outputDimensionality: this.dimensions } : {}),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Google embedding failed: ${error}`);
    }

    const data = (await response.json()) as {
      embedding?: { values?: number[] };
    };

    const values = data.embedding?.values;
    if (!Array.isArray(values)) {
      throw new Error('Google embedding failed: missing embedding in response');
    }

    return values;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const chunks: string[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_LIMIT) {
      chunks.push(texts.slice(i, i + BATCH_LIMIT));
    }

    const results = await Promise.all(chunks.map((chunk) => this.embedChunk(chunk)));

    return results.flat();
  }

  private async embedChunk(texts: string[]): Promise<number[][]> {
    const response = await fetchWithRetry(
      `${this.baseUrl}/models/${this.model}:batchEmbedContents`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
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
      embeddings?: { values?: number[] }[];
    };

    if (!Array.isArray(data.embeddings)) {
      throw new Error('Google batch embedding failed: missing embeddings in response');
    }

    return data.embeddings.map((entry) => {
      if (!Array.isArray(entry.values)) {
        throw new Error('Google batch embedding failed: missing values in response');
      }
      return entry.values;
    });
  }
}
