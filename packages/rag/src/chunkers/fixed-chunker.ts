import { nanoid } from 'nanoid';
import type { Chunker, DocumentChunk } from '@cogitator-ai/types';

export interface FixedSizeChunkerOptions {
  chunkSize: number;
  chunkOverlap: number;
}

export class FixedSizeChunker implements Chunker {
  private readonly chunkSize: number;
  private readonly chunkOverlap: number;

  constructor(options: FixedSizeChunkerOptions) {
    if (options.chunkSize <= 0) {
      throw new Error('chunkSize must be a positive number');
    }
    if (options.chunkOverlap < 0) {
      throw new Error('chunkOverlap must be non-negative');
    }
    if (options.chunkOverlap >= options.chunkSize) {
      throw new Error('chunkOverlap must be less than chunkSize');
    }
    this.chunkSize = options.chunkSize;
    this.chunkOverlap = options.chunkOverlap;
  }

  chunk(text: string, documentId: string): DocumentChunk[] {
    if (text.length === 0) return [];

    const step = this.chunkSize - this.chunkOverlap;
    const chunks: DocumentChunk[] = [];
    let order = 0;

    for (let start = 0; start < text.length; start += step) {
      const end = Math.min(start + this.chunkSize, text.length);
      chunks.push({
        id: nanoid(),
        documentId,
        content: text.slice(start, end),
        startOffset: start,
        endOffset: end,
        order: order++,
      });

      if (end === text.length) break;
    }

    return chunks;
  }
}
