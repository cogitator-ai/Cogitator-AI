import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ModelRegistry,
  getModelRegistry,
  getPrice,
  getModel,
  listModels,
  shutdownModels,
} from '../registry';
import { BUILTIN_MODELS } from '../providers/index';

describe('ModelRegistry', () => {
  let registry: ModelRegistry;

  beforeEach(() => {
    registry = new ModelRegistry({ fallbackToBuiltin: true });
  });

  describe('getModel', () => {
    it('should return model by exact id', () => {
      const model = registry.getModel('gpt-4o');
      expect(model).toBeDefined();
      expect(model?.id).toBe('gpt-4o');
      expect(model?.provider).toBe('openai');
    });

    it('should return model by alias', () => {
      const model = registry.getModel('claude-sonnet-4-5');
      expect(model).toBeDefined();
      expect(model?.provider).toBe('anthropic');
    });

    it('should return null for unknown model', () => {
      const model = registry.getModel('unknown-model-xyz');
      expect(model).toBeNull();
    });

    it('should handle provider prefix in model id', () => {
      const model = registry.getModel('openai/gpt-4o');
      expect(model).toBeDefined();
      expect(model?.id).toBe('gpt-4o');
    });

    it('should be case insensitive', () => {
      const model = registry.getModel('GPT-4O');
      expect(model).toBeDefined();
      expect(model?.id).toBe('gpt-4o');
    });
  });

  describe('getPrice', () => {
    it('should return pricing for known model', () => {
      const price = registry.getPrice('gpt-4o');
      expect(price).toBeDefined();
      expect(price?.input).toBeGreaterThan(0);
      expect(price?.output).toBeGreaterThan(0);
    });

    it('should return null for unknown model', () => {
      const price = registry.getPrice('unknown-model');
      expect(price).toBeNull();
    });

    it('should return correct pricing for gpt-4o-mini', () => {
      const price = registry.getPrice('gpt-4o-mini');
      expect(price).toBeDefined();
      expect(price?.input).toBe(0.15);
      expect(price?.output).toBe(0.6);
    });

    it('should return correct pricing for claude-sonnet-4-5', () => {
      const price = registry.getPrice('claude-sonnet-4-5-20250929');
      expect(price).toBeDefined();
      expect(price?.input).toBe(3);
      expect(price?.output).toBe(15);
    });
  });

  describe('listModels', () => {
    it('should return all builtin models', () => {
      const models = registry.listModels();
      expect(models.length).toBeGreaterThanOrEqual(BUILTIN_MODELS.length);
    });

    it('should filter by provider', () => {
      const openaiModels = registry.listModels({ provider: 'openai' });
      expect(openaiModels.every((m) => m.provider === 'openai')).toBe(true);
      expect(openaiModels.length).toBeGreaterThan(0);
    });

    it('should filter by tool support', () => {
      const toolModels = registry.listModels({ supportsTools: true });
      expect(toolModels.every((m) => m.capabilities?.supportsTools)).toBe(true);
    });

    it('should filter by vision support', () => {
      const visionModels = registry.listModels({ supportsVision: true });
      expect(visionModels.every((m) => m.capabilities?.supportsVision)).toBe(true);
    });

    it('should filter by context window', () => {
      const largeContextModels = registry.listModels({ minContextWindow: 100000 });
      expect(largeContextModels.every((m) => m.contextWindow >= 100000)).toBe(true);
    });

    it('should filter by max price', () => {
      const cheapModels = registry.listModels({ maxPricePerMillion: 1 });
      expect(cheapModels.every((m) => (m.pricing.input + m.pricing.output) / 2 <= 1)).toBe(true);
    });
  });

  describe('listProviders', () => {
    it('should return all providers', () => {
      const providers = registry.listProviders();
      expect(providers.length).toBeGreaterThan(0);

      const providerIds = providers.map((p) => p.id);
      expect(providerIds).toContain('openai');
      expect(providerIds).toContain('anthropic');
      expect(providerIds).toContain('google');
    });

    it('should include model count per provider', () => {
      const providers = registry.listProviders();
      const openai = providers.find((p) => p.id === 'openai');
      expect(openai?.models.length).toBeGreaterThan(0);
    });
  });
});

describe('Global helpers', () => {
  it('getModelRegistry should return singleton', () => {
    const reg1 = getModelRegistry();
    const reg2 = getModelRegistry();
    expect(reg1).toBe(reg2);
  });

  it('getPrice should work without initialization', () => {
    const price = getPrice('gpt-4o');
    expect(price).toBeDefined();
  });

  it('getModel should work without initialization', () => {
    const model = getModel('gpt-4o');
    expect(model).toBeDefined();
  });

  it('listModels should work without initialization', () => {
    const models = listModels();
    expect(models.length).toBeGreaterThan(0);
  });
});

describe('ModelRegistry initialization', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should fallback to builtin when network fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const reg = new ModelRegistry({ fallbackToBuiltin: true });
    await reg.initialize();

    expect(reg.isInitialized()).toBe(true);
    expect(reg.getModelCount()).toBeGreaterThan(0);
  });

  it('should throw when fallbackToBuiltin is false and network fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const reg = new ModelRegistry({ fallbackToBuiltin: false });
    await expect(reg.initialize()).rejects.toThrow('Network error');
  });

  it('should start autoRefresh even when loaded from cache', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('no network'));

    const reg = new ModelRegistry({
      fallbackToBuiltin: true,
      autoRefresh: true,
      refreshInterval: 1000,
    });
    await reg.initialize();

    expect(reg.isInitialized()).toBe(true);
    reg.shutdown();
  });
});

describe('ModelRegistry filters', () => {
  let registry: ModelRegistry;

  beforeEach(() => {
    registry = new ModelRegistry({ fallbackToBuiltin: true });
  });

  it('should exclude deprecated models', () => {
    const activeModels = registry.listModels({ excludeDeprecated: true });
    expect(activeModels.every((m) => !m.deprecated)).toBe(true);
    expect(activeModels.length).toBeGreaterThan(0);

    const allModels = registry.listModels();
    expect(activeModels.length).toBeLessThan(allModels.length);
  });

  it('should return empty array for impossible filter', () => {
    const result = registry.listModels({ provider: 'nonexistent-provider-xyz' });
    expect(result).toEqual([]);
  });
});

describe('ModelRegistry getProvider', () => {
  let registry: ModelRegistry;

  beforeEach(() => {
    registry = new ModelRegistry({ fallbackToBuiltin: true });
  });

  it('should return provider by id', () => {
    const provider = registry.getProvider('openai');
    expect(provider).not.toBeNull();
    expect(provider!.id).toBe('openai');
    expect(provider!.name).toBe('OpenAI');
    expect(provider!.models.length).toBeGreaterThan(0);
  });

  it('should return null for unknown provider', () => {
    expect(registry.getProvider('nonexistent')).toBeNull();
  });
});

describe('shutdownModels', () => {
  it('should reset the default registry', () => {
    const reg1 = getModelRegistry();
    expect(reg1).toBeDefined();

    shutdownModels();

    const reg2 = getModelRegistry();
    expect(reg2).not.toBe(reg1);
  });
});
