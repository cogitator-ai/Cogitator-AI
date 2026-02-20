import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig, defineConfig, CogitatorConfigSchema } from '@cogitator-ai/config';
import type { CogitatorConfig } from '@cogitator-ai/types';

describe('Config: Loading & Validation', () => {
  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('COGITATOR_')) {
        delete process.env[key];
      }
    }
  });

  it('defineConfig creates a validated config object', () => {
    const config = defineConfig({
      llm: {
        defaultProvider: 'anthropic',
        defaultModel: 'claude-sonnet-4-20250514',
        providers: {
          anthropic: { apiKey: 'sk-ant-test' },
          ollama: { baseUrl: 'http://localhost:11434' },
        },
      },
      limits: {
        maxConcurrentRuns: 8,
        defaultTimeout: 60000,
        maxTokensPerRun: 200000,
      },
      logging: {
        level: 'info',
        format: 'pretty',
      },
    });

    expect(config.llm?.defaultProvider).toBe('anthropic');
    expect(config.llm?.defaultModel).toBe('claude-sonnet-4-20250514');
    expect(config.llm?.providers?.anthropic?.apiKey).toBe('sk-ant-test');
    expect(config.llm?.providers?.ollama?.baseUrl).toBe('http://localhost:11434');
    expect(config.limits?.maxConcurrentRuns).toBe(8);
    expect(config.limits?.defaultTimeout).toBe(60000);
    expect(config.limits?.maxTokensPerRun).toBe(200000);
    expect(config.logging?.level).toBe('info');
    expect(config.logging?.format).toBe('pretty');

    const typed: CogitatorConfig = config;
    expect(typed).toBeDefined();
  });

  it('loadConfig with overrides merges correctly', () => {
    process.env.COGITATOR_LLM_DEFAULT_MODEL = 'gpt-4o';

    const config = loadConfig({
      skipYaml: true,
      overrides: {
        llm: {
          defaultProvider: 'openai',
          defaultModel: 'gpt-4-turbo',
          providers: {
            openai: { apiKey: 'sk-test-key' },
          },
        },
        limits: { maxConcurrentRuns: 3 },
      },
    });

    expect(config.llm?.defaultProvider).toBe('openai');
    expect(config.llm?.defaultModel).toBe('gpt-4-turbo');
    expect(config.llm?.providers?.openai?.apiKey).toBe('sk-test-key');
    expect(config.limits?.maxConcurrentRuns).toBe(3);
  });

  it('CogitatorConfigSchema validates correct config', () => {
    const input = {
      llm: {
        defaultProvider: 'ollama' as const,
        defaultModel: 'llama3.1:8b',
        providers: {
          ollama: { baseUrl: 'http://localhost:11434' },
        },
      },
      limits: {
        maxConcurrentRuns: 5,
        defaultTimeout: 30000,
      },
      sandbox: {
        defaults: {
          type: 'docker' as const,
          timeout: 10000,
        },
        pool: {
          maxSize: 4,
          idleTimeoutMs: 60000,
        },
      },
      logging: {
        level: 'debug' as const,
        format: 'json' as const,
        destination: 'console' as const,
      },
    };

    const result = CogitatorConfigSchema.safeParse(input);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.llm?.defaultProvider).toBe('ollama');
    expect(result.data.sandbox?.defaults?.type).toBe('docker');
    expect(result.data.sandbox?.pool?.maxSize).toBe(4);
    expect(result.data.logging?.level).toBe('debug');
  });

  it('CogitatorConfigSchema rejects invalid config', () => {
    const invalidProvider = CogitatorConfigSchema.safeParse({
      llm: { defaultProvider: 'not-a-provider' },
    });
    expect(invalidProvider.success).toBe(false);

    const negativeLimits = CogitatorConfigSchema.safeParse({
      limits: { maxConcurrentRuns: -5 },
    });
    expect(negativeLimits.success).toBe(false);

    const invalidLogLevel = CogitatorConfigSchema.safeParse({
      logging: { level: 'verbose' },
    });
    expect(invalidLogLevel.success).toBe(false);

    const invalidSandboxType = CogitatorConfigSchema.safeParse({
      sandbox: { defaults: { type: 'kubernetes' } },
    });
    expect(invalidSandboxType.success).toBe(false);
  });

  it('loadConfig skips yaml when skipYaml is true', () => {
    const config = loadConfig({
      skipYaml: true,
      skipEnv: true,
    });

    expect(config).toBeDefined();
    expect(config.llm).toBeUndefined();
    expect(config.limits).toBeUndefined();
    expect(config.memory).toBeUndefined();
  });

  it('defineConfig throws on invalid input', () => {
    expect(() =>
      defineConfig({
        llm: { defaultProvider: 'invalid' as 'openai' },
      })
    ).toThrow('Invalid configuration');

    expect(() =>
      defineConfig({
        limits: { maxConcurrentRuns: 0 },
      })
    ).toThrow('Invalid configuration');
  });

  it('loadConfig merges env vars with overrides', () => {
    process.env.COGITATOR_LLM_DEFAULT_PROVIDER = 'ollama';
    process.env.COGITATOR_OLLAMA_BASE_URL = 'http://gpu-server:11434';

    const config = loadConfig({
      skipYaml: true,
      overrides: {
        llm: { defaultModel: 'llama3.1:70b' },
      },
    });

    expect(config.llm?.defaultProvider).toBe('ollama');
    expect(config.llm?.providers?.ollama?.baseUrl).toBe('http://gpu-server:11434');
    expect(config.llm?.defaultModel).toBe('llama3.1:70b');
  });

  it('CogitatorConfigSchema accepts empty config', () => {
    const result = CogitatorConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({});
    }
  });

  it('defineConfig with complex nested config', () => {
    const config = defineConfig({
      llm: {
        defaultProvider: 'openai',
        defaultModel: 'gpt-4',
        providers: {
          openai: { apiKey: 'sk-test', baseUrl: 'https://custom-api.com' },
          anthropic: { apiKey: 'sk-ant-test' },
          ollama: { baseUrl: 'http://localhost:11434' },
        },
      },
      limits: {
        maxConcurrentRuns: 10,
        defaultTimeout: 120000,
        maxTokensPerRun: 500000,
      },
      sandbox: {
        defaults: {
          type: 'docker',
          image: 'node:20-slim',
          timeout: 30000,
          resources: { memory: '512m', cpus: 2 },
          network: { mode: 'none' },
        },
        pool: { maxSize: 8, idleTimeoutMs: 300000 },
      },
      logging: {
        level: 'warn',
        format: 'json',
        destination: 'file',
        filePath: '/var/log/cogitator.log',
      },
    });

    expect(config.llm?.providers?.openai?.baseUrl).toBe('https://custom-api.com');
    expect(config.sandbox?.defaults?.image).toBe('node:20-slim');
    expect(config.sandbox?.defaults?.resources?.memory).toBe('512m');
    expect(config.sandbox?.defaults?.network?.mode).toBe('none');
    expect(config.logging?.destination).toBe('file');
    expect(config.logging?.filePath).toBe('/var/log/cogitator.log');
  });
});
