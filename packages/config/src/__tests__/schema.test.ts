import { describe, it, expect } from 'vitest';
import { CogitatorConfigSchema, LLMProviderSchema } from '../schema';

describe('LLMProviderSchema', () => {
  it('accepts valid providers', () => {
    const providers = [
      'ollama',
      'openai',
      'anthropic',
      'google',
      'azure',
      'bedrock',
      'vllm',
      'mistral',
      'groq',
      'together',
      'deepseek',
    ];

    for (const provider of providers) {
      expect(LLMProviderSchema.parse(provider)).toBe(provider);
    }
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
        defaultProvider: 'groq',
        defaultModel: 'llama3.1:8b',
        providers: {
          ollama: { baseUrl: 'http://localhost:11434' },
          openai: { apiKey: 'sk-xxx', baseUrl: 'https://api.openai.com/v1' },
          anthropic: { apiKey: 'sk-ant-xxx' },
          mistral: { apiKey: 'mistral-xxx' },
          groq: { apiKey: 'gsk-xxx' },
          together: { apiKey: 'together-xxx' },
          deepseek: { apiKey: 'deepseek-xxx' },
          azure: {
            apiKey: 'azure-xxx',
            endpoint: 'https://example.openai.azure.com',
            deployment: 'gpt-4o',
          },
          bedrock: { accessKeyId: 'AKIA-test', secretAccessKey: 'secret-test' },
        },
      },
      limits: {
        maxConcurrentRuns: 10,
        defaultTimeout: 30000,
        maxTokensPerRun: 100000,
      },
    };

    const result = CogitatorConfigSchema.parse(config);
    expect(result.llm?.defaultProvider).toBe('groq');
    expect(result.llm?.providers?.ollama?.baseUrl).toBe('http://localhost:11434');
    expect(result.llm?.providers?.groq?.apiKey).toBe('gsk-xxx');
    expect(result.llm?.providers?.azure?.deployment).toBe('gpt-4o');
    expect(result.llm?.providers?.bedrock?.region).toBeUndefined();
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
