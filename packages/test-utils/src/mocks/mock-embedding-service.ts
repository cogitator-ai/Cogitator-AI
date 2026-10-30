import { createHash } from 'node:crypto';
import type { EmbeddingService } from '@cogitator-ai/types';

/** Bytes in one SHA-256 digest, i.e. the components one hash can fill. */
const DIGEST_BYTES = 32;

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
    const dimensions = options?.dimensions ?? 64;
    if (!Number.isInteger(dimensions) || dimensions < 1) {
      throw new Error(`dimensions must be a positive integer, got ${dimensions}`);
    }
    this.dimensions = dimensions;
    this.model = options?.model ?? 'mock-embedding';
  }

  async embed(text: string): Promise<number[]> {
    this.calls.push({ method: 'embed', args: [text] });
    return this.vectorFor(text);
  }

  /** Returns exactly what `embed` returns for each item, but as one call. */
  async embedBatch(texts: string[]): Promise<number[][]> {
    this.calls.push({ method: 'embedBatch', args: [texts] });
    return texts.map((text) => this.vectorFor(text));
  }

  setEmbedding(text: string, vector: number[]): void {
    if (vector.length !== this.dimensions) {
      throw new Error(
        `setEmbedding expected ${this.dimensions} dimensions, got ${vector.length}`
      );
    }
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
   * One unit vector per distinct text: each word contributes signed bytes of
   * its SHA-256 digest along the vector, and the sum is normalized, so a word
   * moves every text holding it in the same direction.
   *
   * Components are signed (`byte / 127.5 - 1`), so unrelated texts sit near a
   * cosine of 0 instead of all crowding into the positive orthant. A vector
   * longer than the 32 bytes of a digest re-hashes the word once per block of
   * 32 dimensions, so every dimension gets its own value.
   */
  private hashBagOfWords(text: string): number[] {
    const words = text
      .normalize('NFC')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word !== '');

    const vector = new Array<number>(this.dimensions).fill(0);
    if (words.length === 0) {
      vector.fill(1 / Math.sqrt(this.dimensions));
      return vector;
    }

    for (const word of words) {
      for (let block = 0; block * DIGEST_BYTES < this.dimensions; block++) {
        const digest = createHash('sha256')
          .update(block === 0 ? word : `${block}:${word}`)
          .digest();
        const start = block * DIGEST_BYTES;
        const end = Math.min(start + DIGEST_BYTES, this.dimensions);
        for (let i = start; i < end; i++) {
          vector[i] += digest[i - start] / 127.5 - 1;
        }
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
