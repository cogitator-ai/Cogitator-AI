import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  API_KEY_ENV,
  fetchOllamaModelOptions,
  fetchProviderModels,
  suggestedOllamaModels,
} from '../utils/provider-models.js';

const offline = {
  timeoutMs: 1_000,
  registry: { initialize: async () => undefined, getModel: () => null },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchProviderModels', () => {
  it('lists the current default model of each provider first, as provider/model', async () => {
    expect((await fetchProviderModels('anthropic', offline))[0].value).toBe(
      'anthropic/claude-sonnet-5-5'
    );
    expect((await fetchProviderModels('openai', offline))[0].value).toBe('openai/gpt-6.1-sol');
    expect((await fetchProviderModels('google', offline))[0].value).toBe('google/gemini-3.8-flash');
  });

  it('shows prices and context windows', async () => {
    const [first] = await fetchProviderModels('openai', offline);
    expect(first.hint).toMatch(/^recommended, \$\d.* in \/ \$\d.* out per 1M tokens, .* context$/);
  });

  it('does not offer retired models', async () => {
    const values = (
      await Promise.all(
        (['anthropic', 'openai', 'google'] as const).map((p) => fetchProviderModels(p, offline))
      )
    )
      .flat()
      .map((option) => option.value);

    for (const retired of ['claude-3-5-haiku', 'gpt-4o', 'o3-mini', 'gemini-2.5']) {
      expect(values.some((value) => value.includes(retired))).toBe(false);
    }
  });
});

describe('fetchOllamaModelOptions', () => {
  it('suggests small tool-calling models when Ollama does not answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );

    const options = await fetchOllamaModelOptions('http://localhost:11434');

    expect(options).toEqual(suggestedOllamaModels());
    expect(options[0]).toMatchObject({
      value: 'ollama/qwen3.5:9b',
      hint: 'recommended, pull it first',
    });
  });
});

describe('API_KEY_ENV', () => {
  it('names the variable each provider reads its key from', () => {
    expect(API_KEY_ENV).toEqual({
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      google: 'GOOGLE_API_KEY',
    });
  });
});
