import { ModelRegistry } from '@cogitator-ai/models';
import { listOllamaModels } from './ollama.js';

export type SetupProvider = 'anthropic' | 'openai' | 'google' | 'ollama';

export interface ModelOption {
  label: string;
  value: string;
  hint?: string;
}

export const API_KEY_ENV: Record<Exclude<SetupProvider, 'ollama'>, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
};

export const FALLBACK_MODELS: Record<SetupProvider, ModelOption[]> = {
  anthropic: [
    { label: 'Claude Sonnet 4', value: 'anthropic/claude-sonnet-4-20250514' },
    { label: 'Claude Opus 4', value: 'anthropic/claude-opus-4-20250514' },
    { label: 'Claude Haiku 3.5', value: 'anthropic/claude-3-5-haiku-20241022' },
  ],
  openai: [
    { label: 'GPT-4o', value: 'openai/gpt-4o' },
    { label: 'GPT-4o mini', value: 'openai/gpt-4o-mini' },
    { label: 'o3-mini', value: 'openai/o3-mini' },
  ],
  google: [
    { label: 'Gemini 2.5 Flash', value: 'google/gemini-2.5-flash' },
    { label: 'Gemini 2.5 Pro', value: 'google/gemini-2.5-pro' },
  ],
  ollama: [
    { label: 'Llama 3.1 8B', value: 'ollama/llama3.1:8b' },
    { label: 'Gemma 3 4B', value: 'ollama/gemma3:4b' },
    { label: 'Mistral 7B', value: 'ollama/mistral:7b' },
  ],
};

export function isSetupProvider(value: string): value is SetupProvider {
  return value === 'anthropic' || value === 'openai' || value === 'google' || value === 'ollama';
}

export function withProviderPrefix(provider: SetupProvider, modelId: string): string {
  return modelId.startsWith(`${provider}/`) ? modelId : `${provider}/${modelId}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export async function fetchProviderModels(
  provider: Exclude<SetupProvider, 'ollama'>
): Promise<ModelOption[]> {
  try {
    const registry = new ModelRegistry({ fallbackToBuiltin: true });
    await registry.initialize();

    let models = registry.listModels({
      provider,
      supportsTools: true,
      excludeDeprecated: true,
    });

    if (provider === 'google') {
      models = models.filter((m) => m.id.includes('gemini'));
    }

    if (models.length === 0) return FALLBACK_MODELS[provider];

    return models.map((m) => ({
      label: m.displayName,
      value: withProviderPrefix(provider, m.id),
    }));
  } catch {
    return FALLBACK_MODELS[provider];
  }
}

export async function fetchOllamaModelOptions(
  baseUrl: string,
  apiKey?: string
): Promise<ModelOption[]> {
  try {
    const models = await listOllamaModels(baseUrl, { apiKey });
    if (models.length === 0) return FALLBACK_MODELS.ollama;
    return models.map((m) => ({
      label: m.name,
      value: `ollama/${m.name}`,
      hint: m.size > 0 ? formatBytes(m.size) : undefined,
    }));
  } catch {
    return FALLBACK_MODELS.ollama;
  }
}
