import { createRequire } from 'node:module';

const packageJson = createRequire(import.meta.url)('../package.json') as { version: string };

export const VERSION: string = packageJson.version;

export { RAGPipeline, type RAGPipelineDeps } from './rag-pipeline.js';
export { RAGPipelineBuilder } from './rag-builder.js';

export * from './loaders/index.js';
export * from './chunkers/index.js';
export * from './retrievers/index.js';
export * from './rerankers/index.js';

export * from './schema.js';

export {
  createSearchTool,
  createIngestTool,
  ragTools,
  type RAGTool,
  type IngestToolOptions,
} from './tools.js';

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
