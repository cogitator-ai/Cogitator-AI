/**
 * LLM Backends
 */

export { BaseLLMBackend } from './base.js';
export { OllamaBackend } from './ollama.js';
export { OpenAIBackend } from './openai.js';
export { AnthropicBackend } from './anthropic.js';

import type { LLMBackend, LLMProvider, CogitatorConfig } from '@cogitator/types';
import { OllamaBackend } from './ollama.js';
import { OpenAIBackend } from './openai.js';
import { AnthropicBackend } from './anthropic.js';

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
    case 'vllm':
      throw new Error(`Provider ${provider} not yet implemented`);

    default:
      throw new Error(`Unknown provider: ${provider}`);
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
