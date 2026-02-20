import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { ModelRegistry, transformLiteLLMData, BUILTIN_MODELS } from '@cogitator-ai/models';

type LiteLLMEntry = {
  max_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  input_cost_per_character?: number;
  output_cost_per_character?: number;
  litellm_provider?: string;
  supports_function_calling?: boolean;
  supports_vision?: boolean;
  supports_response_schema?: boolean;
  supports_tool_choice?: boolean;
  deprecation_date?: string;
};

type LiteLLMData = Record<string, LiteLLMEntry>;

describe('Models: ModelRegistry', () => {
  let registry: ModelRegistry;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('no network in tests'));

    registry = new ModelRegistry({
      fallbackToBuiltin: true,
      cache: { ttl: 60_000, storage: 'memory' },
    });
    await registry.initialize();
  });

  afterAll(() => {
    registry.shutdown();
    globalThis.fetch = originalFetch;
  });

  it('initializes with builtin data', () => {
    expect(registry.isInitialized()).toBe(true);
    expect(registry.getModelCount()).toBeGreaterThan(0);
    expect(registry.getModelCount()).toBe(BUILTIN_MODELS.length);
  });

  it('getModel returns model info for known model', () => {
    const model = registry.getModel('gpt-4o');
    expect(model).not.toBeNull();
    expect(model!.id).toBe('gpt-4o');
    expect(model!.provider).toBe('openai');
    expect(model!.pricing.input).toBeTypeOf('number');
    expect(model!.pricing.output).toBeTypeOf('number');
    expect(model!.contextWindow).toBeGreaterThan(0);
    expect(model!.displayName).toBeTruthy();
  });

  it('getModel returns null for unknown model', () => {
    expect(registry.getModel('nonexistent-model-xyz')).toBeNull();
  });

  it('getModel resolves aliases', () => {
    const model = registry.getModel('gpt-4.1');
    expect(model).not.toBeNull();
    expect(model!.id).toBe('gpt-4.1-2025-04-14');
    expect(model!.provider).toBe('openai');
  });

  it('getModel normalizes provider prefix in id', () => {
    const direct = registry.getModel('gpt-4o');
    const prefixed = registry.getModel('openai/gpt-4o');
    expect(direct).not.toBeNull();
    expect(prefixed).not.toBeNull();
    expect(direct!.id).toBe(prefixed!.id);
  });

  it('listModels returns all models without filter', () => {
    const all = registry.listModels();
    expect(all.length).toBe(registry.getModelCount());
    expect(all.length).toBeGreaterThan(0);
  });

  it('listModels filters by provider', () => {
    const openaiModels = registry.listModels({ provider: 'openai' });
    expect(openaiModels.length).toBeGreaterThan(0);
    expect(openaiModels.every((m) => m.provider === 'openai')).toBe(true);

    const anthropicModels = registry.listModels({ provider: 'anthropic' });
    expect(anthropicModels.length).toBeGreaterThan(0);
    expect(anthropicModels.every((m) => m.provider === 'anthropic')).toBe(true);

    expect(openaiModels.length + anthropicModels.length).toBeLessThanOrEqual(
      registry.getModelCount()
    );
  });

  it('listModels filters by supportsTools', () => {
    const toolModels = registry.listModels({ supportsTools: true });
    expect(toolModels.length).toBeGreaterThan(0);
    expect(toolModels.every((m) => m.capabilities?.supportsTools === true)).toBe(true);

    const allModels = registry.listModels();
    expect(toolModels.length).toBeLessThanOrEqual(allModels.length);
  });

  it('listModels filters by supportsVision', () => {
    const visionModels = registry.listModels({ supportsVision: true });
    expect(visionModels.length).toBeGreaterThan(0);
    expect(visionModels.every((m) => m.capabilities?.supportsVision === true)).toBe(true);
  });

  it('listModels filters by minContextWindow', () => {
    const largeContext = registry.listModels({ minContextWindow: 200_000 });
    expect(largeContext.length).toBeGreaterThan(0);
    expect(largeContext.every((m) => m.contextWindow >= 200_000)).toBe(true);
  });

  it('listModels filters by maxPricePerMillion', () => {
    const cheapModels = registry.listModels({ maxPricePerMillion: 1 });
    expect(cheapModels.length).toBeGreaterThan(0);
    for (const m of cheapModels) {
      const avg = (m.pricing.input + m.pricing.output) / 2;
      expect(avg).toBeLessThanOrEqual(1);
    }
  });

  it('listModels excludes deprecated models', () => {
    const activeModels = registry.listModels({ excludeDeprecated: true });
    const allModels = registry.listModels();
    expect(activeModels.length).toBeGreaterThan(0);
    expect(activeModels.length).toBeLessThan(allModels.length);
    expect(activeModels.every((m) => !m.deprecated)).toBe(true);
  });

  it('listModels combines multiple filters', () => {
    const filtered = registry.listModels({
      provider: 'openai',
      supportsTools: true,
      excludeDeprecated: true,
    });
    expect(filtered.length).toBeGreaterThan(0);
    for (const m of filtered) {
      expect(m.provider).toBe('openai');
      expect(m.capabilities?.supportsTools).toBe(true);
      expect(m.deprecated).toBeFalsy();
    }
  });

  it('getPrice returns pricing for known model', () => {
    const price = registry.getPrice('gpt-4o');
    expect(price).not.toBeNull();
    expect(price!.input).toBeTypeOf('number');
    expect(price!.output).toBeTypeOf('number');
    expect(price!.input).toBe(2.5);
    expect(price!.output).toBe(10);
  });

  it('getPrice returns null for unknown model', () => {
    expect(registry.getPrice('nonexistent-model-xyz')).toBeNull();
  });

  it('listProviders returns provider info', () => {
    const providers = registry.listProviders();
    expect(providers.length).toBeGreaterThan(0);

    const ids = providers.map((p) => p.id);
    expect(ids).toContain('openai');
    expect(ids).toContain('anthropic');
    expect(ids).toContain('google');

    for (const p of providers) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
    }
  });

  it('listProviders includes model lists per provider', () => {
    const providers = registry.listProviders();
    const openai = providers.find((p) => p.id === 'openai');
    expect(openai).toBeDefined();
    expect(openai!.models.length).toBeGreaterThan(0);
    expect(openai!.models).toContain('gpt-4o');
  });
});

describe('Models: transformLiteLLMData', () => {
  it('transforms raw LiteLLM entries into ModelInfo[]', () => {
    const raw: LiteLLMData = {
      'gpt-4o': {
        max_input_tokens: 128000,
        max_output_tokens: 16384,
        input_cost_per_token: 0.0000025,
        output_cost_per_token: 0.00001,
        litellm_provider: 'openai',
        supports_function_calling: true,
        supports_vision: true,
        supports_response_schema: true,
      },
      'anthropic/claude-3-5-sonnet': {
        max_tokens: 200000,
        max_output_tokens: 8192,
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        litellm_provider: 'anthropic',
        supports_function_calling: true,
        supports_vision: true,
        deprecation_date: '2020-01-01',
      },
    };

    const models = transformLiteLLMData(raw);
    expect(models.length).toBe(2);

    const gpt4o = models.find((m) => m.id === 'gpt-4o');
    expect(gpt4o).toBeDefined();
    expect(gpt4o!.provider).toBe('openai');
    expect(gpt4o!.contextWindow).toBe(128000);
    expect(gpt4o!.maxOutputTokens).toBe(16384);
    expect(gpt4o!.pricing.input).toBe(2.5);
    expect(gpt4o!.pricing.output).toBe(10);
    expect(gpt4o!.capabilities?.supportsTools).toBe(true);
    expect(gpt4o!.capabilities?.supportsVision).toBe(true);
    expect(gpt4o!.capabilities?.supportsJson).toBe(true);
    expect(gpt4o!.deprecated).toBe(false);

    const claude = models.find((m) => m.id === 'claude-3-5-sonnet');
    expect(claude).toBeDefined();
    expect(claude!.provider).toBe('anthropic');
    expect(claude!.deprecated).toBe(true);
  });

  it('skips sample_spec entries', () => {
    const raw: LiteLLMData = {
      sample_spec: {
        max_tokens: 100,
        input_cost_per_token: 0.001,
        output_cost_per_token: 0.001,
      },
      'gpt-4': {
        max_tokens: 8192,
        input_cost_per_token: 0.00003,
        output_cost_per_token: 0.00006,
        litellm_provider: 'openai',
      },
    };

    const models = transformLiteLLMData(raw);
    expect(models.length).toBe(1);
    expect(models[0].id).toBe('gpt-4');
  });

  it('deduplicates models by normalized id', () => {
    const raw: LiteLLMData = {
      'gpt-4o': {
        max_tokens: 128000,
        input_cost_per_token: 0.0000025,
        output_cost_per_token: 0.00001,
        litellm_provider: 'openai',
      },
      'openai/gpt-4o': {
        max_tokens: 128000,
        input_cost_per_token: 0.0000025,
        output_cost_per_token: 0.00001,
        litellm_provider: 'openai',
      },
    };

    const models = transformLiteLLMData(raw);
    const gpt4oCount = models.filter((m) => m.id === 'gpt-4o').length;
    expect(gpt4oCount).toBe(1);
  });

  it('calculates pricing from per-character costs', () => {
    const raw: LiteLLMData = {
      'char-model': {
        max_tokens: 4096,
        input_cost_per_character: 0.0000005,
        output_cost_per_character: 0.000001,
        litellm_provider: 'google',
      },
    };

    const models = transformLiteLLMData(raw);
    expect(models.length).toBe(1);

    const pricing = models[0].pricing;
    expect(pricing.input).toBeGreaterThan(0);
    expect(pricing.output).toBeGreaterThan(0);
    expect(pricing.input).toBe(Math.round(0.0000005 * 4 * 1_000_000 * 1000) / 1000);
    expect(pricing.output).toBe(Math.round(0.000001 * 4 * 1_000_000 * 1000) / 1000);
  });

  it('handles entries with no cost info', () => {
    const raw: LiteLLMData = {
      'free-model': {
        max_tokens: 4096,
        litellm_provider: 'ollama',
      },
    };

    const models = transformLiteLLMData(raw);
    expect(models.length).toBe(1);
    expect(models[0].pricing.input).toBe(0);
    expect(models[0].pricing.output).toBe(0);
  });

  it('returns sorted output', () => {
    const raw: LiteLLMData = {
      'z-model': {
        max_tokens: 4096,
        input_cost_per_token: 0.001,
        output_cost_per_token: 0.001,
      },
      'a-model': {
        max_tokens: 4096,
        input_cost_per_token: 0.001,
        output_cost_per_token: 0.001,
      },
    };

    const models = transformLiteLLMData(raw);
    expect(models[0].id).toBe('a-model');
    expect(models[1].id).toBe('z-model');
  });
});

describe('Models: Registry lifecycle', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('no network in tests'));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('lazy-initializes on first access if not explicitly initialized', () => {
    const lazy = new ModelRegistry({ fallbackToBuiltin: true });
    expect(lazy.isInitialized()).toBe(false);

    const models = lazy.listModels();
    expect(lazy.isInitialized()).toBe(true);
    expect(models.length).toBeGreaterThan(0);

    lazy.shutdown();
  });

  it('shutdown cleans up without errors', async () => {
    const reg = new ModelRegistry({ fallbackToBuiltin: true });
    await reg.initialize();
    expect(reg.isInitialized()).toBe(true);

    reg.shutdown();
    expect(reg.isInitialized()).toBe(true);
  });

  it('multiple initialize calls are idempotent', async () => {
    const reg = new ModelRegistry({ fallbackToBuiltin: true });
    await reg.initialize();
    const count1 = reg.getModelCount();

    await reg.initialize();
    const count2 = reg.getModelCount();

    expect(count1).toBe(count2);
    reg.shutdown();
  });
});
