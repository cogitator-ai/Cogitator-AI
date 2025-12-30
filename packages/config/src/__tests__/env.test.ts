import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadEnvConfig } from '../loaders/env.js';

describe('loadEnvConfig()', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns empty config when no env vars set', () => {
    const keysToDelete = Object.keys(process.env).filter(
      (key) =>
        key.startsWith('COGITATOR_') ||
        ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OLLAMA_HOST'].includes(key)
    );
    for (const key of keysToDelete) {
      process.env[key] = undefined;
    }

    const config = loadEnvConfig();
    expect(config.llm).toBeUndefined();
    expect(config.limits).toBeUndefined();
  });

  it('loads LLM default provider from env', () => {
    process.env.COGITATOR_LLM_DEFAULT_PROVIDER = 'openai';
    process.env.COGITATOR_LLM_DEFAULT_MODEL = 'gpt-4';

    const config = loadEnvConfig();
    expect(config.llm?.defaultProvider).toBe('openai');
    expect(config.llm?.defaultModel).toBe('gpt-4');
  });

  it('loads Ollama config from COGITATOR_ prefix', () => {
    process.env.COGITATOR_OLLAMA_BASE_URL = 'http://localhost:11434';

    const config = loadEnvConfig();
    expect(config.llm?.providers?.ollama?.baseUrl).toBe('http://localhost:11434');
  });

  it('loads Ollama config from standard OLLAMA_HOST', () => {
    delete process.env.COGITATOR_OLLAMA_BASE_URL;
    process.env.OLLAMA_HOST = 'http://192.168.1.100:11434';

    const config = loadEnvConfig();
    expect(config.llm?.providers?.ollama?.baseUrl).toBe('http://192.168.1.100:11434');
  });

  it('loads OpenAI config from standard OPENAI_API_KEY', () => {
    delete process.env.COGITATOR_OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-key';

    const config = loadEnvConfig();
    expect(config.llm?.providers?.openai?.apiKey).toBe('sk-test-key');
  });

  it('loads Anthropic config from standard ANTHROPIC_API_KEY', () => {
    delete process.env.COGITATOR_ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';

    const config = loadEnvConfig();
    expect(config.llm?.providers?.anthropic?.apiKey).toBe('sk-ant-test-key');
  });

  it('loads limits from env', () => {
    process.env.COGITATOR_LIMITS_MAX_CONCURRENT_RUNS = '5';
    process.env.COGITATOR_LIMITS_DEFAULT_TIMEOUT = '30000';
    process.env.COGITATOR_LIMITS_MAX_TOKENS_PER_RUN = '100000';

    const config = loadEnvConfig();
    expect(config.limits?.maxConcurrentRuns).toBe(5);
    expect(config.limits?.defaultTimeout).toBe(30000);
    expect(config.limits?.maxTokensPerRun).toBe(100000);
  });

  it('COGITATOR_ prefix takes precedence over standard env vars', () => {
    process.env.OPENAI_API_KEY = 'standard-key';
    process.env.COGITATOR_OPENAI_API_KEY = 'cogitator-key';

    const config = loadEnvConfig();
    expect(config.llm?.providers?.openai?.apiKey).toBe('cogitator-key');
  });
});
