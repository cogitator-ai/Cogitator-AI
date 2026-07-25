import { nanoid } from 'nanoid';
import type { Chunker, DocumentChunk } from '@cogitator-ai/types';

const DEFAULT_SEPARATORS = ['\n\n', '\n', '. ', ' ', ''];

export interface RecursiveChunkerOptions {
  chunkSize: number;
  chunkOverlap: number;
  separators?: string[];
}

export class RecursiveChunker implements Chunker {
  private readonly chunkSize: number;
  private readonly chunkOverlap: number;
  private readonly separators: string[];

  constructor(options: RecursiveChunkerOptions) {
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
    this.separators = options.separators ?? DEFAULT_SEPARATORS;
  }

  chunk(text: string, documentId: string): DocumentChunk[] {
    if (text.length === 0) return [];

    const pieces = this.splitText(text, 0);

    const piecePositions = this.mapPiecePositions(pieces, text);

    return this.mergePieces(pieces, piecePositions, text, documentId);
  }

  private mapPiecePositions(
    pieces: string[],
    originalText: string
  ): Array<{ start: number; end: number }> {
    const positions: Array<{ start: number; end: number }> = [];
    let searchFrom = 0;

    for (const piece of pieces) {
      const idx = originalText.indexOf(piece, searchFrom);
      const start = idx >= 0 ? idx : searchFrom;
      positions.push({ start, end: start + piece.length });
      searchFrom = start + piece.length;
    }

    return positions;
  }

  private mergePieces(
    pieces: string[],
    positions: Array<{ start: number; end: number }>,
    originalText: string,
    documentId: string
  ): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    let order = 0;
    let i = 0;

    while (i < pieces.length) {
      const chunkStart = positions[i].start;

      let j = i + 1;
      while (j < pieces.length && positions[j].end - chunkStart <= this.chunkSize) {
        j++;
      }

      const chunkEnd = positions[j - 1].end;

      chunks.push({
        id: nanoid(),
        documentId,
        content: originalText.slice(chunkStart, chunkEnd),
        startOffset: chunkStart,
        endOffset: chunkEnd,
        order: order++,
      });

      if (j >= pieces.length) break;

      if (this.chunkOverlap > 0) {
        const overlapTarget = chunkEnd - this.chunkOverlap;
        let k = j;
        while (k > i + 1 && positions[k - 1].start >= overlapTarget) {
          k--;
        }
        i = Math.max(k, i + 1);
      } else {
        i = j;
      }
    }

    return chunks;
  }

  private splitText(text: string, separatorIndex: number): string[] {
    if (text.length <= this.chunkSize) return [text];

    if (separatorIndex >= this.separators.length) {
      return this.charSplit(text);
    }

    const separator = this.separators[separatorIndex];

    if (separator === '') {
      return this.charSplit(text);
    }

    const parts = text.split(separator);

    if (parts.length === 1) {
      return this.splitText(text, separatorIndex + 1);
    }

    const merged: string[] = [];
    let current = '';

    for (const part of parts) {
      if (part.length === 0) continue;

      const candidate = current ? current + separator + part : part;

      if (candidate.length <= this.chunkSize) {
        current = candidate;
      } else {
        if (current) merged.push(current);

        if (part.length > this.chunkSize) {
          const subParts = this.splitText(part, separatorIndex + 1);
          merged.push(...subParts);
          current = '';
        } else {
          current = part;
        }
      }
    }

    if (current) merged.push(current);

    return merged;
  }

  private charSplit(text: string): string[] {
    const result: string[] = [];
    for (let i = 0; i < text.length; i += this.chunkSize) {
      result.push(text.slice(i, i + this.chunkSize));
    }
    return result;
  }
}
