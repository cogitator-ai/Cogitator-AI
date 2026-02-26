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

    const texts = this.splitText(text, 0);
    return this.mergeWithOverlap(texts, documentId);
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

  private mergeWithOverlap(texts: string[], documentId: string): DocumentChunk[] {
    if (this.chunkOverlap === 0) {
      let offset = 0;
      return texts.map((content, i) => {
        const chunk: DocumentChunk = {
          id: nanoid(),
          documentId,
          content,
          startOffset: offset,
          endOffset: offset + content.length,
          order: i,
        };
        offset += content.length;
        return chunk;
      });
    }

    const joined = texts.join('');
    const chunks: DocumentChunk[] = [];
    let order = 0;
    let textIndex = 0;
    let i = 0;

    while (i < texts.length) {
      let content = texts[i];
      let consumed = 1;

      while (i + consumed < texts.length) {
        const next = content + texts[i + consumed];
        if (next.length <= this.chunkSize) {
          content = next;
          consumed++;
        } else {
          break;
        }
      }

      const startOffset = joined.indexOf(
        content,
        textIndex > 0 ? Math.max(0, textIndex - this.chunkOverlap) : 0
      );
      chunks.push({
        id: nanoid(),
        documentId,
        content,
        startOffset: startOffset >= 0 ? startOffset : textIndex,
        endOffset: (startOffset >= 0 ? startOffset : textIndex) + content.length,
        order: order++,
      });

      textIndex += content.length;

      const overlapChars = Math.min(this.chunkOverlap, content.length);
      const overlapText = content.slice(content.length - overlapChars);

      i += consumed;

      if (i < texts.length) {
        const remaining = texts.slice(i);
        const withOverlap = overlapText + remaining.join('');

        if (withOverlap.length <= this.chunkSize) {
          chunks.push({
            id: nanoid(),
            documentId,
            content: withOverlap,
            startOffset: textIndex - overlapChars,
            endOffset: textIndex - overlapChars + withOverlap.length,
            order: order++,
          });
          break;
        }

        const reSplit = this.splitText(withOverlap, 0);
        const subChunks = this.mergeWithOverlapSimple(
          reSplit,
          documentId,
          textIndex - overlapChars,
          order
        );
        chunks.push(...subChunks);
        break;
      }
    }

    return chunks;
  }

  private mergeWithOverlapSimple(
    texts: string[],
    documentId: string,
    baseOffset: number,
    startOrder: number
  ): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    let offset = baseOffset;
    let order = startOrder;

    for (const content of texts) {
      chunks.push({
        id: nanoid(),
        documentId,
        content,
        startOffset: offset,
        endOffset: offset + content.length,
        order: order++,
      });
      offset += content.length;
    }

    return chunks;
  }
}
