import { describe, it, expect, vi } from 'vitest';
import { SemanticChunker } from '../chunkers/semantic-chunker';
import type { EmbeddingService } from '@cogitator-ai/types';

function createMockEmbedding(embeddings: number[][]): EmbeddingService {
  let callIndex = 0;
  return {
    embed: vi.fn(async () => embeddings[callIndex++] ?? [0, 0, 0]),
    embedBatch: vi.fn(async (texts: string[]) =>
      texts.map(() => embeddings[callIndex++] ?? [0, 0, 0])
    ),
    dimensions: 3,
    model: 'test-model',
  };
}

describe('SemanticChunker', () => {
  it('splits at semantic boundaries', async () => {
    const mockEmb = createMockEmbedding([
      [1, 0, 0],
      [0.9, 0.1, 0],
      [0, 0, 1],
      [0.1, 0, 0.9],
    ]);
    const chunker = new SemanticChunker({
      embeddingService: mockEmb,
      breakpointThreshold: 0.7,
      minChunkSize: 1,
    });
    const text = 'Cats are great. Dogs are also pets. Space is vast. Stars are bright.';
    const chunks = await chunker.chunk(text, 'doc-1');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('returns single chunk when all sentences are similar', async () => {
    const mockEmb = createMockEmbedding([
      [1, 0, 0],
      [0.99, 0.01, 0],
      [0.98, 0.02, 0],
    ]);
    const chunker = new SemanticChunker({
      embeddingService: mockEmb,
      breakpointThreshold: 0.5,
    });
    const chunks = await chunker.chunk('A. B. C.', 'doc-1');
    expect(chunks).toHaveLength(1);
  });

  it('assigns ids, order, and documentId', async () => {
    const mockEmb = createMockEmbedding([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    const chunker = new SemanticChunker({
      embeddingService: mockEmb,
      breakpointThreshold: 0.9,
      minChunkSize: 1,
    });
    const chunks = await chunker.chunk('Topic one here. Totally different topic.', 'doc-1');
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].order).toBe(i);
      expect(chunks[i].documentId).toBe('doc-1');
      expect(chunks[i].id).toBeDefined();
    }
  });

  it('handles empty text', async () => {
    const mockEmb = createMockEmbedding([]);
    const chunker = new SemanticChunker({ embeddingService: mockEmb });
    const chunks = await chunker.chunk('', 'doc-1');
    expect(chunks).toEqual([]);
  });

  it('handles single sentence', async () => {
    const mockEmb = createMockEmbedding([[1, 0, 0]]);
    const chunker = new SemanticChunker({ embeddingService: mockEmb });
    const chunks = await chunker.chunk('Just one sentence.', 'doc-1');
    expect(chunks).toHaveLength(1);
  });

  it('respects maxChunkSize by splitting large chunks', async () => {
    const longSentence1 = 'A'.repeat(60) + '.';
    const longSentence2 = 'B'.repeat(60) + '.';
    const mockEmb = createMockEmbedding([
      [1, 0, 0],
      [0.99, 0.01, 0],
    ]);
    const chunker = new SemanticChunker({
      embeddingService: mockEmb,
      maxChunkSize: 80,
    });
    const chunks = await chunker.chunk(`${longSentence1} ${longSentence2}`, 'doc-1');
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(80);
    }
  });

  it('merges small chunks to respect minChunkSize', async () => {
    const mockEmb = createMockEmbedding([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    const chunker = new SemanticChunker({
      embeddingService: mockEmb,
      breakpointThreshold: 0.9,
      minChunkSize: 200,
    });
    const chunks = await chunker.chunk('Short A. Short B. Short C.', 'doc-1');
    expect(chunks).toHaveLength(1);
  });

  it('generates unique ids', async () => {
    const mockEmb = createMockEmbedding([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    const chunker = new SemanticChunker({
      embeddingService: mockEmb,
      breakpointThreshold: 0.9,
      minChunkSize: 1,
    });
    const chunks = await chunker.chunk('First topic. Second topic. Third topic.', 'doc-1');
    const ids = chunks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
