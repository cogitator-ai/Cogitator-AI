import {
  cloudModelChoices,
  defaultModel,
  OLLAMA_SUGGESTED_MODELS,
  PROVIDER_INFO,
  type ModelChoices,
} from 'create-cogitator-app';
import { listOllamaModels } from './ollama.js';

export type SetupProvider = 'anthropic' | 'openai' | 'google' | 'ollama';

export interface ModelOption {
  label: string;
  value: string;
  hint?: string;
}

function envKeyOf(provider: Exclude<SetupProvider, 'ollama'>): string {
  const key = PROVIDER_INFO[provider].envKey;
  if (!key) throw new Error(`${provider} has no API key variable`);
  return key;
}

export const API_KEY_ENV: Record<Exclude<SetupProvider, 'ollama'>, string> = {
  anthropic: envKeyOf('anthropic'),
  openai: envKeyOf('openai'),
  google: envKeyOf('google'),
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

/**
 * The current models of a cloud provider with their prices, from the catalogue
 * create-cogitator-app offers too, as `provider/model` values.
 */
export async function fetchProviderModels(
  provider: Exclude<SetupProvider, 'ollama'>,
  options: Parameters<typeof cloudModelChoices>[1] = {}
): Promise<ModelOption[]> {
  const { choices }: ModelChoices = await cloudModelChoices(provider, options);
  return choices.map((choice) => ({
    label: choice.label,
    value: withProviderPrefix(provider, choice.value),
    ...(choice.hint && { hint: choice.hint }),
  }));
}

/** Small models with reliable tool calling, offered when Ollama has none installed or does not answer. */
export function suggestedOllamaModels(): ModelOption[] {
  const recommended = defaultModel('ollama');
  return OLLAMA_SUGGESTED_MODELS.map((name) => ({
    label: name,
    value: `ollama/${name}`,
    hint: name === recommended ? 'recommended, pull it first' : 'pull it first',
  }));
}

export async function fetchOllamaModelOptions(
  baseUrl: string,
  apiKey?: string
): Promise<ModelOption[]> {
  try {
    const models = await listOllamaModels(baseUrl, { apiKey });
    if (models.length === 0) return suggestedOllamaModels();
    return models.map((m) => ({
      label: m.name,
      value: `ollama/${m.name}`,
      hint: m.size > 0 ? formatBytes(m.size) : undefined,
    }));
  } catch {
    return suggestedOllamaModels();
  }
}
