export const VERSION = '0.1.0';

export { RAGPipeline, type RAGPipelineDeps } from './rag-pipeline';
export { RAGPipelineBuilder } from './rag-builder';

export * from './loaders';
export * from './chunkers';
export * from './retrievers';
export * from './rerankers';

export * from './schema';

export { createSearchTool, createIngestTool, ragTools, type RAGTool } from './tools';

export type {
  RAGDocument,
  DocumentChunk,
  DocumentLoader,
  Chunker,
  AsyncChunker,
  ChunkingConfig,
  ChunkingStrategy,
  Retriever,
  RetrievalConfig,
  RetrievalStrategy,
  RetrievalResult,
  Reranker,
  RAGPipelineConfig,
  EmbeddingService,
  EmbeddingAdapter,
} from '@cogitator-ai/types';
