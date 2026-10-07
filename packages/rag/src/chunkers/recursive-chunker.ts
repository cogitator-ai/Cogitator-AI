import { chunkId } from './chunk-id.js';
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

    const pieces = this.splitSpan(text, { start: 0, end: text.length }, 0);
    return this.mergePieces(pieces, text, documentId);
  }

  private mergePieces(pieces: Span[], text: string, documentId: string): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    let i = 0;

    while (i < pieces.length) {
      const chunkStart = pieces[i]!.start;

      let j = i + 1;
      while (j < pieces.length && pieces[j]!.end - chunkStart <= this.chunkSize) {
        j++;
      }

      const chunkEnd = pieces[j - 1]!.end;
      chunks.push({
        id: chunkId(documentId, chunks.length),
        documentId,
        content: text.slice(chunkStart, chunkEnd),
        startOffset: chunkStart,
        endOffset: chunkEnd,
        order: chunks.length,
      });

      if (j >= pieces.length) break;

      let next = j;
      if (this.chunkOverlap > 0) {
        const overlapTarget = chunkEnd - this.chunkOverlap;
        while (next > i + 1 && pieces[next - 1]!.start >= overlapTarget) {
          next--;
        }
        while (next < j && pieces[j]!.end - pieces[next]!.start > this.chunkSize) {
          next++;
        }
      }
      i = next;
    }

    return chunks;
  }

  private splitSpan(text: string, span: Span, separatorIndex: number): Span[] {
    const trimmed = trimSpan(text, span);
    if (!trimmed) return [];
    if (trimmed.end - trimmed.start <= this.chunkSize) return [trimmed];

    let index = separatorIndex;
    while (index < this.separators.length) {
      const separator = this.separators[index]!;
      if (separator === '') break;
      if (text.slice(trimmed.start, trimmed.end).includes(separator)) break;
      index++;
    }

    const separator = this.separators[index];
    if (separator === undefined || separator === '') {
      return this.charSplit(trimmed);
    }

    const kept = /^\S*/.exec(separator)![0].length;
    const segments: Span[] = [];
    let cursor = trimmed.start;
    for (;;) {
      const at = text.indexOf(separator, cursor);
      if (at === -1 || at >= trimmed.end) {
        segments.push({ start: cursor, end: trimmed.end });
        break;
      }
      segments.push({ start: cursor, end: Math.min(at + kept, trimmed.end) });
      cursor = at + separator.length;
    }

    const merged: Span[] = [];
    let current: Span | null = null;

    for (const raw of segments) {
      const segment = trimSpan(text, raw);
      if (!segment) continue;

      if (current && segment.end - current.start <= this.chunkSize) {
        current = { start: current.start, end: segment.end };
        continue;
      }

      if (current) merged.push(current);

      if (segment.end - segment.start > this.chunkSize) {
        merged.push(...this.splitSpan(text, segment, index + 1));
        current = null;
      } else {
        current = segment;
      }
    }

    if (current) merged.push(current);
    return merged;
  }

  private charSplit(span: Span): Span[] {
    const result: Span[] = [];
    for (let start = span.start; start < span.end; start += this.chunkSize) {
      result.push({ start, end: Math.min(start + this.chunkSize, span.end) });
    }
    return result;
  }
}

interface Span {
  start: number;
  end: number;
}

function trimSpan(text: string, span: Span): Span | null {
  let { start, end } = span;
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  return start < end ? { start, end } : null;
}
