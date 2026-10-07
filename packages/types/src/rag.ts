/**
 * RAG (Retrieval-Augmented Generation) types
 *
 * Includes:
 * - Document loading and parsing
 * - Chunking strategies
 * - Retrieval and reranking
 * - Pipeline configuration
 */

import type { SearchFilter } from './memory';

export interface DocumentChunk {
  id: string;
  documentId: string;
  content: string;
  startOffset: number;
  endOffset: number;
  order: number;
  metadata?: Record<string, unknown>;
}

export interface RAGDocument {
  id: string;
  content: string;
  source: string;
  sourceType: 'pdf' | 'html' | 'csv' | 'json' | 'markdown' | 'text' | 'web';
  metadata?: Record<string, unknown>;
  chunks?: DocumentChunk[];
}

export type ChunkingStrategy = 'fixed' | 'recursive' | 'semantic';

export interface ChunkingConfig {
  strategy: ChunkingStrategy;
  chunkSize: number;
  chunkOverlap: number;
  separators?: string[];
}

export interface Chunker {
  chunk(text: string, documentId: string): DocumentChunk[];
}

export interface AsyncChunker {
  chunk(text: string, documentId: string): Promise<DocumentChunk[]>;
}

export interface DocumentLoader {
  load(source: string): Promise<RAGDocument[]>;
  readonly supportedTypes: string[];
}

export type RetrievalStrategy = 'similarity' | 'mmr' | 'hybrid' | 'multi-query';

export interface RetrievalConfig {
  strategy: RetrievalStrategy;
  topK: number;
  threshold: number;
  mmrLambda?: number;
  multiQueryCount?: number;
  /**
   * Narrows the search further. `RAGPipeline` always searches `sourceType: 'document'` of its
   * own namespace, so private memory in a shared store never comes back as a RAG result.
   */
  filter?: SearchFilter;
}

export interface RetrievalResult {
  chunkId: string;
  documentId: string;
  content: string;
  score: number;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface Retriever {
  retrieve(query: string, options?: Partial<RetrievalConfig>): Promise<RetrievalResult[]>;
}

export interface Reranker {
  rerank(query: string, results: RetrievalResult[], topN?: number): Promise<RetrievalResult[]>;
}

export interface RAGPipelineConfig {
  chunking: ChunkingConfig;
  retrieval: RetrievalConfig;
  /**
   * Keeps this pipeline's chunks apart from other pipelines in the same embedding store: stored
   * as `metadata.namespace`, and queries, re-ingest and `removeSource` only touch that namespace.
   */
  namespace?: string;
  reranking?: {
    enabled: boolean;
    topN?: number;
  };
}
