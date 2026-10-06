/**
 * LLM Backends
 */

export { BaseLLMBackend } from './base';
export { OpenAICompatibleBackend } from './openai-compatible-base';
export { OllamaBackend } from './ollama';
export { OpenAIBackend } from './openai';
export { DEFAULT_OPENAI_MODEL, isOpenAIReasoningModel } from './openai-responses';
export { AnthropicBackend } from './anthropic';
export { GoogleBackend } from './google';
export { AzureOpenAIBackend } from './azure';
export { BedrockBackend } from './bedrock';
export {
  normalizeTurn,
  finishRunsTools,
  turnFinishReason,
  parseToolCallArguments,
  type TurnEnd,
} from './turn';
export {
  LLMError,
  createLLMError,
  wrapSDKError,
  llmUnavailable,
  llmInvalidResponse,
  llmTimeout,
  llmConfigError,
  llmNotImplemented,
  providerErrorIn,
  retryAfterFromHeaders,
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
import { isLLMProvider } from './providers';

export { isLLMProvider } from './providers';
export { RetryingBackend, withLLMRetry, DEFAULT_LLM_RETRY } from './retry';

/**
 * Create an LLM backend from configuration.
 *
 * The backend makes a single attempt per call: the SDKs' own retries are off
 * because the runtime retries per `llm.retry`. Using the backend on its own,
 * wrap it with `withLLMRetry(backend, config.retry)` for the same behaviour.
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
        apiKey: providers.ollama?.apiKey,
      });

    case 'openai':
      if (!providers.openai?.apiKey) {
        throw new Error('OpenAI API key is required');
      }
      return new OpenAIBackend({
        apiKey: providers.openai.apiKey,
        baseUrl: providers.openai.baseUrl,
        api: providers.openai.api,
        maxRetries: 0,
      });

    case 'anthropic':
      if (!providers.anthropic?.apiKey) {
        throw new Error('Anthropic API key is required');
      }
      return new AnthropicBackend({
        apiKey: providers.anthropic.apiKey,
        maxRetries: 0,
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
        model: providers.azure.model,
        maxRetries: 0,
      });

    case 'bedrock':
      return new BedrockBackend({
        region: providers.bedrock?.region,
        accessKeyId: providers.bedrock?.accessKeyId,
        secretAccessKey: providers.bedrock?.secretAccessKey,
        maxRetries: 0,
      });

    case 'mistral':
      if (!providers.mistral?.apiKey) {
        throw new Error('Mistral API key is required');
      }
      return new OpenAIBackend({
        apiKey: providers.mistral.apiKey,
        baseUrl: 'https://api.mistral.ai/v1',
        provider,
        maxRetries: 0,
      });

    case 'groq':
      if (!providers.groq?.apiKey) {
        throw new Error('Groq API key is required');
      }
      return new OpenAIBackend({
        apiKey: providers.groq.apiKey,
        baseUrl: 'https://api.groq.com/openai/v1',
        provider,
        maxRetries: 0,
      });

    case 'together':
      if (!providers.together?.apiKey) {
        throw new Error('Together API key is required');
      }
      return new OpenAIBackend({
        apiKey: providers.together.apiKey,
        baseUrl: 'https://api.together.xyz/v1',
        provider,
        maxRetries: 0,
      });

    case 'deepseek':
      if (!providers.deepseek?.apiKey) {
        throw new Error('DeepSeek API key is required');
      }
      return new OpenAIBackend({
        apiKey: providers.deepseek.apiKey,
        baseUrl: 'https://api.deepseek.com/v1',
        provider,
        maxRetries: 0,
      });

    case 'vllm':
      if (!providers.vllm?.baseUrl) {
        throw new Error('vLLM baseUrl is required');
      }
      return new OpenAIBackend({
        apiKey: 'vllm',
        baseUrl: providers.vllm.baseUrl,
        provider,
        maxRetries: 0,
      });

    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown provider: ${_exhaustive as string}`);
    }
  }
}

/**
 * Parse model string to extract provider and model name
 * e.g., "ollama/llama3.3:latest" -> { provider: "ollama", model: "llama3.3:latest" }
 */
export function parseModel(modelString: string): {
  provider: LLMProvider | null;
  model: string;
} {
  if (modelString.includes('/')) {
    const [provider, ...rest] = modelString.split('/');
    if (!isLLMProvider(provider)) {
      return { provider: null, model: modelString };
    }
    return {
      provider,
      model: rest.join('/'),
    };
  }
  return { provider: null, model: modelString };
}
