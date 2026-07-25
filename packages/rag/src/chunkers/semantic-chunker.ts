import { nanoid } from 'nanoid';
import type { AsyncChunker, DocumentChunk, EmbeddingService } from '@cogitator-ai/types';

export interface SemanticChunkerOptions {
  embeddingService: EmbeddingService;
  breakpointThreshold?: number;
  minChunkSize?: number;
  maxChunkSize?: number;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Embedding dimension mismatch: ${a.length} vs ${b.length}. ` +
        'Ensure all embeddings come from the same model.'
    );
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

const SENTENCE_SPLIT_RE = /(?<=[.?!])\s+/;

function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export class SemanticChunker implements AsyncChunker {
  private readonly embeddingService: EmbeddingService;
  private readonly breakpointThreshold: number;
  private readonly minChunkSize: number;
  private readonly maxChunkSize: number;

  constructor(options: SemanticChunkerOptions) {
    if (
      options.breakpointThreshold !== undefined &&
      (options.breakpointThreshold < 0 || options.breakpointThreshold > 1)
    ) {
      throw new Error('breakpointThreshold must be between 0 and 1');
    }

    const maxChunkSize = options.maxChunkSize ?? 2000;
    const minChunkSize = options.minChunkSize ?? Math.min(100, maxChunkSize);

    if (minChunkSize > maxChunkSize) {
      throw new Error('minChunkSize must not exceed maxChunkSize');
    }

    this.embeddingService = options.embeddingService;
    this.breakpointThreshold = options.breakpointThreshold ?? 0.5;
    this.minChunkSize = minChunkSize;
    this.maxChunkSize = maxChunkSize;
  }

  async chunk(text: string, documentId: string): Promise<DocumentChunk[]> {
    if (!text || text.trim().length === 0) return [];

    const sentences = splitSentences(text);
    if (sentences.length === 0) return [];

    if (sentences.length === 1) {
      return this.buildChunks([sentences], text, documentId);
    }

    const embeddings = await this.embeddingService.embedBatch(sentences);

    const similarities: number[] = [];
    for (let i = 0; i < embeddings.length - 1; i++) {
      similarities.push(cosineSimilarity(embeddings[i], embeddings[i + 1]));
    }

    const groups: string[][] = [];
    let currentGroup: string[] = [sentences[0]];

    for (let i = 0; i < similarities.length; i++) {
      if (similarities[i] < this.breakpointThreshold) {
        groups.push(currentGroup);
        currentGroup = [sentences[i + 1]];
      } else {
        currentGroup.push(sentences[i + 1]);
      }
    }
    groups.push(currentGroup);

    const merged = this.mergeSmallGroups(groups);
    return this.buildChunks(merged, text, documentId);
  }

  private mergeSmallGroups(groups: string[][]): string[][] {
    if (groups.length <= 1) return groups;

    const result: string[][] = [];
    let current = groups[0];

    for (let i = 1; i < groups.length; i++) {
      const currentText = current.join(' ');
      const nextText = groups[i].join(' ');
      const combinedLength = currentText.length + 1 + nextText.length;

      if (currentText.length < this.minChunkSize && combinedLength <= this.maxChunkSize) {
        current = [...current, ...groups[i]];
      } else {
        result.push(current);
        current = groups[i];
      }
    }

    if (current.length > 0) {
      const currentText = current.join(' ');
      if (currentText.length < this.minChunkSize && result.length > 0) {
        const last = result[result.length - 1];
        const lastText = last.join(' ');
        if (lastText.length + 1 + currentText.length <= this.maxChunkSize) {
          result[result.length - 1] = [...last, ...current];
        } else {
          result.push(current);
        }
      } else {
        result.push(current);
      }
    }

    return result;
  }

  private findSentenceOffset(sentence: string, originalText: string, searchFrom: number): number {
    const idx = originalText.indexOf(sentence, searchFrom);
    return idx >= 0 ? idx : searchFrom;
  }

  private buildChunks(
    groups: string[][],
    originalText: string,
    documentId: string
  ): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    let searchFrom = 0;

    for (const group of groups) {
      const startOffset = this.findSentenceOffset(group[0], originalText, searchFrom);
      const lastSentence = group[group.length - 1];
      const lastStart = this.findSentenceOffset(lastSentence, originalText, startOffset);
      const endOffset = lastStart + lastSentence.length;

      const content = originalText.slice(startOffset, endOffset);

      if (content.length <= this.maxChunkSize) {
        chunks.push({
          id: nanoid(),
          documentId,
          content,
          startOffset,
          endOffset,
          order: chunks.length,
        });
        searchFrom = endOffset;
      } else {
        const subChunks = this.splitLargeGroup(
          group,
          originalText,
          documentId,
          searchFrom,
          chunks.length
        );
        chunks.push(...subChunks);
        if (subChunks.length > 0) {
          searchFrom = subChunks[subChunks.length - 1].endOffset;
        }
      }
    }

    return chunks;
  }

  private splitLargeGroup(
    sentences: string[],
    originalText: string,
    documentId: string,
    searchFrom: number,
    startOrder: number
  ): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    let currentSentences: string[] = [];
    let currentLength = 0;
    let order = startOrder;
    let offset = searchFrom;

    for (const sentence of sentences) {
      if (sentence.length > this.maxChunkSize) {
        if (currentSentences.length > 0) {
          const chunk = this.emitSentenceGroup(
            currentSentences,
            originalText,
            documentId,
            offset,
            order++
          );
          chunks.push(chunk);
          offset = chunk.endOffset;
          currentSentences = [];
          currentLength = 0;
        }

        const sentenceStart = this.findSentenceOffset(sentence, originalText, offset);
        for (let pos = 0; pos < sentence.length; pos += this.maxChunkSize) {
          const sliceEnd = Math.min(pos + this.maxChunkSize, sentence.length);
          const slice = sentence.slice(pos, sliceEnd);
          chunks.push({
            id: nanoid(),
            documentId,
            content: slice,
            startOffset: sentenceStart + pos,
            endOffset: sentenceStart + sliceEnd,
            order: order++,
          });
        }
        offset = sentenceStart + sentence.length;
        continue;
      }

      const newLength = currentLength + (currentSentences.length > 0 ? 1 : 0) + sentence.length;

      if (newLength > this.maxChunkSize && currentSentences.length > 0) {
        const chunk = this.emitSentenceGroup(
          currentSentences,
          originalText,
          documentId,
          offset,
          order++
        );
        chunks.push(chunk);
        offset = chunk.endOffset;
        currentSentences = [sentence];
        currentLength = sentence.length;
      } else {
        currentSentences.push(sentence);
        currentLength = newLength;
      }
    }

    if (currentSentences.length > 0) {
      chunks.push(
        this.emitSentenceGroup(currentSentences, originalText, documentId, offset, order++)
      );
    }

    return chunks;
  }

  private emitSentenceGroup(
    sentences: string[],
    originalText: string,
    documentId: string,
    searchFrom: number,
    order: number
  ): DocumentChunk {
    const startOffset = this.findSentenceOffset(sentences[0], originalText, searchFrom);
    const lastSentence = sentences[sentences.length - 1];
    const lastStart = this.findSentenceOffset(lastSentence, originalText, startOffset);
    const endOffset = lastStart + lastSentence.length;

    return {
      id: nanoid(),
      documentId,
      content: originalText.slice(startOffset, endOffset),
      startOffset,
      endOffset,
      order,
    };
  }
}
