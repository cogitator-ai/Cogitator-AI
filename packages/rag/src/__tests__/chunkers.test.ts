import { describe, it, expect } from 'vitest';
import { FixedSizeChunker } from '../chunkers/fixed-chunker';

describe('FixedSizeChunker', () => {
  it('splits text into fixed-size chunks', () => {
    const chunker = new FixedSizeChunker({ chunkSize: 10, chunkOverlap: 0 });
    const chunks = chunker.chunk('abcdefghijklmnopqrstuvwxyz', 'doc-1');
    expect(chunks.length).toBe(3);
    expect(chunks[0].content).toBe('abcdefghij');
    expect(chunks[1].content).toBe('klmnopqrst');
    expect(chunks[2].content).toBe('uvwxyz');
  });

  it('handles overlap correctly', () => {
    const chunker = new FixedSizeChunker({ chunkSize: 10, chunkOverlap: 3 });
    const chunks = chunker.chunk('abcdefghijklmnopqrstuvwxyz', 'doc-1');
    expect(chunks[0].content).toBe('abcdefghij');
    expect(chunks[1].content.startsWith('hij')).toBe(true);
    expect(chunks[1].content.length).toBe(10);
  });

  it('assigns sequential order', () => {
    const chunker = new FixedSizeChunker({ chunkSize: 5, chunkOverlap: 0 });
    const chunks = chunker.chunk('abcdefghijklmno', 'doc-1');
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].order).toBe(i);
    }
  });

  it('returns single chunk for short text', () => {
    const chunker = new FixedSizeChunker({ chunkSize: 100, chunkOverlap: 0 });
    const chunks = chunker.chunk('Short', 'doc-1');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('Short');
  });

  it('preserves character offsets', () => {
    const text = 'Hello World this is a test string';
    const chunker = new FixedSizeChunker({ chunkSize: 11, chunkOverlap: 0 });
    const chunks = chunker.chunk(text, 'doc-1');
    for (const chunk of chunks) {
      expect(text.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.content);
    }
  });

  it('sets documentId on all chunks', () => {
    const chunker = new FixedSizeChunker({ chunkSize: 5, chunkOverlap: 0 });
    const chunks = chunker.chunk('abcdefghij', 'my-doc');
    for (const chunk of chunks) {
      expect(chunk.documentId).toBe('my-doc');
    }
  });

  it('generates unique ids for each chunk', () => {
    const chunker = new FixedSizeChunker({ chunkSize: 5, chunkOverlap: 0 });
    const chunks = chunker.chunk('abcdefghij', 'doc-1');
    const ids = chunks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns empty array for empty string', () => {
    const chunker = new FixedSizeChunker({ chunkSize: 10, chunkOverlap: 0 });
    expect(chunker.chunk('', 'doc-1')).toEqual([]);
  });

  it('throws when chunkOverlap >= chunkSize', () => {
    expect(() => new FixedSizeChunker({ chunkSize: 10, chunkOverlap: 10 })).toThrow(
      'chunkOverlap must be less than chunkSize'
    );
    expect(() => new FixedSizeChunker({ chunkSize: 5, chunkOverlap: 8 })).toThrow(
      'chunkOverlap must be less than chunkSize'
    );
  });

  it('throws when chunkSize is zero or negative', () => {
    expect(() => new FixedSizeChunker({ chunkSize: 0, chunkOverlap: 0 })).toThrow(
      'chunkSize must be a positive number'
    );
    expect(() => new FixedSizeChunker({ chunkSize: -1, chunkOverlap: 0 })).toThrow(
      'chunkSize must be a positive number'
    );
  });

  it('throws when chunkOverlap is negative', () => {
    expect(() => new FixedSizeChunker({ chunkSize: 10, chunkOverlap: -1 })).toThrow(
      'chunkOverlap must be non-negative'
    );
  });
});
