/**
 * LLM Backends
 */

export { BaseLLMBackend } from './base';
export { OllamaBackend } from './ollama';
export { OpenAIBackend } from './openai';
export { AnthropicBackend } from './anthropic';
export { GoogleBackend } from './google';
export { AzureOpenAIBackend } from './azure';
export { BedrockBackend } from './bedrock';
export {
  LLMError,
  createLLMError,
  llmUnavailable,
  llmInvalidResponse,
  llmTimeout,
  llmConfigError,
  llmNotImplemented,
  type LLMErrorContext,
} from './errors';
export { LLMDebugWrapper, withDebug, type LLMDebugOptions, type LLMDebugLogger } from './debug';
export {
  llmPluginRegistry,
  registerLLMBackend,
  unregisterLLMBackend,
  createLLMBackendFromPlugin,
  listLLMPlugins,
  hasLLMPlugin,
  defineBackend,
  type LLMBackendFactory,
  type LLMPluginMetadata,
  type LLMPlugin,
} from './plugin';

import type { LLMBackend, LLMProvider, CogitatorConfig } from '@cogitator-ai/types';
import { OllamaBackend } from './ollama';
import { OpenAIBackend } from './openai';
import { AnthropicBackend } from './anthropic';
import { GoogleBackend } from './google';
import { AzureOpenAIBackend } from './azure';
import { BedrockBackend } from './bedrock';

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

    case 'azure':
      if (!providers.azure?.endpoint || !providers.azure?.apiKey) {
        throw new Error('Azure OpenAI endpoint and API key are required');
      }
      return new AzureOpenAIBackend({
        endpoint: providers.azure.endpoint,
        apiKey: providers.azure.apiKey,
        apiVersion: providers.azure.apiVersion,
        deployment: providers.azure.deployment,
      });

    case 'bedrock':
      return new BedrockBackend({
        region: providers.bedrock?.region,
        accessKeyId: providers.bedrock?.accessKeyId,
        secretAccessKey: providers.bedrock?.secretAccessKey,
      });

    case 'mistral':
      if (!providers.mistral?.apiKey) {
        throw new Error('Mistral API key is required');
      }
      return new OpenAIBackend({
        apiKey: providers.mistral.apiKey,
        baseUrl: 'https://api.mistral.ai/v1',
      });

    case 'groq':
      if (!providers.groq?.apiKey) {
        throw new Error('Groq API key is required');
      }
      return new OpenAIBackend({
        apiKey: providers.groq.apiKey,
        baseUrl: 'https://api.groq.com/openai/v1',
      });

    case 'together':
      if (!providers.together?.apiKey) {
        throw new Error('Together API key is required');
      }
      return new OpenAIBackend({
        apiKey: providers.together.apiKey,
        baseUrl: 'https://api.together.xyz/v1',
      });

    case 'deepseek':
      if (!providers.deepseek?.apiKey) {
        throw new Error('DeepSeek API key is required');
      }
      return new OpenAIBackend({
        apiKey: providers.deepseek.apiKey,
        baseUrl: 'https://api.deepseek.com/v1',
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
