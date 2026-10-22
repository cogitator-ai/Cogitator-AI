import { createHash } from 'node:crypto';
import type { EmbeddingService } from '@cogitator-ai/types';

export interface MockEmbeddingServiceOptions {
  /** Length of the returned vectors. Default 64. */
  dimensions?: number;
  /** The `model` the service reports. Default 'mock-embedding'. */
  model?: string;
}

export interface MockEmbeddingCall {
  method: 'embed' | 'embedBatch';
  args: unknown[];
}

/**
 * A deterministic in-process `EmbeddingService` for tests: the same text
 * always embeds to the same unit vector, and texts that share words have a
 * higher cosine similarity than texts that share none.
 *
 * Vectors come from a hashed bag of words: every word contributes the bytes
 * of its SHA-256 digest, scaled to the vector's length. `setEmbedding`
 * replaces the vector for one specific text. Every `embed` and `embedBatch`
 * call is recorded and readable through `getCalls` / `getCallsFor`.
 */
export class MockEmbeddingService implements EmbeddingService {
  readonly dimensions: number;
  readonly model: string;

  private readonly pinned = new Map<string, number[]>();
  private readonly cache = new Map<string, number[]>();
  private calls: MockEmbeddingCall[] = [];

  constructor(options?: MockEmbeddingServiceOptions) {
    this.dimensions = options?.dimensions ?? 64;
    this.model = options?.model ?? 'mock-embedding';
  }

  async embed(text: string): Promise<number[]> {
    this.calls.push({ method: 'embed', args: [text] });
    return this.vectorFor(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    this.calls.push({ method: 'embedBatch', args: [texts] });
    return texts.map((text) => this.vectorFor(text));
  }

  /** Returns exactly what `embed` returns for each item, but as one call. */
  setEmbedding(text: string, vector: number[]): void {
    this.pinned.set(text, [...vector]);
    this.cache.delete(text);
  }

  getCalls(): MockEmbeddingCall[] {
    return [...this.calls];
  }

  getCallsFor(method: 'embed' | 'embedBatch'): MockEmbeddingCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  reset(): void {
    this.pinned.clear();
    this.cache.clear();
    this.calls = [];
  }

  private vectorFor(text: string): number[] {
    const pinned = this.pinned.get(text);
    if (pinned) return [...pinned];

    const cached = this.cache.get(text);
    if (cached) return [...cached];

    const vector = this.hashBagOfWords(text);
    this.cache.set(text, vector);
    return [...vector];
  }

  /**
   * One unit vector per distinct text: each word contributes the bytes of
   * its SHA-256 digest along the vector, and the sum is normalized, so a
   * word moves every text holding it in the same direction.
   */
  private hashBagOfWords(text: string): number[] {
    const words = text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word !== '');

    const vector = new Array<number>(this.dimensions).fill(0);
    if (words.length === 0) {
      vector.fill(1 / Math.sqrt(this.dimensions));
      return vector;
    }

    for (const word of words) {
      const digest = createHash('sha256').update(word).digest();
      for (let i = 0; i < this.dimensions; i++) {
        vector[i] += digest[i % digest.length] / 255;
      }
    }

    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vector.map((v) => v / norm);
  }
}

export function createMockEmbeddingService(
  options?: MockEmbeddingServiceOptions
): MockEmbeddingService {
  return new MockEmbeddingService(options);
}
