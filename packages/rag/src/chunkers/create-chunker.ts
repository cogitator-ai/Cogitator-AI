import type { ChunkingConfig, Chunker, AsyncChunker, EmbeddingService } from '@cogitator-ai/types';
import { FixedSizeChunker } from './fixed-chunker';
import { RecursiveChunker } from './recursive-chunker';
import { SemanticChunker } from './semantic-chunker';

export function createChunker(
  config: ChunkingConfig,
  embeddingService?: EmbeddingService
): Chunker | AsyncChunker {
  switch (config.strategy) {
    case 'fixed':
      return new FixedSizeChunker({
        chunkSize: config.chunkSize,
        chunkOverlap: config.chunkOverlap,
      });

    case 'recursive':
      return new RecursiveChunker({
        chunkSize: config.chunkSize,
        chunkOverlap: config.chunkOverlap,
        separators: config.separators,
      });

    case 'semantic': {
      if (!embeddingService) {
        throw new Error('embeddingService is required for semantic chunking strategy');
      }
      return new SemanticChunker({
        embeddingService,
        maxChunkSize: config.chunkSize,
      });
    }

    default: {
      const _exhaustive: never = config.strategy;
      throw new Error(`Unknown chunking strategy: ${_exhaustive}`);
    }
  }
}
