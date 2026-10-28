import { afterEach, describe, expect, it, vi } from 'vitest';
import { LITELLM_URL } from '../fetcher';
import {
  OPENROUTER_MODELS_URL,
  fetchOpenRouterData,
  parseOpenRouterModels,
  transformOpenRouterData,
  type OpenRouterModelEntry,
} from '../openrouter-catalogue';
import { ModelRegistry } from '../registry';
import { OPENROUTER_SNAPSHOT } from '../snapshot';
import type { LiteLLMModelData } from '../types';

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

/** A page of OpenRouter's `GET /api/v1/models`, the fields it serves trimmed to a few. */
const PAGE = {
  data: [
    {
      id: 'deepseek/deepseek-v4-pro',
      canonical_slug: 'deepseek/deepseek-v4-pro',
      name: 'DeepSeek: DeepSeek V4 Pro',
      context_length: 1048576,
      architecture: {
        modality: 'text->text',
        input_modalities: ['text'],
        output_modalities: ['text'],
      },
      pricing: {
        prompt: '0.000000888966',
        completion: '0.000001777932',
        input_cache_read: '0.0000000740805',
      },
      top_provider: { context_length: 1024000, max_completion_tokens: 384000 },
      supported_parameters: ['max_tokens', 'tools', 'tool_choice', 'response_format'],
      expiration_date: null,
    },
    {
      id: 'z-ai/glm-5.3',
      name: 'Z.ai: GLM 5.3',
      context_length: 202752,
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      pricing: {
        prompt: '0.0000006',
        completion: '0.0000022',
        input_cache_write: '0.00000075',
        input_cache_write_1h: '0.0000012',
        overrides: [{ min_prompt_tokens: 200000, prompt: '0.000001', completion: '0.000003' }],
      },
      top_provider: { context_length: null, max_completion_tokens: null },
      supported_parameters: ['temperature'],
    },
    {
      id: 'openrouter/auto',
      name: 'Auto Router',
      context_length: 2000000,
      architecture: { input_modalities: ['text'], output_modalities: ['text', 'image'] },
      pricing: { prompt: '-1', completion: '-1' },
    },
    {
      id: 'vendor/free-model:free',
      context_length: 32768,
      pricing: { prompt: '0', completion: '0' },
    },
    {
      id: 'google/image-only',
      context_length: 32768,
      architecture: { input_modalities: ['text'], output_modalities: ['image'] },
      pricing: { prompt: '0.000001', completion: '0.00003' },
    },
    {
      id: 'vendor/retired',
      context_length: 8192,
      pricing: { prompt: '0.000001', completion: '0.000002' },
      expiration_date: '2026-01-31',
    },
    { id: 'broken/no-pricing', context_length: 4096 },
  ],
  total_count: 7,
  links: { next: null },
};

/** LiteLLM's catalogue, which lists DeepSeek and Z.ai directly but nothing at OpenRouter. */
const LITELLM: LiteLLMModelData = {
  'deepseek-v4-pro': {
    litellm_provider: 'deepseek',
    input_cost_per_token: 0.00000132,
    output_cost_per_token: 0.00000396,
    max_input_tokens: 1000000,
  },
  'deepseek/deepseek-v4-pro': {
    litellm_provider: 'deepseek',
    input_cost_per_token: 0.00000132,
    output_cost_per_token: 0.00000396,
    max_input_tokens: 1000000,
  },
  'zai/glm-5.3': {
    litellm_provider: 'zai',
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.0000032,
    max_input_tokens: 200000,
  },
};

const NOW = new Date('2026-10-29T00:00:00Z');

function parsedPage(): OpenRouterModelEntry[] {
  return parseOpenRouterModels(PAGE).models;
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(body) };
}

/** Serves `routes` by URL, refusing any other request so no test reaches the network. */
function serve(routes: Record<string, unknown>) {
  const fetchMock = vi.fn((input: string | URL) => {
    const url = String(input);
    if (!(url in routes)) return Promise.reject(new Error(`unexpected request to ${url}`));
    const body = routes[url];
    return body instanceof Error ? Promise.reject(body) : Promise.resolve(jsonResponse(body));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function initializedRegistry(): Promise<ModelRegistry> {
  const registry = new ModelRegistry({ cache: { ttl: 60_000, storage: 'memory' } });
  await registry.initialize();
  return registry;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseOpenRouterModels', () => {
  it('keeps the entries that match the schema and leaves out the rest', () => {
    const { models, next } = parseOpenRouterModels(PAGE);

    expect(models.map((model) => model.id)).toEqual([
      'deepseek/deepseek-v4-pro',
      'z-ai/glm-5.3',
      'openrouter/auto',
      'vendor/free-model:free',
      'google/image-only',
      'vendor/retired',
    ]);
    expect(next).toBeUndefined();
  });

  it('refuses a payload that is no model list', () => {
    expect(() => parseOpenRouterModels(LITELLM)).toThrow(/model list/);
    expect(() => parseOpenRouterModels(null)).toThrow(/model list/);
  });
});

describe('transformOpenRouterData', () => {
  it('prices a model as OpenRouter bills it, per million tokens without float noise', () => {
    const [model] = transformOpenRouterData(parsedPage(), NOW).filter(
      (entry) => entry.id === 'deepseek/deepseek-v4-pro'
    );

    expect(model).toEqual({
      id: 'deepseek/deepseek-v4-pro',
      provider: 'openrouter',
      catalogId: 'openrouter/deepseek/deepseek-v4-pro',
      displayName: 'DeepSeek: DeepSeek V4 Pro',
      pricing: { input: 0.888966, output: 1.777932, inputCached: 0.0740805 },
      contextWindow: 1048576,
      maxOutputTokens: 384000,
      capabilities: {
        supportsTools: true,
        supportsFunctions: true,
        supportsVision: false,
        supportsJson: true,
      },
      deprecated: false,
    });
  });

  it('reads cache write prices and ignores conditional overrides', () => {
    const glm = transformOpenRouterData(parsedPage(), NOW).find((m) => m.id === 'z-ai/glm-5.3');

    expect(glm?.pricing).toEqual({
      input: 0.6,
      output: 2.2,
      inputCacheWrite: 0.75,
      inputCacheWrite1h: 1.2,
    });
    expect(glm?.capabilities).toMatchObject({ supportsTools: false, supportsVision: true });
    expect(glm?.maxOutputTokens).toBeUndefined();
  });

  it('marks routers without a fixed price as unknown and keeps free models at zero', () => {
    const models = transformOpenRouterData(parsedPage(), NOW);

    expect(models.find((m) => m.id === 'openrouter/auto')).toMatchObject({
      priceUnknown: true,
      catalogId: 'openrouter/openrouter/auto',
    });
    const free = models.find((m) => m.id === 'vendor/free-model:free');
    expect(free?.pricing).toEqual({ input: 0, output: 0 });
    expect(free?.priceUnknown).toBeUndefined();
  });

  it('leaves out models that do not answer in text and deprecates expired ones', () => {
    const models = transformOpenRouterData(parsedPage(), NOW);

    expect(models.some((m) => m.id === 'google/image-only')).toBe(false);
    expect(models.find((m) => m.id === 'vendor/retired')?.deprecated).toBe(true);
  });
});

describe('fetchOpenRouterData', () => {
  it('follows the pages of the list', async () => {
    const second = `${OPENROUTER_MODELS_URL}?offset=1`;
    serve({
      [OPENROUTER_MODELS_URL]: { data: [PAGE.data[0]], links: { next: '/api/v1/models?offset=1' } },
      [second]: { data: [PAGE.data[1]], links: { next: null } },
    });

    const models = await fetchOpenRouterData();

    expect(models.map((model) => model.id)).toEqual(['deepseek/deepseek-v4-pro', 'z-ai/glm-5.3']);
  });

  it('stops on a list whose pages go round in a circle', async () => {
    serve({ [OPENROUTER_MODELS_URL]: { data: [], links: { next: OPENROUTER_MODELS_URL } } });

    await expect(fetchOpenRouterData()).rejects.toThrow(/did not end/);
  });

  it('fails on an error status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Unavailable' })
    );

    await expect(fetchOpenRouterData()).rejects.toThrow(/503/);
  });
});

describe('ModelRegistry with OpenRouter', () => {
  it('prices openrouter/<vendor>/<model> at OpenRouter, the vendor id at the vendor', async () => {
    serve({ [LITELLM_URL]: LITELLM, [OPENROUTER_MODELS_URL]: PAGE });
    const registry = await initializedRegistry();

    expect(registry.getPricing('openrouter/deepseek/deepseek-v4-pro')).toEqual({
      input: 0.888966,
      output: 1.777932,
      inputCached: 0.0740805,
    });
    expect(registry.getPrice('deepseek/deepseek-v4-pro')).toEqual({ input: 1.32, output: 3.96 });
    expect(registry.getModel('deepseek-v4-pro')?.provider).toBe('deepseek');
  });

  it('reads OpenRouter vendor z-ai as provider zai', async () => {
    serve({ [LITELLM_URL]: LITELLM, [OPENROUTER_MODELS_URL]: PAGE });
    const registry = await initializedRegistry();

    expect(registry.getModel('z-ai/glm-5.3')).toMatchObject({ provider: 'zai', id: 'glm-5.3' });
    expect(registry.getPrice('openrouter/z-ai/glm-5.3')).toEqual({ input: 0.6, output: 2.2 });
    expect(registry.getPrice('openrouter/openrouter/auto')).toBeNull();
    expect(registry.getModel('openrouter/auto')?.provider).toBe('openrouter');
  });

  it('falls back to the bundled OpenRouter copy when only OpenRouter cannot be fetched', async () => {
    serve({ [LITELLM_URL]: LITELLM, [OPENROUTER_MODELS_URL]: new Error('offline') });
    const registry = await initializedRegistry();
    const bundled = transformOpenRouterData(OPENROUTER_SNAPSHOT.models)[0];

    expect(bundled).toBeDefined();
    expect(registry.getModel(`openrouter/${bundled?.id}`)?.pricing).toEqual(bundled?.pricing);
    expect(registry.getPrice('deepseek/deepseek-v4-pro')).toEqual({ input: 1.32, output: 3.96 });
  });

  it('lets a live LiteLLM listing at OpenRouter win over the bundled OpenRouter copy', async () => {
    const bundled = transformOpenRouterData(OPENROUTER_SNAPSHOT.models)[0];
    if (!bundled) throw new Error('the bundled OpenRouter copy is empty');
    serve({
      [LITELLM_URL]: {
        [`openrouter/${bundled.id}`]: {
          litellm_provider: 'openrouter',
          input_cost_per_token: 0.000123,
          output_cost_per_token: 0.000456,
        },
      },
      [OPENROUTER_MODELS_URL]: new Error('offline'),
    });
    const registry = await initializedRegistry();

    expect(registry.getPrice(`openrouter/${bundled.id}`)).toEqual({ input: 123, output: 456 });
  });

  it('prices openrouter/* models offline from the bundled copy', () => {
    const registry = new ModelRegistry();
    const bundled = transformOpenRouterData(OPENROUTER_SNAPSHOT.models);
    const sample = bundled.find((model) => model.id.includes('/') && !model.priceUnknown);
    if (!sample) throw new Error('the bundled OpenRouter copy has no priced model');

    expect(registry.isInitialized()).toBe(false);
    expect(registry.getModel(`openrouter/${sample.id}`)).toMatchObject({
      provider: 'openrouter',
      id: sample.id,
      pricing: sample.pricing,
    });
  });

  it('bundles only priced models that answer in text', () => {
    expect(OPENROUTER_SNAPSHOT.models.length).toBeGreaterThan(0);
    for (const model of OPENROUTER_SNAPSHOT.models) {
      expect(Number(model.pricing.prompt)).toBeGreaterThanOrEqual(0);
      expect(Number(model.pricing.completion)).toBeGreaterThanOrEqual(0);
      expect(model.architecture?.output_modalities ?? ['text']).toContain('text');
    }
  });
});
