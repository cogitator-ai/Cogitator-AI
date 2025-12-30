/**
 * LLM Backends
 */

export { BaseLLMBackend } from './base';
export { OllamaBackend } from './ollama';
export { OpenAIBackend } from './openai';
export { AnthropicBackend } from './anthropic';
export { GoogleBackend } from './google';

import type { LLMBackend, LLMProvider, CogitatorConfig } from '@cogitator/types';
import { OllamaBackend } from './ollama';
import { OpenAIBackend } from './openai';
import { AnthropicBackend } from './anthropic';
import { GoogleBackend } from './google';

/**
 * Create an LLM backend from configuration
 */
export function createLLMBackend(
  provider: LLMProvider,
  config: CogitatorConfig['llm']
): LLMBackend {
  const providers = config?.providers ?? {};

  switch (provider) {
    case 'ollama':
      return new OllamaBackend({
        baseUrl: providers.ollama?.baseUrl ?? 'http://localhost:11434',
      });

    case 'openai':
      if (!providers.openai?.apiKey) {
        throw new Error('OpenAI API key is required');
      }
      return new OpenAIBackend({
        apiKey: providers.openai.apiKey,
        baseUrl: providers.openai.baseUrl,
      });

    case 'anthropic':
      if (!providers.anthropic?.apiKey) {
        throw new Error('Anthropic API key is required');
      }
      return new AnthropicBackend({
        apiKey: providers.anthropic.apiKey,
      });

    case 'google':
      if (!providers.google?.apiKey) {
        throw new Error('Google API key is required');
      }
      return new GoogleBackend({
        apiKey: providers.google.apiKey,
      });

    case 'vllm':
      throw new Error(`Provider ${provider} not yet implemented`);

    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown provider: ${_exhaustive as string}`);
    }
  }
}

/**
 * Parse model string to extract provider and model name
 * e.g., "ollama/llama3.2:latest" -> { provider: "ollama", model: "llama3.2:latest" }
 */
export function parseModel(modelString: string): {
  provider: LLMProvider | null;
  model: string;
} {
  if (modelString.includes('/')) {
    const [provider, ...rest] = modelString.split('/');
    return {
      provider: provider as LLMProvider,
      model: rest.join('/'),
    };
  }
  return { provider: null, model: modelString };
}
