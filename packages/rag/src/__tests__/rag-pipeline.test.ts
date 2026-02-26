import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RAGPipeline } from '../rag-pipeline';
import type {
  DocumentLoader,
  Chunker,
  AsyncChunker,
  EmbeddingService,
  EmbeddingAdapter,
  Retriever,
  Reranker,
  RAGDocument,
  DocumentChunk,
  RetrievalResult,
  RAGPipelineConfig,
} from '@cogitator-ai/types';

const makeDoc = (id: string, content: string): RAGDocument => ({
  id,
  content,
  source: `/data/${id}.txt`,
  sourceType: 'text',
});

const makeChunk = (id: string, docId: string, content: string, order: number): DocumentChunk => ({
  id,
  documentId: docId,
  content,
  startOffset: 0,
  endOffset: content.length,
  order,
});

const makeResult = (chunkId: string, docId: string, score: number): RetrievalResult => ({
  chunkId,
  documentId: docId,
  content: `Content of ${chunkId}`,
  score,
});

const baseConfig: RAGPipelineConfig = {
  chunking: { strategy: 'fixed', chunkSize: 200, chunkOverlap: 0 },
  retrieval: { strategy: 'similarity', topK: 10, threshold: 0 },
};

describe('RAGPipeline', () => {
  let loader: DocumentLoader;
  let chunker: Chunker;
  let embeddingService: EmbeddingService;
  let embeddingAdapter: EmbeddingAdapter;
  let retriever: Retriever;
  let reranker: Reranker;

  beforeEach(() => {
    loader = {
      supportedTypes: ['text'],
      load: vi
        .fn()
        .mockResolvedValue([makeDoc('doc-1', 'Hello world'), makeDoc('doc-2', 'Second document')]),
    };

    chunker = {
      chunk: vi.fn((text: string, docId: string) => [
        makeChunk(`${docId}-c1`, docId, text.slice(0, 5), 0),
        makeChunk(`${docId}-c2`, docId, text.slice(5), 1),
      ]),
    };

    embeddingService = {
      embed: vi.fn().mockResolvedValue([1, 0, 0]),
      embedBatch: vi.fn().mockResolvedValue([
        [1, 0, 0],
        [0, 1, 0],
      ]),
      dimensions: 3,
      model: 'test-model',
    };

    embeddingAdapter = {
      addEmbedding: vi.fn().mockResolvedValue({ success: true, data: {} }),
      search: vi.fn().mockResolvedValue({ success: true, data: [] }),
      deleteEmbedding: vi.fn(),
      deleteBySource: vi.fn(),
    } as unknown as EmbeddingAdapter;

    retriever = {
      retrieve: vi
        .fn()
        .mockResolvedValue([
          makeResult('chunk-1', 'doc-1', 0.95),
          makeResult('chunk-2', 'doc-1', 0.8),
        ]),
    };

    reranker = {
      rerank: vi
        .fn()
        .mockResolvedValue([
          makeResult('chunk-2', 'doc-1', 0.99),
          makeResult('chunk-1', 'doc-1', 0.7),
        ]),
    };
  });

  function createPipeline(opts?: {
    withReranker?: boolean;
    asyncChunker?: boolean;
    config?: RAGPipelineConfig;
  }) {
    const config = opts?.config ?? baseConfig;
    let chunkDep: Chunker | AsyncChunker = chunker;
    if (opts?.asyncChunker) {
      chunkDep = {
        chunk: vi.fn(async (text: string, docId: string) => [
          makeChunk(`${docId}-c1`, docId, text.slice(0, 5), 0),
          makeChunk(`${docId}-c2`, docId, text.slice(5), 1),
        ]),
      };
    }

    return new RAGPipeline(config, {
      loader,
      chunker: chunkDep,
      embeddingService,
      embeddingAdapter,
      retriever,
      reranker: opts?.withReranker ? reranker : undefined,
    });
  }

  describe('ingest', () => {
    it('loads, chunks, embeds, and stores documents', async () => {
      const pipeline = createPipeline();
      const result = await pipeline.ingest('/data/source');

      expect(loader.load).toHaveBeenCalledWith('/data/source');
      expect(chunker.chunk).toHaveBeenCalledTimes(2);
      expect(embeddingService.embedBatch).toHaveBeenCalledTimes(2);
      expect(embeddingAdapter.addEmbedding).toHaveBeenCalledTimes(4);

      expect(result.documents).toBe(2);
      expect(result.chunks).toBe(4);
    });

    it('works with async chunker', async () => {
      const pipeline = createPipeline({ asyncChunker: true });
      const result = await pipeline.ingest('/data/source');

      expect(result.documents).toBe(2);
      expect(result.chunks).toBe(4);
    });

    it('stores embeddings with correct metadata', async () => {
      const pipeline = createPipeline();
      await pipeline.ingest('/data/source');

      const firstCall = vi.mocked(embeddingAdapter.addEmbedding).mock.calls[0][0];
      expect(firstCall.sourceId).toBe('doc-1-c1');
      expect(firstCall.sourceType).toBe('document');
      expect(firstCall.metadata).toMatchObject({
        documentId: 'doc-1',
        source: '/data/doc-1.txt',
        order: 0,
      });
    });
  });

  describe('query', () => {
    it('retrieves results from retriever', async () => {
      const pipeline = createPipeline();
      const results = await pipeline.query('search query');

      expect(retriever.retrieve).toHaveBeenCalledWith('search query', undefined);
      expect(results).toHaveLength(2);
      expect(results[0].score).toBe(0.95);
    });

    it('passes options to retriever', async () => {
      const pipeline = createPipeline();
      await pipeline.query('search query', { topK: 5 });

      expect(retriever.retrieve).toHaveBeenCalledWith('search query', { topK: 5 });
    });

    it('applies reranker when configured', async () => {
      const pipeline = createPipeline({
        withReranker: true,
        config: {
          ...baseConfig,
          reranking: { enabled: true, topN: 2 },
        },
      });
      const results = await pipeline.query('search query');

      expect(reranker.rerank).toHaveBeenCalledWith('search query', expect.any(Array), 2);
      expect(results[0].chunkId).toBe('chunk-2');
    });

    it('skips reranker when reranking is disabled', async () => {
      const pipeline = createPipeline({ withReranker: true });
      await pipeline.query('search query');

      expect(reranker.rerank).not.toHaveBeenCalled();
    });

    it('skips reranker when no reranker provided', async () => {
      const pipeline = createPipeline({
        config: { ...baseConfig, reranking: { enabled: true } },
      });
      const results = await pipeline.query('search query');

      expect(results).toHaveLength(2);
    });
  });

  describe('getStats', () => {
    it('tracks documents and chunks ingested', async () => {
      const pipeline = createPipeline();

      const before = pipeline.getStats();
      expect(before.documentsIngested).toBe(0);
      expect(before.chunksStored).toBe(0);
      expect(before.queriesProcessed).toBe(0);

      await pipeline.ingest('/data/source');

      const after = pipeline.getStats();
      expect(after.documentsIngested).toBe(2);
      expect(after.chunksStored).toBe(4);
    });

    it('tracks queries processed', async () => {
      const pipeline = createPipeline();
      await pipeline.query('q1');
      await pipeline.query('q2');

      expect(pipeline.getStats().queriesProcessed).toBe(2);
    });

    it('accumulates across multiple ingests', async () => {
      const pipeline = createPipeline();
      await pipeline.ingest('/data/a');
      await pipeline.ingest('/data/b');

      expect(pipeline.getStats().documentsIngested).toBe(4);
      expect(pipeline.getStats().chunksStored).toBe(8);
    });
  });

  describe('edge cases', () => {
    it('skips documents that produce zero chunks', async () => {
      vi.mocked(chunker.chunk).mockReturnValue([]);
      const pipeline = createPipeline();
      const result = await pipeline.ingest('/data/source');

      expect(result.documents).toBe(2);
      expect(result.chunks).toBe(0);
      expect(embeddingService.embedBatch).not.toHaveBeenCalled();
    });

    it('throws on vectors/chunks length mismatch', async () => {
      vi.mocked(embeddingService.embedBatch).mockResolvedValue([[1, 0, 0]]);
      const pipeline = createPipeline();

      await expect(pipeline.ingest('/data/source')).rejects.toThrow('Embedding count mismatch');
    });
  });

  describe('error propagation', () => {
    it('propagates loader errors', async () => {
      vi.mocked(loader.load).mockRejectedValue(new Error('file not found'));
      const pipeline = createPipeline();

      await expect(pipeline.ingest('/bad/path')).rejects.toThrow('file not found');
    });

    it('propagates embedding adapter errors', async () => {
      vi.mocked(embeddingAdapter.addEmbedding).mockResolvedValue({
        success: false,
        error: 'storage full',
      });
      const pipeline = createPipeline();

      await expect(pipeline.ingest('/data/source')).rejects.toThrow('storage full');
    });
  });
});
