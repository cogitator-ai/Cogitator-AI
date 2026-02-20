import { describe, it, expect } from 'vitest';
import { createChunker } from '../chunkers/create-chunker';

describe('createChunker', () => {
  it('creates FixedSizeChunker for fixed strategy', () => {
    const chunker = createChunker({ strategy: 'fixed', chunkSize: 100, chunkOverlap: 10 });
    const chunks = chunker.chunk('hello world', 'doc-1');
    expect(chunks).toHaveLength(1);
  });

  it('creates RecursiveChunker for recursive strategy', () => {
    const chunker = createChunker({ strategy: 'recursive', chunkSize: 100, chunkOverlap: 0 });
    const chunks = chunker.chunk('hello world', 'doc-1');
    expect(chunks).toHaveLength(1);
  });

  it('passes separators to RecursiveChunker', () => {
    const chunker = createChunker({
      strategy: 'recursive',
      chunkSize: 5,
      chunkOverlap: 0,
      separators: ['---'],
    });
    const chunks = chunker.chunk('abc---def', 'doc-1');
    expect(chunks).toHaveLength(2);
  });

  it('throws for semantic without embeddingService', () => {
    expect(() => createChunker({ strategy: 'semantic', chunkSize: 100, chunkOverlap: 0 })).toThrow(
      'embeddingService'
    );
  });

  it('creates SemanticChunker when embeddingService provided', () => {
    const mockEmb = {
      embed: async () => [0],
      embedBatch: async () => [[0]],
      dimensions: 1,
      model: 'test',
    };
    const chunker = createChunker(
      { strategy: 'semantic', chunkSize: 100, chunkOverlap: 0 },
      mockEmb
    );
    expect(chunker).toBeDefined();
  });
});
