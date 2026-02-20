import { describe, it, expect, vi } from 'vitest';
import { RAGPipelineBuilder } from '../rag-builder';
import { RAGPipeline } from '../rag-pipeline';
import type {
  DocumentLoader,
  Chunker,
  EmbeddingService,
  EmbeddingAdapter,
  Retriever,
  Reranker,
} from '@cogitator-ai/types';

function mockLoader(): DocumentLoader {
  return {
    supportedTypes: ['text'],
    load: vi.fn().mockResolvedValue([]),
  };
}

function mockChunker(): Chunker {
  return { chunk: vi.fn().mockReturnValue([]) };
}

function mockEmbeddingService(): EmbeddingService {
  return {
    embed: vi.fn().mockResolvedValue([1, 0, 0]),
    embedBatch: vi.fn().mockResolvedValue([]),
    dimensions: 3,
    model: 'test',
  };
}

function mockEmbeddingAdapter(): EmbeddingAdapter {
  return {
    addEmbedding: vi.fn().mockResolvedValue({ success: true, data: {} }),
    search: vi.fn().mockResolvedValue({ success: true, data: [] }),
    deleteEmbedding: vi.fn(),
    deleteBySource: vi.fn(),
  } as unknown as EmbeddingAdapter;
}

function mockRetriever(): Retriever {
  return { retrieve: vi.fn().mockResolvedValue([]) };
}

function mockReranker(): Reranker {
  return { rerank: vi.fn().mockResolvedValue([]) };
}

describe('RAGPipelineBuilder', () => {
  it('builds with all dependencies explicitly provided', () => {
    const pipeline = new RAGPipelineBuilder()
      .withLoader(mockLoader())
      .withChunker(mockChunker())
      .withEmbeddingService(mockEmbeddingService())
      .withEmbeddingAdapter(mockEmbeddingAdapter())
      .withRetriever(mockRetriever())
      .withReranker(mockReranker())
      .withConfig({
        chunking: { strategy: 'fixed', chunkSize: 200, chunkOverlap: 0 },
      })
      .build();

    expect(pipeline).toBeInstanceOf(RAGPipeline);
  });

  it('auto-creates chunker from config when not provided', () => {
    const pipeline = new RAGPipelineBuilder()
      .withLoader(mockLoader())
      .withEmbeddingService(mockEmbeddingService())
      .withEmbeddingAdapter(mockEmbeddingAdapter())
      .withRetriever(mockRetriever())
      .withConfig({
        chunking: { strategy: 'fixed', chunkSize: 100, chunkOverlap: 10 },
      })
      .build();

    expect(pipeline).toBeInstanceOf(RAGPipeline);
  });

  it('auto-creates similarity retriever when not provided', () => {
    const pipeline = new RAGPipelineBuilder()
      .withLoader(mockLoader())
      .withChunker(mockChunker())
      .withEmbeddingService(mockEmbeddingService())
      .withEmbeddingAdapter(mockEmbeddingAdapter())
      .withConfig({
        chunking: { strategy: 'fixed', chunkSize: 200, chunkOverlap: 0 },
      })
      .build();

    expect(pipeline).toBeInstanceOf(RAGPipeline);
  });

  it('throws if loader is missing', () => {
    expect(() =>
      new RAGPipelineBuilder()
        .withChunker(mockChunker())
        .withEmbeddingService(mockEmbeddingService())
        .withEmbeddingAdapter(mockEmbeddingAdapter())
        .withConfig({
          chunking: { strategy: 'fixed', chunkSize: 200, chunkOverlap: 0 },
        })
        .build()
    ).toThrow(/loader/i);
  });

  it('throws if embeddingService is missing', () => {
    expect(() =>
      new RAGPipelineBuilder()
        .withLoader(mockLoader())
        .withChunker(mockChunker())
        .withEmbeddingAdapter(mockEmbeddingAdapter())
        .withConfig({
          chunking: { strategy: 'fixed', chunkSize: 200, chunkOverlap: 0 },
        })
        .build()
    ).toThrow(/embeddingService/i);
  });

  it('throws if embeddingAdapter is missing', () => {
    expect(() =>
      new RAGPipelineBuilder()
        .withLoader(mockLoader())
        .withChunker(mockChunker())
        .withEmbeddingService(mockEmbeddingService())
        .withConfig({
          chunking: { strategy: 'fixed', chunkSize: 200, chunkOverlap: 0 },
        })
        .build()
    ).toThrow(/embeddingAdapter/i);
  });

  it('throws if no chunker and no config provided', () => {
    expect(() =>
      new RAGPipelineBuilder()
        .withLoader(mockLoader())
        .withEmbeddingService(mockEmbeddingService())
        .withEmbeddingAdapter(mockEmbeddingAdapter())
        .withRetriever(mockRetriever())
        .build()
    ).toThrow();
  });
});
