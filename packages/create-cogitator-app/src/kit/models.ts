import { BUILTIN_MODELS, ModelRegistry, type ModelInfo } from '@cogitator-ai/models';
import { listOllamaModels, hasOllamaModel, resolveOllamaUrl } from './ollama.js';
import { OLLAMA_SUGGESTED_MODELS, defaultModel } from './providers.js';
import type { LLMProvider } from './spec.js';

export interface ModelChoice {
  /** The model id without the provider prefix. */
  value: string;
  label: string;
  hint?: string;
}

/** Where the choices came from: the live catalogue, the built-in list, the local Ollama, or a fallback. */
export type ModelSource = 'catalog' | 'builtin' | 'ollama' | 'suggested';

export interface ModelChoices {
  choices: ModelChoice[];
  source: ModelSource;
}

/** How many models of a cloud provider to offer; the rest are reachable by typing an id. */
const MAX_CHOICES = 8;
const CATALOG_TIMEOUT_MS = 4_000;

function formatPrice(perMillion: number): string {
  return perMillion >= 1
    ? `$${perMillion.toFixed(perMillion % 1 === 0 ? 0 : 2)}`
    : `$${perMillion.toFixed(3).replace(/0+$/, '')}`;
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  return `${Math.round(tokens / 1_000)}k`;
}

/** `$2 in / $10 out per 1M tokens, 1M context`, the line a model choice shows. */
export function describeModel(model: Pick<ModelInfo, 'pricing' | 'contextWindow'>): string {
  const { input, output } = model.pricing;
  return `${formatPrice(input)} in / ${formatPrice(output)} out per 1M tokens, ${formatContext(model.contextWindow)} context`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The current models of a cloud provider: its built-in lineup from
 * `@cogitator-ai/models`, with prices and context windows refreshed from the
 * live catalogue when it answers in time. The provider's default comes first.
 */
export async function cloudModelChoices(
  provider: Exclude<LLMProvider, 'ollama'>,
  options: { timeoutMs?: number; registry?: Pick<ModelRegistry, 'initialize' | 'getModel'> } = {}
): Promise<ModelChoices> {
  const registry =
    options.registry ?? new ModelRegistry({ cache: { ttl: 24 * 60 * 60 * 1000, storage: 'file' } });
  const loaded = await withTimeout(
    registry.initialize().then(
      () => true,
      () => false
    ),
    options.timeoutMs ?? CATALOG_TIMEOUT_MS
  );

  const lineup = BUILTIN_MODELS.filter(
    (model) =>
      model.provider === provider &&
      !model.deprecated &&
      model.capabilities?.supportsTools !== false
  );
  const preferred = defaultModel(provider);
  lineup.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));

  const choices = lineup.slice(0, MAX_CHOICES).map((builtin) => {
    const model = (loaded && registry.getModel(`${provider}/${builtin.id}`)) || builtin;
    return {
      value: builtin.id,
      label: builtin.displayName,
      hint: `${builtin.id === preferred ? 'recommended, ' : ''}${describeModel(model)}`,
    };
  });
  return { choices, source: loaded ? 'catalog' : 'builtin' };
}

function formatSize(bytes: number): string | undefined {
  return bytes > 0 ? `${(bytes / 1e9).toFixed(1)} GB` : undefined;
}

/**
 * The models of the local Ollama, with the recommended one first and marked as
 * installed or not. When Ollama does not answer, a list of small models with
 * reliable tool calling to pull.
 */
export async function ollamaModelChoices(
  baseUrl: string = resolveOllamaUrl()
): Promise<ModelChoices> {
  const recommended = defaultModel('ollama');
  const installed = await listOllamaModels(baseUrl);
  if (!installed) {
    return {
      source: 'suggested',
      choices: OLLAMA_SUGGESTED_MODELS.map((name) => ({
        value: name,
        label: name,
        hint: name === recommended ? 'recommended, Ollama is not running' : 'not installed',
      })),
    };
  }
  const others = installed.filter((model) => !hasOllamaModel([model], recommended));
  return {
    source: 'ollama',
    choices: [
      {
        value: recommended,
        label: recommended,
        hint: hasOllamaModel(installed, recommended)
          ? 'recommended, installed'
          : 'recommended, not installed yet',
      },
      ...others.map((model) => ({
        value: model.name,
        label: model.name,
        hint: formatSize(model.size),
      })),
    ],
  };
}

export function modelChoices(provider: LLMProvider): Promise<ModelChoices> {
  return provider === 'ollama' ? ollamaModelChoices() : cloudModelChoices(provider);
}
