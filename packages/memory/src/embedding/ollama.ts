/**
 * Ollama Embedding Service
 *
 * Supports local embedding models like:
 * - nomic-embed-text (768 dimensions)
 * - nomic-embed-text-v2-moe (768 dimensions)
 * - mxbai-embed-large (1024 dimensions)
 * - all-minilm (384 dimensions)
 */

import type { EmbeddingService, OllamaEmbeddingConfig } from '@cogitator-ai/types';
import { fetchWithRetry } from './retry';

const MODEL_DIMENSIONS: Record<string, number> = {
  'nomic-embed-text': 768,
  'nomic-embed-text-v2-moe': 768,
  'mxbai-embed-large': 1024,
  'all-minilm': 384,
  'snowflake-arctic-embed': 1024,
};

export class OllamaEmbeddingService implements EmbeddingService {
  readonly model: string;
  readonly dimensions: number;

  private baseUrl: string;

  constructor(config: Omit<OllamaEmbeddingConfig, 'provider'> = {}) {
    this.model = config.model ?? 'nomic-embed-text';
    this.baseUrl = config.baseUrl ?? 'http://localhost:11434';
    this.dimensions = config.dimensions ?? MODEL_DIMENSIONS[this.model] ?? 768;
  }

  async embed(text: string): Promise<number[]> {
    if (!text) {
      throw new Error('Embedding text must not be empty');
    }

    const response = await fetchWithRetry(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama embedding failed: ${error}`);
    }

    const data = (await response.json()) as {
      embeddings?: number[][];
    };

    const embedding = data.embeddings?.[0];
    if (!Array.isArray(embedding)) {
      throw new Error('Ollama embedding failed: missing embedding in response');
    }

    return embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const response = await fetchWithRetry(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama embedding failed: ${error}`);
    }

    const data = (await response.json()) as {
      embeddings?: number[][];
    };

    if (!Array.isArray(data.embeddings)) {
      throw new Error('Ollama batch embedding failed: missing embeddings in response');
    }

    return data.embeddings;
  }
}
