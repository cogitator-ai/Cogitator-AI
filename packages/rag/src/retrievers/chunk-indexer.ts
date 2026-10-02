import type { Retriever } from '@cogitator-ai/types';

export interface IndexedChunk {
  embeddingId: string;
  chunkId: string;
  documentId: string;
  content: string;
  metadata: Record<string, unknown>;
}

/**
 * A retriever that maintains its own index alongside the vector store
 * (e.g. a local BM25 index). `RAGPipeline.ingest()` calls `indexChunk()` for
 * every stored chunk.
 */
export interface ChunkIndexer {
  indexChunk(chunk: IndexedChunk): void;
}

export function isChunkIndexer(retriever: Retriever): retriever is Retriever & ChunkIndexer {
  return typeof (retriever as Partial<ChunkIndexer>).indexChunk === 'function';
}

export function resultSource(metadata: Record<string, unknown> | undefined, fallback: string) {
  const source = metadata?.source;
  return typeof source === 'string' ? source : fallback;
}
