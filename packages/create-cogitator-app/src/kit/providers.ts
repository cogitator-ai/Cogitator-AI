import type { LLMProvider } from './spec.js';

export interface ProviderInfo {
  id: LLMProvider;
  label: string;
  /** The variable the API key is read from, absent for providers without one. */
  envKey?: string;
  /** Where to create an API key. */
  keyUrl?: string;
  /** The model a new project uses unless another one is chosen. */
  defaultModel: string;
  /** The embedding model RAG uses with this provider, absent when it has none. */
  embeddingModel?: string;
  /** The dimensions of `embeddingModel`, which vector stores size their collections by. */
  embeddingDimensions?: number;
  /** Whether the provider has a realtime voice API Cogitator drives. */
  realtime: boolean;
  /** A short line for prompts and `--help`. */
  hint: string;
}

export const PROVIDER_INFO: Record<LLMProvider, ProviderInfo> = {
  ollama: {
    id: 'ollama',
    label: 'Ollama',
    defaultModel: 'qwen3.5:9b',
    embeddingModel: 'nomic-embed-text',
    embeddingDimensions: 768,
    realtime: false,
    hint: 'local and free, needs Ollama running',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    keyUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-6.1-sol',
    embeddingModel: 'text-embedding-3-small',
    embeddingDimensions: 1536,
    realtime: true,
    hint: 'GPT models, needs OPENAI_API_KEY',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-sonnet-5-5',
    realtime: false,
    hint: 'Claude models, needs ANTHROPIC_API_KEY',
  },
  google: {
    id: 'google',
    label: 'Google Gemini',
    envKey: 'GOOGLE_API_KEY',
    keyUrl: 'https://aistudio.google.com/apikey',
    defaultModel: 'gemini-3.8-flash',
    embeddingModel: 'gemini-embedding-001',
    embeddingDimensions: 768,
    realtime: true,
    hint: 'Gemini models, needs GOOGLE_API_KEY',
  },
};

export function providerInfo(provider: LLMProvider): ProviderInfo {
  return PROVIDER_INFO[provider];
}

export function providerEnvKey(provider: LLMProvider): string | undefined {
  return PROVIDER_INFO[provider].envKey;
}

export function defaultModel(provider: LLMProvider): string {
  return PROVIDER_INFO[provider].defaultModel;
}

/**
 * Small models with reliable tool calling that run on a laptop, offered when
 * Ollama is not reachable to list what is installed.
 */
export const OLLAMA_SUGGESTED_MODELS = [
  'qwen3.5:9b',
  'qwen3.5:4b',
  'gemma4:e4b',
  'llama3.1:8b',
  'mistral-small3.2:24b',
] as const;

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
