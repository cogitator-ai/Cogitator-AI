/**
 * Embedding service factory
 */

import type { EmbeddingService, EmbeddingServiceConfig } from '@cogitator-ai/types';
import { OpenAIEmbeddingService } from './openai';
import { OllamaEmbeddingService } from './ollama';
import { GoogleEmbeddingService } from './google';

export function createEmbeddingService(config: EmbeddingServiceConfig): EmbeddingService {
  switch (config.provider) {
    case 'openai':
      return new OpenAIEmbeddingService(config);

    case 'ollama':
      return new OllamaEmbeddingService(config);

    case 'google':
      return new GoogleEmbeddingService(config);

    default: {
      const exhaustive: never = config;
      throw new Error(
        `Unknown embedding provider: ${(exhaustive as EmbeddingServiceConfig).provider}`
      );
    }
  }
}
