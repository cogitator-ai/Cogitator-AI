/**
 * Embedding service factory
 */

import type { EmbeddingService, EmbeddingServiceConfig } from '@cogitator/types';
import { OpenAIEmbeddingService } from './openai.js';
import { OllamaEmbeddingService } from './ollama.js';

export function createEmbeddingService(
  config: EmbeddingServiceConfig
): EmbeddingService {
  switch (config.provider) {
    case 'openai':
      return new OpenAIEmbeddingService(config);

    case 'ollama':
      return new OllamaEmbeddingService(config);

    default: {
      const exhaustive: never = config;
      throw new Error(
        `Unknown embedding provider: ${(exhaustive as EmbeddingServiceConfig).provider}`
      );
    }
  }
}
