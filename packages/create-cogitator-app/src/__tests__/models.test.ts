import { describe, it, expect } from 'vitest';
import type { ModelInfo } from '@cogitator-ai/models';
import { cloudModelChoices, describeModel } from '../kit/models.js';

const never = { initialize: () => new Promise<void>(() => undefined), getModel: () => null };

describe('cloudModelChoices', () => {
  it('offers the provider lineup with the default first when the catalogue is slow', async () => {
    const { choices, source } = await cloudModelChoices('anthropic', {
      registry: never,
      timeoutMs: 10,
    });
    expect(source).toBe('builtin');
    expect(choices[0].value).toBe('claude-sonnet-5-5');
    expect(choices[0].hint).toMatch(/^recommended, /);
    expect(choices.length).toBeLessThanOrEqual(8);
  });

  it('takes prices from the live catalogue when it answers', async () => {
    const live: ModelInfo = {
      id: 'gpt-6.1-sol',
      provider: 'openai',
      displayName: 'GPT-6.1 Sol',
      pricing: { input: 1.5, output: 6 },
      contextWindow: 2_000_000,
    };
    const registry = {
      initialize: async () => undefined,
      getModel: (id: string) => (id === 'openai/gpt-6.1-sol' ? live : null),
    };
    const { choices, source } = await cloudModelChoices('openai', { registry });
    expect(source).toBe('catalog');
    expect(choices[0].hint).toBe('recommended, $1.50 in / $6 out per 1M tokens, 2M context');
  });
});

describe('describeModel', () => {
  it('formats cheap prices and context windows', () => {
    expect(describeModel({ pricing: { input: 0.075, output: 0.3 }, contextWindow: 128_000 })).toBe(
      '$0.075 in / $0.3 out per 1M tokens, 128k context'
    );
  });
});
