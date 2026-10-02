import { describe, it, expect } from 'vitest';
import {
  ModelInfoSchema,
  ModelPricingSchema,
  ModelCapabilitiesSchema,
  ProviderInfoSchema,
} from '../types';
import { BUILTIN_MODELS, BUILTIN_PROVIDERS } from '../providers/index';

describe('Zod schemas', () => {
  describe('ModelPricingSchema', () => {
    it('validates valid pricing', () => {
      const result = ModelPricingSchema.safeParse({ input: 2.5, output: 10 });
      expect(result.success).toBe(true);
    });

    it('validates pricing with cached costs', () => {
      const result = ModelPricingSchema.safeParse({
        input: 2.5,
        output: 10,
        inputCached: 1.25,
        outputCached: 5,
      });
      expect(result.success).toBe(true);
    });

    it('rejects missing required fields', () => {
      const result = ModelPricingSchema.safeParse({ input: 2.5 });
      expect(result.success).toBe(false);
    });
  });

  describe('ModelCapabilitiesSchema', () => {
    it('validates full capabilities', () => {
      const result = ModelCapabilitiesSchema.safeParse({
        supportsVision: true,
        supportsTools: true,
        supportsFunctions: true,
        supportsStreaming: true,
        supportsJson: true,
      });
      expect(result.success).toBe(true);
    });

    it('validates empty capabilities', () => {
      const result = ModelCapabilitiesSchema.safeParse({});
      expect(result.success).toBe(true);
    });
  });

  describe('ModelInfoSchema', () => {
    it('validates a complete model entry', () => {
      const result = ModelInfoSchema.safeParse({
        id: 'gpt-4o',
        provider: 'openai',
        displayName: 'GPT-4o',
        pricing: { input: 2.5, output: 10 },
        contextWindow: 128000,
        maxOutputTokens: 16384,
        capabilities: { supportsTools: true },
      });
      expect(result.success).toBe(true);
    });

    it('validates minimal model entry', () => {
      const result = ModelInfoSchema.safeParse({
        id: 'test',
        provider: 'test',
        displayName: 'Test',
        pricing: { input: 0, output: 0 },
        contextWindow: 4096,
      });
      expect(result.success).toBe(true);
    });

    it('rejects model without id', () => {
      const result = ModelInfoSchema.safeParse({
        provider: 'openai',
        displayName: 'Test',
        pricing: { input: 0, output: 0 },
        contextWindow: 4096,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('ProviderInfoSchema', () => {
    it('validates a provider entry', () => {
      const result = ProviderInfoSchema.safeParse({
        id: 'openai',
        name: 'OpenAI',
        website: 'https://openai.com',
        models: ['gpt-4o'],
      });
      expect(result.success).toBe(true);
    });

    it('validates without optional website', () => {
      const result = ProviderInfoSchema.safeParse({
        id: 'test',
        name: 'Test',
        models: [],
      });
      expect(result.success).toBe(true);
    });
  });
});

describe('Builtin data integrity', () => {
  it('all builtin models pass schema validation', () => {
    for (const model of BUILTIN_MODELS) {
      const result = ModelInfoSchema.safeParse(model);
      expect(result.success, `Model ${model.id} failed validation`).toBe(true);
    }
  });

  it('all builtin providers pass schema validation', () => {
    for (const provider of BUILTIN_PROVIDERS) {
      const result = ProviderInfoSchema.safeParse({ ...provider, models: [] });
      expect(result.success, `Provider ${provider.id} failed validation`).toBe(true);
    }
  });

  it('all builtin models have positive context windows', () => {
    for (const model of BUILTIN_MODELS) {
      expect(model.contextWindow, `Model ${model.id} has invalid contextWindow`).toBeGreaterThan(0);
    }
  });

  it('all builtin models have non-negative pricing', () => {
    for (const model of BUILTIN_MODELS) {
      expect(
        model.pricing.input,
        `Model ${model.id} has negative input price`
      ).toBeGreaterThanOrEqual(0);
      expect(
        model.pricing.output,
        `Model ${model.id} has negative output price`
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it('includes current flagship fallback models', () => {
    const modelIds = BUILTIN_MODELS.map((model) => model.id);

    expect(modelIds).toEqual(
      expect.arrayContaining([
        'gpt-5.5',
        'gpt-5.4',
        'gpt-5.4-mini',
        'claude-fable-5',
        'claude-opus-4-8',
        'claude-sonnet-4-6',
        'gemini-3.5-flash',
        'gemini-3.1-flash-lite',
        'gpt-6-astra',
        'gpt-6.1-sol',
        'gpt-6-luna',
        'gpt-5.6-sol',
        'claude-fable-5-1',
        'claude-opus-5-5',
        'claude-sonnet-5-5',
        'gemini-3.8-flash',
        'gemini-3.5-flash-lite',
      ])
    );
  });

  it('keeps current flagship fallback pricing in sync', () => {
    const byId = new Map(BUILTIN_MODELS.map((model) => [model.id, model]));

    expect(byId.get('gpt-5.5')?.pricing).toEqual({ input: 5, output: 30 });
    expect(byId.get('gpt-5.4-mini')?.pricing).toEqual({ input: 0.75, output: 4.5 });
    expect(byId.get('claude-fable-5')?.pricing).toEqual({ input: 10, output: 50 });
    expect(byId.get('claude-sonnet-4-6')?.maxOutputTokens).toBe(128000);
    expect(byId.get('gemini-3.5-flash')?.pricing).toEqual({ input: 1.5, output: 9 });
    expect(byId.get('gpt-6.1-sol')?.pricing).toEqual({ input: 2, output: 10, inputCached: 0.1 });
    expect(byId.get('gpt-6-astra')?.pricing).toEqual({ input: 10, output: 50, inputCached: 1 });
    expect(byId.get('gpt-6-luna')?.pricing).toEqual({ input: 0.1, output: 0.5, inputCached: 0.01 });
    expect(byId.get('gpt-6.1-sol')?.contextWindow).toBe(1050000);
    expect(byId.get('claude-opus-5-5')?.pricing).toEqual({
      input: 4,
      output: 20,
      inputCached: 0.2,
    });
    expect(byId.get('claude-sonnet-5-5')?.pricing).toEqual({
      input: 2,
      output: 10,
      inputCached: 0.2,
    });
    expect(byId.get('claude-sonnet-5-5')?.contextWindow).toBe(1000000);
    expect(byId.get('gemini-3.8-flash')?.pricing).toEqual({
      input: 0.75,
      output: 3.75,
      inputCached: 0.075,
    });
    expect(byId.get('gemini-3.5-flash-lite')?.pricing).toEqual({ input: 0.3, output: 2.5 });
  });

  it('marks retired and shutting-down models as deprecated', () => {
    const byId = new Map(BUILTIN_MODELS.map((model) => [model.id, model]));

    for (const id of [
      'gpt-4',
      'gpt-4.1-nano-2025-04-14',
      'o3-mini',
      'o4-mini-2025-04-16',
      'claude-sonnet-4-20250514',
      'claude-3-5-haiku-20241022',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-2.0-flash',
    ]) {
      expect(byId.get(id)?.deprecated, id).toBe(true);
    }

    for (const id of [
      'gpt-6.1-sol',
      'claude-sonnet-5-5',
      'claude-haiku-4-5-20251001',
      'gemini-3.8-flash',
    ]) {
      expect(byId.get(id)?.deprecated, id).toBeFalsy();
    }
  });
});
