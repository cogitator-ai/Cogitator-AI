import { nanoid } from 'nanoid';
import type { AsyncChunker, DocumentChunk, EmbeddingService } from '@cogitator-ai/types';

export interface SemanticChunkerOptions {
  embeddingService: EmbeddingService;
  breakpointThreshold?: number;
  minChunkSize?: number;
  maxChunkSize?: number;
}

function cosineSimilarity(a: number[], b: number[]): number {
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
    this.embeddingService = options.embeddingService;
    this.breakpointThreshold = options.breakpointThreshold ?? 0.5;
    this.minChunkSize = options.minChunkSize ?? 100;
    this.maxChunkSize = options.maxChunkSize ?? 2000;
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

  private buildChunks(
    groups: string[][],
    originalText: string,
    documentId: string
  ): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    let searchFrom = 0;

    for (let i = 0; i < groups.length; i++) {
      const content = groups[i].join(' ');

      if (content.length <= this.maxChunkSize) {
        const startOffset = originalText.indexOf(groups[i][0], searchFrom);
        const lastSentence = groups[i][groups[i].length - 1];
        const lastStart = originalText.indexOf(lastSentence, startOffset >= 0 ? startOffset : 0);
        const endOffset =
          lastStart >= 0 ? lastStart + lastSentence.length : startOffset + content.length;

        chunks.push({
          id: nanoid(),
          documentId,
          content,
          startOffset: Math.max(0, startOffset),
          endOffset,
          order: chunks.length,
        });

        searchFrom = endOffset;
      } else {
        const subChunks = this.splitLargeGroup(
          groups[i],
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
      const newLength = currentLength + (currentSentences.length > 0 ? 1 : 0) + sentence.length;

      if (newLength > this.maxChunkSize && currentSentences.length > 0) {
        const content = currentSentences.join(' ');
        const startOffset = originalText.indexOf(currentSentences[0], offset);
        const lastSentence = currentSentences[currentSentences.length - 1];
        const lastStart = originalText.indexOf(lastSentence, startOffset >= 0 ? startOffset : 0);
        const endOffset =
          lastStart >= 0 ? lastStart + lastSentence.length : startOffset + content.length;

        chunks.push({
          id: nanoid(),
          documentId,
          content,
          startOffset: Math.max(0, startOffset),
          endOffset,
          order: order++,
        });

        offset = endOffset;
        currentSentences = [sentence];
        currentLength = sentence.length;
      } else {
        currentSentences.push(sentence);
        currentLength = newLength;
      }
    }

    if (currentSentences.length > 0) {
      const content = currentSentences.join(' ');
      const startOffset = originalText.indexOf(currentSentences[0], offset);
      const lastSentence = currentSentences[currentSentences.length - 1];
      const lastStart = originalText.indexOf(lastSentence, startOffset >= 0 ? startOffset : 0);
      const endOffset =
        lastStart >= 0 ? lastStart + lastSentence.length : startOffset + content.length;

      chunks.push({
        id: nanoid(),
        documentId,
        content,
        startOffset: Math.max(0, startOffset),
        endOffset,
        order: order++,
      });
    }

    return chunks;
  }
}
