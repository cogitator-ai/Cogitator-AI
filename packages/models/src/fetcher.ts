import type { LiteLLMModelData, LiteLLMModelEntry, ModelInfo, ModelPricing } from './types.js';

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
        'Accept': 'application/json',
        'User-Agent': 'Cogitator/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch LiteLLM data: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as LiteLLMModelData;
    return data;
  } finally {
    clearTimeout(timeoutId);
  }
}

const PROVIDER_MAPPINGS: Record<string, string> = {
  'openai': 'openai',
  'azure': 'azure',
  'azure_ai': 'azure',
  'anthropic': 'anthropic',
  'bedrock': 'aws',
  'vertex_ai': 'google',
  'vertex_ai-': 'google',
  'gemini': 'google',
  'palm': 'google',
  'cohere': 'cohere',
  'cohere_chat': 'cohere',
  'replicate': 'replicate',
  'huggingface': 'huggingface',
  'together_ai': 'together',
  'together': 'together',
  'ollama': 'ollama',
  'ollama_chat': 'ollama',
  'deepinfra': 'deepinfra',
  'perplexity': 'perplexity',
  'groq': 'groq',
  'mistral': 'mistral',
  'text-completion-codestral': 'mistral',
  'codestral': 'mistral',
  'fireworks_ai': 'fireworks',
  'anyscale': 'anyscale',
  'cloudflare': 'cloudflare',
  'databricks': 'databricks',
  'ai21': 'ai21',
  'nlp_cloud': 'nlp_cloud',
  'aleph_alpha': 'aleph_alpha',
  'voyage': 'voyage',
  'sagemaker': 'aws',
  'xinference': 'xinference',
  'friendliai': 'friendliai',
  'github': 'github',
  'xai': 'xai',
};

function normalizeProvider(litellmProvider: string | undefined, modelId: string): string {
  if (litellmProvider) {
    const normalized = PROVIDER_MAPPINGS[litellmProvider];
    if (normalized) return normalized;

    for (const [prefix, provider] of Object.entries(PROVIDER_MAPPINGS)) {
      if (litellmProvider.startsWith(prefix)) {
        return provider;
      }
    }
  }

  const prefixMatch = /^([a-z_-]+)\//.exec(modelId);
  if (prefixMatch) {
    const prefix = prefixMatch[1];
    return PROVIDER_MAPPINGS[prefix] ?? prefix;
  }

  if (modelId.startsWith('gpt-') || modelId.startsWith('o1') || modelId.startsWith('o3') || modelId.includes('davinci') || modelId.includes('curie')) {
    return 'openai';
  }
  if (modelId.startsWith('claude')) {
    return 'anthropic';
  }
  if (modelId.startsWith('gemini') || modelId.startsWith('palm')) {
    return 'google';
  }
  if (modelId.startsWith('llama') || modelId.startsWith('mistral') || modelId.startsWith('mixtral')) {
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
    input: Math.round(inputCost * 1000) / 1000,
    output: Math.round(outputCost * 1000) / 1000,
  };
}

export function transformLiteLLMData(data: LiteLLMModelData): ModelInfo[] {
  const models: ModelInfo[] = [];
  const seenIds = new Set<string>();

  for (const [modelId, entry] of Object.entries(data)) {
    if (modelId.startsWith('sample_spec') || modelId === 'sample_spec') {
      continue;
    }

    const normalizedId = extractModelName(modelId).toLowerCase();

    if (seenIds.has(normalizedId)) {
      continue;
    }
    seenIds.add(normalizedId);

    const provider = normalizeProvider(entry.litellm_provider, modelId);
    const pricing = calculatePricing(entry);

    const contextWindow = entry.max_input_tokens ?? entry.max_tokens ?? 4096;
    const maxOutputTokens = entry.max_output_tokens ?? entry.max_tokens;

    const isDeprecated = entry.deprecation_date
      ? new Date(entry.deprecation_date) < new Date()
      : false;

    const model: ModelInfo = {
      id: extractModelName(modelId),
      provider,
      displayName: createDisplayName(modelId),
      pricing,
      contextWindow,
      maxOutputTokens,
      capabilities: {
        supportsTools: entry.supports_function_calling ?? entry.supports_tool_choice,
        supportsVision: entry.supports_vision,
        supportsFunctions: entry.supports_function_calling,
        supportsJson: entry.supports_response_schema,
      },
      deprecated: isDeprecated || undefined,
    };

    models.push(model);
  }

  return models.sort((a, b) => a.id.localeCompare(b.id));
}
