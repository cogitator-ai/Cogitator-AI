/**
 * RAG (Retrieval-Augmented Generation) types
 *
 * Includes:
 * - Document loading and parsing
 * - Chunking strategies
 * - Retrieval and reranking
 * - Pipeline configuration
 */

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
  reranking?: {
    enabled: boolean;
    topN?: number;
  };
}
