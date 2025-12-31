import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchLiteLLMData, transformLiteLLMData } from '../fetcher';
import type { LiteLLMModelData } from '../types';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('fetchLiteLLMData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches and returns model data', async () => {
    const mockData = { 'gpt-4': { max_tokens: 8192 } };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockData),
    });

    const result = await fetchLiteLLMData();

    expect(result).toEqual(mockData);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('litellm'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
        }),
      })
    );
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(fetchLiteLLMData()).rejects.toThrow('Failed to fetch LiteLLM data');
  });

  it('uses abort controller for timeout', async () => {
    mockFetch.mockImplementation((_url, options) => {
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    });

    await fetchLiteLLMData();

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      })
    );
  });
});

describe('transformLiteLLMData', () => {
  it('transforms model data correctly', () => {
    const data: LiteLLMModelData = {
      'gpt-4': {
        max_tokens: 8192,
        max_input_tokens: 128000,
        max_output_tokens: 8192,
        input_cost_per_token: 0.00003,
        output_cost_per_token: 0.00006,
        litellm_provider: 'openai',
        supports_function_calling: true,
        supports_vision: true,
      },
    };

    const result = transformLiteLLMData(data);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'gpt-4',
      provider: 'openai',
      contextWindow: 128000,
      maxOutputTokens: 8192,
      capabilities: {
        supportsTools: true,
        supportsVision: true,
      },
    });
  });

  it('skips sample_spec entries', () => {
    const data: LiteLLMModelData = {
      sample_spec: { max_tokens: 100 },
      'sample_spec/test': { max_tokens: 100 },
      'gpt-4': { max_tokens: 8192, litellm_provider: 'openai' },
    };

    const result = transformLiteLLMData(data);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('gpt-4');
  });

  it('deduplicates models by normalized id', () => {
    const data: LiteLLMModelData = {
      'openai/gpt-4': { max_tokens: 8192, litellm_provider: 'openai' },
      'azure/gpt-4': { max_tokens: 8192, litellm_provider: 'azure' },
    };

    const result = transformLiteLLMData(data);

    expect(result).toHaveLength(1);
  });

  it('calculates pricing correctly', () => {
    const data: LiteLLMModelData = {
      'gpt-4': {
        max_tokens: 8192,
        input_cost_per_token: 0.00003,
        output_cost_per_token: 0.00006,
      },
    };

    const result = transformLiteLLMData(data);

    expect(result[0].pricing.input).toBe(30);
    expect(result[0].pricing.output).toBe(60);
  });

  it('calculates pricing from character cost', () => {
    const data: LiteLLMModelData = {
      'test-model': {
        max_tokens: 8192,
        input_cost_per_character: 0.0000001,
        output_cost_per_character: 0.0000002,
      },
    };

    const result = transformLiteLLMData(data);

    expect(result[0].pricing.input).toBeGreaterThan(0);
    expect(result[0].pricing.output).toBeGreaterThan(0);
  });

  it('marks deprecated models', () => {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 1);

    const data: LiteLLMModelData = {
      'old-model': {
        max_tokens: 4096,
        deprecation_date: pastDate.toISOString(),
      },
    };

    const result = transformLiteLLMData(data);

    expect(result[0].deprecated).toBe(true);
  });

  it('does not mark future deprecated models', () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30);

    const data: LiteLLMModelData = {
      'new-model': {
        max_tokens: 4096,
        deprecation_date: futureDate.toISOString(),
      },
    };

    const result = transformLiteLLMData(data);

    expect(result[0].deprecated).toBe(false);
  });

  it('normalizes provider names', () => {
    const data: LiteLLMModelData = {
      'claude-3': { max_tokens: 200000, litellm_provider: 'anthropic' },
      'gemini-pro': { max_tokens: 32000, litellm_provider: 'vertex_ai' },
      'llama-3': { max_tokens: 8192, litellm_provider: 'together_ai' },
    };

    const result = transformLiteLLMData(data);
    const providers = result.map((m) => m.provider);

    expect(providers).toContain('anthropic');
    expect(providers).toContain('google');
    expect(providers).toContain('together');
  });

  it('infers provider from model id prefix', () => {
    const data: LiteLLMModelData = {
      'gpt-4-turbo': { max_tokens: 128000 },
      'claude-3-opus': { max_tokens: 200000 },
    };

    const result = transformLiteLLMData(data);

    expect(result.find((m) => m.id === 'gpt-4-turbo')?.provider).toBe('openai');
    expect(result.find((m) => m.id === 'claude-3-opus')?.provider).toBe('anthropic');
  });

  it('creates display name from id', () => {
    const data: LiteLLMModelData = {
      'gpt-4-turbo-preview': { max_tokens: 128000 },
    };

    const result = transformLiteLLMData(data);

    expect(result[0].displayName).toBe('GPT 4 Turbo Preview');
  });

  it('defaults context window to 4096', () => {
    const data: LiteLLMModelData = {
      'unknown-model': {},
    };

    const result = transformLiteLLMData(data);

    expect(result[0].contextWindow).toBe(4096);
  });

  it('sorts models by id', () => {
    const data: LiteLLMModelData = {
      'z-model': { max_tokens: 100 },
      'a-model': { max_tokens: 100 },
      'm-model': { max_tokens: 100 },
    };

    const result = transformLiteLLMData(data);

    expect(result[0].id).toBe('a-model');
    expect(result[1].id).toBe('m-model');
    expect(result[2].id).toBe('z-model');
  });
});
