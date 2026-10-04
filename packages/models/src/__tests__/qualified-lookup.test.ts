import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ModelRegistry,
  calculateCost,
  getPricing,
  initializeModels,
  shutdownModels,
} from '../registry';
import type { LiteLLMModelData } from '../types';

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

/** Entries of the live LiteLLM catalogue, in the order the catalogue lists them. */
const CATALOGUE: LiteLLMModelData = {
  'azure/gpt-6-luna': {
    litellm_provider: 'azure',
    input_cost_per_token: 1e-7,
    output_cost_per_token: 5e-7,
    max_input_tokens: 922000,
    max_output_tokens: 128000,
  },
  'azure_ai/deepseek-v4-pro': {
    litellm_provider: 'azure_ai',
    input_cost_per_token: 0.00000174,
    output_cost_per_token: 0.00000348,
    max_input_tokens: 1000000,
    max_output_tokens: 384000,
  },
  'dashscope/qwen3.8-flash': {
    litellm_provider: 'dashscope',
    input_cost_per_token: 1.5e-7,
    output_cost_per_token: 4.7e-7,
    max_input_tokens: 991808,
    max_output_tokens: 131072,
  },
  'gemini/gemini-3.8-flash': {
    litellm_provider: 'gemini',
    input_cost_per_token: 7.5e-7,
    output_cost_per_token: 0.00000375,
    max_input_tokens: 1048576,
    max_output_tokens: 65536,
  },
  'gemini-3.8-flash': {
    litellm_provider: 'vertex_ai-language-models',
    input_cost_per_token: 7.5e-7,
    output_cost_per_token: 0.00000375,
    max_input_tokens: 1048576,
    max_output_tokens: 65536,
  },
  'gpt-6-luna': {
    litellm_provider: 'openai',
    input_cost_per_token: 1e-7,
    output_cost_per_token: 5e-7,
    max_input_tokens: 922000,
    max_output_tokens: 128000,
  },
  'openrouter/deepseek/deepseek-v4-pro': {
    litellm_provider: 'openrouter',
    input_cost_per_token: 2.088e-7,
    output_cost_per_token: 4.176e-7,
    max_input_tokens: 1048576,
    max_output_tokens: 384000,
  },
  'deepseek-v4-pro': {
    litellm_provider: 'deepseek',
    input_cost_per_token: 0.00000132,
    output_cost_per_token: 0.00000396,
    max_input_tokens: 1000000,
    max_output_tokens: 393216,
  },
  'deepseek/deepseek-v4-pro': {
    litellm_provider: 'deepseek',
    input_cost_per_token: 0.00000132,
    output_cost_per_token: 0.00000396,
    max_input_tokens: 1000000,
    max_output_tokens: 393216,
  },
  'openrouter/qwen/qwen3.8-flash': {
    litellm_provider: 'openrouter',
    input_cost_per_token: 1.5e-7,
    output_cost_per_token: 4.7e-7,
    max_input_tokens: 1000000,
    max_output_tokens: 131072,
  },
  'aihubmix/qwen3.8-flash': {
    litellm_provider: 'aihubmix',
    input_cost_per_token: 1.126e-7,
    output_cost_per_token: 3.80025e-7,
    max_input_tokens: 1000000,
    max_output_tokens: 131072,
  },
  'openrouter/openai/gpt-6-luna': {
    litellm_provider: 'openrouter',
    input_cost_per_token: 1e-7,
    output_cost_per_token: 5e-7,
    max_input_tokens: 1050000,
    max_output_tokens: 128000,
  },
};

const REVERSED: LiteLLMModelData = Object.fromEntries(Object.entries(CATALOGUE).reverse());

const originalFetch = globalThis.fetch;

function serveCatalogue(data: LiteLLMModelData): void {
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(data) });
}

async function registryFor(data: LiteLLMModelData): Promise<ModelRegistry> {
  serveCatalogue(data);
  const registry = new ModelRegistry({ cache: { ttl: 60_000, storage: 'memory' } });
  await registry.initialize();
  return registry;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  shutdownModels();
});

describe('provider-qualified lookups', () => {
  it('prices an OpenRouter model at the OpenRouter price, not another provider', async () => {
    const registry = await registryFor(CATALOGUE);

    const model = registry.getModel('openrouter/deepseek/deepseek-v4-pro');

    expect(model).toMatchObject({
      id: 'deepseek/deepseek-v4-pro',
      provider: 'openrouter',
      catalogId: 'openrouter/deepseek/deepseek-v4-pro',
      pricing: { input: 0.2088, output: 0.4176 },
    });
  });

  it('resolves every catalogue id to its own entry', async () => {
    const registry = await registryFor(CATALOGUE);

    expect(registry.getModel('azure_ai/deepseek-v4-pro')).toMatchObject({
      provider: 'azure',
      pricing: { input: 1.74, output: 3.48 },
    });
    expect(registry.getModel('deepseek/deepseek-v4-pro')).toMatchObject({
      provider: 'deepseek',
      pricing: { input: 1.32, output: 3.96 },
    });
    expect(registry.getModel('openrouter/qwen/qwen3.8-flash')?.provider).toBe('openrouter');
    expect(registry.getModel('aihubmix/qwen3.8-flash')?.provider).toBe('aihubmix');
  });

  it('accepts Cogitator provider prefixes for catalogue entries', async () => {
    const registry = await registryFor(CATALOGUE);

    expect(registry.getModel('google/gemini-3.8-flash')).toMatchObject({
      id: 'gemini-3.8-flash',
      provider: 'google',
      pricing: { input: 0.75, output: 3.75 },
    });
    expect(registry.getModel('gemini/gemini-3.8-flash')?.id).toBe('gemini-3.8-flash');
    expect(registry.getModel('openai/gpt-6-luna')).toMatchObject({
      id: 'gpt-6-luna',
      provider: 'openai',
    });
    expect(registry.getModel('azure/gpt-6-luna')?.provider).toBe('azure');
  });

  it('falls back to the model itself when the provider does not list it', async () => {
    const registry = await registryFor(CATALOGUE);

    expect(registry.getModel('openai/deepseek/deepseek-v4-pro')?.provider).toBe('deepseek');
    expect(registry.getModel('ollama/gpt-6-luna')?.provider).toBe('openai');
  });

  it('lists each model once per provider', async () => {
    const registry = await registryFor(CATALOGUE);

    const deepseek = registry.listModels({ provider: 'deepseek' });
    expect(deepseek.map((model) => model.id)).toEqual(['deepseek-v4-pro']);
    expect(registry.getProvider('openrouter')?.name).toBe('OpenRouter');
  });
});

describe('bare model names', () => {
  it('resolve to the first-party entry wherever the catalogue lists it', async () => {
    for (const data of [CATALOGUE, REVERSED]) {
      const registry = await registryFor(data);
      expect(registry.getModel('deepseek-v4-pro')).toMatchObject({
        provider: 'deepseek',
        pricing: { input: 1.32, output: 3.96 },
      });
      expect(registry.getModel('gpt-6-luna')?.provider).toBe('openai');
      registry.shutdown();
    }
  });

  it('resolve the same way whatever the catalogue order without a first-party entry', async () => {
    const forward = (await registryFor(CATALOGUE)).getModel('qwen3.8-flash');
    const backward = (await registryFor(REVERSED)).getModel('qwen3.8-flash');

    expect(forward).not.toBeNull();
    expect(forward?.catalogId).toBe(backward?.catalogId);
    expect(forward?.provider).toBe('openrouter');
  });
});

describe('built-in models', () => {
  it('follow the same rules before the catalogue loads', () => {
    const registry = new ModelRegistry();

    expect(registry.getModel('openai/gpt-6-luna')?.id).toBe('gpt-6-luna');
    expect(registry.getModel('openrouter/openai/gpt-6-luna')?.id).toBe('gpt-6-luna');
    expect(registry.getModel('openrouter/deepseek/deepseek-v4-pro')).toBeNull();
  });
});

describe('pricing helpers', () => {
  it('price a qualified id at its own provider once the models are initialized', async () => {
    serveCatalogue(CATALOGUE);
    await initializeModels();

    expect(getPricing('openrouter/deepseek/deepseek-v4-pro')).toMatchObject({
      input: 0.2088,
      output: 0.4176,
    });
    expect(
      calculateCost('openrouter/deepseek/deepseek-v4-pro', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      })
    ).toBeCloseTo(0.6264, 10);
    expect(
      calculateCost('azure_ai/deepseek-v4-pro', { inputTokens: 1_000_000, outputTokens: 0 })
    ).toBeCloseTo(1.74, 10);
  });
});
