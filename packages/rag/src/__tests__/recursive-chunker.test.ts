import { describe, it, expect } from 'vitest';
import { RecursiveChunker } from '../chunkers/recursive-chunker';

describe('RecursiveChunker', () => {
  it('splits by paragraphs first', () => {
    const text = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.';
    const chunker = new RecursiveChunker({ chunkSize: 20, chunkOverlap: 0 });
    const chunks = chunker.chunk(text, 'doc-1');
    expect(chunks.length).toBe(3);
    expect(chunks[0].content).toBe('Paragraph one.');
    expect(chunks[1].content).toBe('Paragraph two.');
  });

  it('merges small pieces into a single chunk', () => {
    const text = 'Short.\n\nAlso short.\n\nTiny.';
    const chunker = new RecursiveChunker({ chunkSize: 100, chunkOverlap: 0 });
    const chunks = chunker.chunk(text, 'doc-1');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(text);
  });

  it('falls back to sentence splitting for long paragraphs', () => {
    const text = 'First sentence. Second sentence. Third sentence. Fourth sentence.';
    const chunker = new RecursiveChunker({ chunkSize: 35, chunkOverlap: 0 });
    const chunks = chunker.chunk(text, 'doc-1');
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(35);
    }
  });

  it('preserves overlap between chunks', () => {
    const text = 'Paragraph one is here.\n\nParagraph two is here.\n\nParagraph three is here.';
    const chunker = new RecursiveChunker({ chunkSize: 30, chunkOverlap: 10 });
    const chunks = chunker.chunk(text, 'doc-1');
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('uses custom separators', () => {
    const text = 'section1---section2---section3';
    const chunker = new RecursiveChunker({
      chunkSize: 15,
      chunkOverlap: 0,
      separators: ['---'],
    });
    const chunks = chunker.chunk(text, 'doc-1');
    expect(chunks.length).toBe(3);
  });

  it('assigns sequential order and unique ids', () => {
    const text = 'A.\n\nB.\n\nC.\n\nD.';
    const chunker = new RecursiveChunker({ chunkSize: 5, chunkOverlap: 0 });
    const chunks = chunker.chunk(text, 'doc-1');
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].order).toBe(i);
      expect(chunks[i].documentId).toBe('doc-1');
    }
    const ids = new Set(chunks.map((c) => c.id));
    expect(ids.size).toBe(chunks.length);
  });

  it('handles text shorter than chunkSize', () => {
    const chunker = new RecursiveChunker({ chunkSize: 1000, chunkOverlap: 0 });
    const chunks = chunker.chunk('Short text', 'doc-1');
    expect(chunks).toHaveLength(1);
  });

  it('returns empty array for empty string', () => {
    const chunker = new RecursiveChunker({ chunkSize: 100, chunkOverlap: 0 });
    expect(chunker.chunk('', 'doc-1')).toEqual([]);
  });
});
