import type { LiteLLMModelData, LiteLLMModelEntry, ModelInfo, ModelPricing } from './types';

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const FETCH_TIMEOUT = 10_000;

export async function fetchLiteLLMData(): Promise<LiteLLMModelData> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const response = await fetch(LITELLM_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Cogitator/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch LiteLLM data: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as LiteLLMModelData;
    return data;
  } finally {
    clearTimeout(timeoutId);
  }
}

const PROVIDER_MAPPINGS: Record<string, string> = {
  openai: 'openai',
  'text-completion-openai': 'openai',
  azure: 'azure',
  azure_ai: 'azure',
  anthropic: 'anthropic',
  bedrock: 'aws',
  vertex_ai: 'google',
  'vertex_ai-': 'google',
  gemini: 'google',
  palm: 'google',
  cohere: 'cohere',
  cohere_chat: 'cohere',
  replicate: 'replicate',
  huggingface: 'huggingface',
  together_ai: 'together',
  together: 'together',
  ollama: 'ollama',
  ollama_chat: 'ollama',
  deepinfra: 'deepinfra',
  perplexity: 'perplexity',
  groq: 'groq',
  mistral: 'mistral',
  'text-completion-codestral': 'mistral',
  codestral: 'mistral',
  fireworks_ai: 'fireworks',
  anyscale: 'anyscale',
  cloudflare: 'cloudflare',
  databricks: 'databricks',
  ai21: 'ai21',
  nlp_cloud: 'nlp_cloud',
  aleph_alpha: 'aleph_alpha',
  voyage: 'voyage',
  sagemaker: 'aws',
  xinference: 'xinference',
  friendliai: 'friendliai',
  github: 'github',
  xai: 'xai',
};

function mapProvider(name: string): string | undefined {
  const mapped = PROVIDER_MAPPINGS[name];
  if (mapped) return mapped;
  for (const [prefix, provider] of Object.entries(PROVIDER_MAPPINGS)) {
    if (name.startsWith(prefix)) return provider;
  }
  return undefined;
}

/**
 * The registry's provider id for a LiteLLM provider or a model id prefix:
 * `gemini` and `vertex_ai` become `google`, `azure_ai` becomes `azure`, and
 * names without a mapping (`openrouter`, `deepseek`) stay as they are.
 */
export function normalizeProviderId(name: string): string {
  const id = name.toLowerCase();
  return mapProvider(id) ?? id;
}

function normalizeProvider(litellmProvider: string | undefined, modelId: string): string {
  const normalizedProvider = litellmProvider?.toLowerCase();
  const normalizedModelId = modelId.toLowerCase();

  if (normalizedProvider) {
    return mapProvider(normalizedProvider) ?? normalizedProvider;
  }

  const prefixMatch = /^([a-z_-]+)\//.exec(normalizedModelId);
  if (prefixMatch) {
    const prefix = prefixMatch[1];
    return PROVIDER_MAPPINGS[prefix] ?? prefix;
  }

  if (
    normalizedModelId.startsWith('gpt-') ||
    normalizedModelId.startsWith('o1') ||
    normalizedModelId.startsWith('o3') ||
    normalizedModelId.startsWith('o4') ||
    normalizedModelId.includes('davinci') ||
    normalizedModelId.includes('curie')
  ) {
    return 'openai';
  }
  if (normalizedModelId.startsWith('claude')) {
    return 'anthropic';
  }
  if (normalizedModelId.startsWith('gemini') || normalizedModelId.startsWith('palm')) {
    return 'google';
  }
  if (
    normalizedModelId.startsWith('llama') ||
    normalizedModelId.startsWith('mistral') ||
    normalizedModelId.startsWith('mixtral')
  ) {
    return 'meta';
  }

  return 'unknown';
}

function extractModelName(modelId: string): string {
  if (modelId.includes('/')) {
    return modelId.split('/').pop() ?? modelId;
  }
  return modelId;
}

/**
 * The model's name at its provider: the catalogue key without its leading
 * provider segment (`openrouter/deepseek/deepseek-v4-pro` on `openrouter` is
 * `deepseek/deepseek-v4-pro`). A leading segment that names no provider, like
 * the quality in `low/1024-x-1024/gpt-image-1`, belongs to the name.
 */
function providerModelName(catalogId: string, provider: string): string {
  const slash = catalogId.indexOf('/');
  if (slash === -1) return catalogId;
  return normalizeProviderId(catalogId.slice(0, slash)) === provider
    ? catalogId.slice(slash + 1)
    : catalogId;
}

function segmentCount(id: string): number {
  return id.split('/').length;
}

/** Orders catalogue keys of one model from the most direct listing to the least. */
function compareCatalogIds(a: string, b: string): number {
  const bySegments = segmentCount(a) - segmentCount(b);
  if (bySegments !== 0) return bySegments;
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  if (lowerA !== lowerB) return lowerA < lowerB ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function createDisplayName(modelId: string): string {
  const name = extractModelName(modelId);

  return name
    .replace(/-/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/Gpt/g, 'GPT')
    .replace(/Ai/g, 'AI')
    .replace(/(\d+)k/gi, '$1K')
    .trim();
}

/** Drops floating point noise (`0.20879999999999999`) from a price per million tokens. */
function roundPrice(perMillionTokens: number): number {
  return Math.round(perMillionTokens * 1_000_000) / 1_000_000;
}

function perMillion(costPerToken: number): number {
  return roundPrice(costPerToken * 1_000_000);
}

function calculatePricing(entry: LiteLLMModelEntry): ModelPricing {
  let inputCost = 0;
  let outputCost = 0;

  if (entry.input_cost_per_token !== undefined) {
    inputCost = entry.input_cost_per_token * 1_000_000;
  } else if (entry.input_cost_per_character !== undefined) {
    inputCost = entry.input_cost_per_character * 4 * 1_000_000;
  }

  if (entry.output_cost_per_token !== undefined) {
    outputCost = entry.output_cost_per_token * 1_000_000;
  } else if (entry.output_cost_per_character !== undefined) {
    outputCost = entry.output_cost_per_character * 4 * 1_000_000;
  }

  return {
    input: roundPrice(inputCost),
    output: roundPrice(outputCost),
    ...(entry.cache_read_input_token_cost !== undefined && {
      inputCached: perMillion(entry.cache_read_input_token_cost),
    }),
    ...(entry.cache_creation_input_token_cost !== undefined && {
      inputCacheWrite: perMillion(entry.cache_creation_input_token_cost),
    }),
    ...(entry.cache_creation_input_token_cost_above_1hr !== undefined && {
      inputCacheWrite1h: perMillion(entry.cache_creation_input_token_cost_above_1hr),
    }),
  };
}

/**
 * Turns the LiteLLM catalogue into registry models: one model per provider
 * and name, keeping the catalogue key as `catalogId`. When a provider lists
 * a model under several keys (`deepseek-v4-pro` and `deepseek/deepseek-v4-pro`),
 * the shortest key wins and the others become aliases, whatever the catalogue order.
 */
export function transformLiteLLMData(data: LiteLLMModelData): ModelInfo[] {
  const byModel = new Map<string, ModelInfo>();

  for (const [catalogId, entry] of Object.entries(data)) {
    if (catalogId.startsWith('sample_spec')) {
      continue;
    }

    const provider = normalizeProvider(entry.litellm_provider, catalogId);
    const id = providerModelName(catalogId, provider);
    const key = `${provider}/${id.toLowerCase()}`;

    const contextWindow = entry.max_input_tokens ?? entry.max_tokens ?? 4096;
    const maxOutputTokens = entry.max_output_tokens ?? entry.max_tokens;

    const isDeprecated = entry.deprecation_date
      ? new Date(entry.deprecation_date) < new Date()
      : false;

    const model: ModelInfo = {
      id,
      provider,
      catalogId,
      displayName: createDisplayName(catalogId),
      pricing: calculatePricing(entry),
      contextWindow,
      maxOutputTokens,
      capabilities: {
        supportsTools: entry.supports_function_calling || entry.supports_tool_choice || undefined,
        supportsVision: entry.supports_vision,
        supportsFunctions: entry.supports_function_calling,
        supportsJson: entry.supports_response_schema,
      },
      deprecated: isDeprecated,
    };

    const existing = byModel.get(key);
    if (!existing) {
      byModel.set(key, model);
      continue;
    }

    const [kept, dropped] =
      compareCatalogIds(catalogId, existing.catalogId ?? existing.id) < 0
        ? [model, existing]
        : [existing, model];
    const aliases = [...(dropped.aliases ?? []), ...(kept.aliases ?? [])];
    if (dropped.catalogId) aliases.push(dropped.catalogId);
    byModel.set(key, {
      ...kept,
      aliases: [...new Set(aliases)].sort(compareCatalogIds),
    });
  }

  return Array.from(byModel.values()).sort(
    (a, b) =>
      a.id.localeCompare(b.id) ||
      a.provider.localeCompare(b.provider) ||
      compareCatalogIds(a.catalogId ?? a.id, b.catalogId ?? b.id)
  );
}
