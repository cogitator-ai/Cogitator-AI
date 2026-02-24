import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadEnvConfig } from '../loaders/env';

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
        [
          'OPENAI_API_KEY',
          'ANTHROPIC_API_KEY',
          'OLLAMA_HOST',
          'GOOGLE_API_KEY',
          'AZURE_OPENAI_API_KEY',
          'AZURE_OPENAI_ENDPOINT',
          'AWS_REGION',
          'AWS_ACCESS_KEY_ID',
          'AWS_SECRET_ACCESS_KEY',
        ].includes(key)
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

  it('loads Google API key from standard GOOGLE_API_KEY', () => {
    delete process.env.COGITATOR_GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = 'google-test-key';

    const config = loadEnvConfig();
    expect(config.llm?.providers?.google?.apiKey).toBe('google-test-key');
  });

  it('loads deploy config from env vars', () => {
    process.env.COGITATOR_DEPLOY_TARGET = 'docker';
    process.env.COGITATOR_DEPLOY_PORT = '3000';
    process.env.COGITATOR_DEPLOY_REGISTRY = 'ghcr.io/test';

    const config = loadEnvConfig();
    expect(config.deploy?.target).toBe('docker');
    expect(config.deploy?.port).toBe(3000);
    expect(config.deploy?.registry).toBe('ghcr.io/test');
  });

  it('ignores invalid deploy target', () => {
    process.env.COGITATOR_DEPLOY_TARGET = 'invalid-target';
    process.env.COGITATOR_DEPLOY_PORT = '8080';

    const config = loadEnvConfig();
    expect(config.deploy?.target).toBeUndefined();
    expect(config.deploy?.port).toBe(8080);
  });

  it('ignores non-numeric env values for number fields', () => {
    process.env.COGITATOR_LIMITS_MAX_CONCURRENT_RUNS = 'not-a-number';

    const config = loadEnvConfig();
    expect(config.limits?.maxConcurrentRuns).toBeUndefined();
  });

  it('loads Azure config from COGITATOR_ prefix', () => {
    process.env.COGITATOR_AZURE_API_KEY = 'azure-key';
    process.env.COGITATOR_AZURE_ENDPOINT = 'https://myresource.openai.azure.com';
    process.env.COGITATOR_AZURE_API_VERSION = '2024-02-15-preview';

    const config = loadEnvConfig();
    expect(config.llm?.providers?.azure?.apiKey).toBe('azure-key');
    expect(config.llm?.providers?.azure?.endpoint).toBe('https://myresource.openai.azure.com');
    expect(config.llm?.providers?.azure?.apiVersion).toBe('2024-02-15-preview');
  });

  it('loads Azure config from standard AZURE_OPENAI_* vars', () => {
    delete process.env.COGITATOR_AZURE_API_KEY;
    delete process.env.COGITATOR_AZURE_ENDPOINT;
    process.env.AZURE_OPENAI_API_KEY = 'azure-std-key';
    process.env.AZURE_OPENAI_ENDPOINT = 'https://std.openai.azure.com';

    const config = loadEnvConfig();
    expect(config.llm?.providers?.azure?.apiKey).toBe('azure-std-key');
    expect(config.llm?.providers?.azure?.endpoint).toBe('https://std.openai.azure.com');
  });

  it('skips Azure config when apiKey or endpoint missing', () => {
    process.env.COGITATOR_AZURE_API_KEY = 'azure-key';

    const config = loadEnvConfig();
    expect(config.llm?.providers?.azure).toBeUndefined();
  });

  it('loads Bedrock config from COGITATOR_ prefix', () => {
    process.env.COGITATOR_BEDROCK_REGION = 'us-east-1';
    process.env.COGITATOR_BEDROCK_ACCESS_KEY_ID = 'AKIA-test';
    process.env.COGITATOR_BEDROCK_SECRET_ACCESS_KEY = 'secret-test';

    const config = loadEnvConfig();
    expect(config.llm?.providers?.bedrock?.region).toBe('us-east-1');
    expect(config.llm?.providers?.bedrock?.accessKeyId).toBe('AKIA-test');
    expect(config.llm?.providers?.bedrock?.secretAccessKey).toBe('secret-test');
  });

  it('loads Bedrock config from standard AWS_* vars', () => {
    delete process.env.COGITATOR_BEDROCK_REGION;
    delete process.env.COGITATOR_BEDROCK_ACCESS_KEY_ID;
    delete process.env.COGITATOR_BEDROCK_SECRET_ACCESS_KEY;
    process.env.AWS_REGION = 'eu-west-1';
    process.env.AWS_ACCESS_KEY_ID = 'AKIA-aws';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';

    const config = loadEnvConfig();
    expect(config.llm?.providers?.bedrock?.region).toBe('eu-west-1');
    expect(config.llm?.providers?.bedrock?.accessKeyId).toBe('AKIA-aws');
    expect(config.llm?.providers?.bedrock?.secretAccessKey).toBe('aws-secret');
  });

  it('loads Bedrock with region only (uses AWS credentials chain)', () => {
    process.env.COGITATOR_BEDROCK_REGION = 'ap-southeast-1';

    const config = loadEnvConfig();
    expect(config.llm?.providers?.bedrock?.region).toBe('ap-southeast-1');
    expect(config.llm?.providers?.bedrock?.accessKeyId).toBeUndefined();
    expect(config.llm?.providers?.bedrock?.secretAccessKey).toBeUndefined();
  });
});
