import { describe, it, expect } from 'vitest';
import { CogitatorConfigSchema, LLMProviderSchema } from '../schema.js';

describe('LLMProviderSchema', () => {
  it('accepts valid providers', () => {
    expect(LLMProviderSchema.parse('ollama')).toBe('ollama');
    expect(LLMProviderSchema.parse('openai')).toBe('openai');
    expect(LLMProviderSchema.parse('anthropic')).toBe('anthropic');
    expect(LLMProviderSchema.parse('google')).toBe('google');
    expect(LLMProviderSchema.parse('vllm')).toBe('vllm');
  });

  it('rejects invalid providers', () => {
    expect(() => LLMProviderSchema.parse('invalid')).toThrow();
    expect(() => LLMProviderSchema.parse('')).toThrow();
  });
});

describe('CogitatorConfigSchema', () => {
  it('accepts empty config', () => {
    const result = CogitatorConfigSchema.parse({});
    expect(result).toEqual({});
  });

  it('accepts full config', () => {
    const config = {
      llm: {
        defaultProvider: 'ollama',
        defaultModel: 'llama3.1:8b',
        providers: {
          ollama: { baseUrl: 'http://localhost:11434' },
          openai: { apiKey: 'sk-xxx', baseUrl: 'https://api.openai.com/v1' },
          anthropic: { apiKey: 'sk-ant-xxx' },
        },
      },
      limits: {
        maxConcurrentRuns: 10,
        defaultTimeout: 30000,
        maxTokensPerRun: 100000,
      },
    };

    const result = CogitatorConfigSchema.parse(config);
    expect(result.llm?.defaultProvider).toBe('ollama');
    expect(result.llm?.providers?.ollama?.baseUrl).toBe('http://localhost:11434');
    expect(result.limits?.maxConcurrentRuns).toBe(10);
  });

  it('accepts partial config', () => {
    const config = {
      llm: {
        defaultProvider: 'openai',
      },
    };

    const result = CogitatorConfigSchema.parse(config);
    expect(result.llm?.defaultProvider).toBe('openai');
    expect(result.llm?.providers).toBeUndefined();
    expect(result.limits).toBeUndefined();
  });

  it('rejects invalid provider', () => {
    const config = {
      llm: {
        defaultProvider: 'invalid-provider',
      },
    };

    expect(() => CogitatorConfigSchema.parse(config)).toThrow();
  });

  it('rejects negative limits', () => {
    const config = {
      limits: {
        maxConcurrentRuns: -1,
      },
    };

    expect(() => CogitatorConfigSchema.parse(config)).toThrow();
  });
});
