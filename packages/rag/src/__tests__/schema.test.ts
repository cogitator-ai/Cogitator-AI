import { describe, it, expect } from 'vitest';
import { ChunkingConfigSchema, RetrievalConfigSchema, RAGPipelineConfigSchema } from '../schema';

describe('ChunkingConfigSchema', () => {
  it('validates correct config', () => {
    const result = ChunkingConfigSchema.parse({
      strategy: 'recursive',
      chunkSize: 512,
      chunkOverlap: 50,
    });
    expect(result.strategy).toBe('recursive');
    expect(result.chunkSize).toBe(512);
  });

  it('rejects invalid strategy', () => {
    expect(() =>
      ChunkingConfigSchema.parse({ strategy: 'invalid', chunkSize: 512, chunkOverlap: 50 })
    ).toThrow();
  });

  it('applies default chunkOverlap', () => {
    const result = ChunkingConfigSchema.parse({ strategy: 'fixed', chunkSize: 256 });
    expect(result.chunkOverlap).toBe(0);
  });

  it('accepts optional separators', () => {
    const result = ChunkingConfigSchema.parse({
      strategy: 'recursive',
      chunkSize: 512,
      chunkOverlap: 50,
      separators: ['\n\n', '\n', '. '],
    });
    expect(result.separators).toEqual(['\n\n', '\n', '. ']);
  });

  it('rejects negative chunkSize', () => {
    expect(() =>
      ChunkingConfigSchema.parse({ strategy: 'fixed', chunkSize: -1, chunkOverlap: 0 })
    ).toThrow();
  });
});

describe('RetrievalConfigSchema', () => {
  it('validates correct config', () => {
    const result = RetrievalConfigSchema.parse({
      strategy: 'hybrid',
      topK: 10,
      threshold: 0.5,
    });
    expect(result.strategy).toBe('hybrid');
  });

  it('applies defaults for all fields', () => {
    const result = RetrievalConfigSchema.parse({});
    expect(result.strategy).toBe('similarity');
    expect(result.topK).toBe(10);
    expect(result.threshold).toBe(0.0);
  });

  it('accepts mmr-specific options', () => {
    const result = RetrievalConfigSchema.parse({
      strategy: 'mmr',
      topK: 5,
      threshold: 0.3,
      mmrLambda: 0.7,
    });
    expect(result.mmrLambda).toBe(0.7);
  });

  it('rejects threshold > 1', () => {
    expect(() => RetrievalConfigSchema.parse({ threshold: 1.5 })).toThrow();
  });
});

describe('RAGPipelineConfigSchema', () => {
  it('validates full config', () => {
    const result = RAGPipelineConfigSchema.parse({
      chunking: { strategy: 'recursive', chunkSize: 512, chunkOverlap: 50 },
      retrieval: { strategy: 'hybrid', topK: 5, threshold: 0.7 },
      reranking: { enabled: true, topN: 3 },
    });
    expect(result.reranking?.enabled).toBe(true);
  });

  it('applies retrieval defaults', () => {
    const result = RAGPipelineConfigSchema.parse({
      chunking: { strategy: 'fixed', chunkSize: 256 },
    });
    expect(result.retrieval.strategy).toBe('similarity');
    expect(result.retrieval.topK).toBe(10);
  });

  it('reranking is optional', () => {
    const result = RAGPipelineConfigSchema.parse({
      chunking: { strategy: 'fixed', chunkSize: 256 },
    });
    expect(result.reranking).toBeUndefined();
  });
});
