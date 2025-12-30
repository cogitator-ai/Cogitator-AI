/**
 * Ollama Embedding Service
 *
 * Supports local embedding models like:
 * - nomic-embed-text (768 dimensions)
 * - nomic-embed-text-v2-moe (768 dimensions)
 * - mxbai-embed-large (1024 dimensions)
 * - all-minilm (384 dimensions)
 */

import type { EmbeddingService, OllamaEmbeddingConfig } from '@cogitator/types';

// Known model dimensions
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

    // Get dimensions from known models or default to 768
    this.dimensions = MODEL_DIMENSIONS[this.model] ?? 768;
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
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
      embeddings: number[][];
    };

    return data.embeddings[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
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
      embeddings: number[][];
    };

    return data.embeddings;
  }
}
