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

  it('keeps the OpenAI wire api option and rejects unknown values', () => {
    const parsed = CogitatorConfigSchema.parse({
      llm: { providers: { openai: { apiKey: 'sk-xxx', api: 'chat-completions' } } },
    });
    expect(parsed.llm?.providers?.openai?.api).toBe('chat-completions');

    expect(() =>
      CogitatorConfigSchema.parse({
        llm: { providers: { openai: { apiKey: 'sk-xxx', api: 'assistants' } } },
      })
    ).toThrow();
  });

  it('keeps LLM retry settings, or false to turn retries off', () => {
    const tuned = CogitatorConfigSchema.parse({
      llm: {
        retry: {
          maxRetries: 4,
          baseDelay: 500,
          maxDelay: 10_000,
          maxRetryAfter: 30_000,
          requestTimeout: 120_000,
        },
      },
    });
    expect(tuned.llm?.retry).toEqual({
      maxRetries: 4,
      baseDelay: 500,
      maxDelay: 10_000,
      maxRetryAfter: 30_000,
      requestTimeout: 120_000,
    });
    expect(CogitatorConfigSchema.parse({ llm: { retry: false } }).llm?.retry).toBe(false);
    expect(() => CogitatorConfigSchema.parse({ llm: { retry: { maxRetries: -1 } } })).toThrow();
  });

  it('keeps prompt cache settings, or false to turn caching off', () => {
    expect(
      CogitatorConfigSchema.parse({ llm: { promptCache: { ttl: '1h' } } }).llm?.promptCache
    ).toEqual({
      ttl: '1h',
    });
    expect(CogitatorConfigSchema.parse({ llm: { promptCache: false } }).llm?.promptCache).toBe(
      false
    );
    expect(() => CogitatorConfigSchema.parse({ llm: { promptCache: { ttl: '2h' } } })).toThrow();
    expect(
      CogitatorConfigSchema.parse({ llm: { promptCache: { ttl: '1h', conversation: false } } }).llm
        ?.promptCache
    ).toEqual({ ttl: '1h', conversation: false });
  });

  it('reads PII masking settings, compiling custom patterns given as strings', () => {
    const pii = CogitatorConfigSchema.parse({
      security: {
        pii: {
          mode: 'redact',
          detect: ['email', 'iban'],
          custom: [{ type: 'customer_id', pattern: 'CUS-\\d{6}' }],
        },
      },
    }).security?.pii;

    expect(pii?.mode).toBe('redact');
    expect(pii?.detect).toEqual(['email', 'iban']);
    expect(pii?.custom?.[0].pattern).toEqual(/CUS-\d{6}/);
    expect(() =>
      CogitatorConfigSchema.parse({ security: { pii: { detect: ['passport'] } } })
    ).toThrow();
    expect(() =>
      CogitatorConfigSchema.parse({
        security: { pii: { custom: [{ type: 'x', pattern: '([' }] } },
      })
    ).toThrow();
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

  it('keeps sandbox fallback, container reuse and per-execution defaults', () => {
    const sandbox = {
      allowNativeFallback: false,
      pool: { maxSize: 4, idleTimeoutMs: 60_000, reuseContainers: true },
      defaults: {
        type: 'docker',
        mounts: [{ source: '/data', target: '/workspace/data', readOnly: true }],
        env: { NODE_ENV: 'production' },
        wasmModule: './tools/calc.wasm',
        wasmFunction: 'main',
        wasi: true,
      },
    };

    expect(CogitatorConfigSchema.parse({ sandbox }).sandbox).toEqual(sandbox);
  });

  it('keeps embedding dimensions for every provider and the Google base URL', () => {
    const embeddings = [
      { provider: 'openai', apiKey: 'sk-xxx', model: 'text-embedding-3-large', dimensions: 1024 },
      { provider: 'ollama', model: 'nomic-embed-text', dimensions: 768 },
      {
        provider: 'google',
        apiKey: 'g-xxx',
        baseUrl: 'https://proxy.example.com/v1beta',
        dimensions: 512,
      },
    ];

    for (const embedding of embeddings) {
      expect(CogitatorConfigSchema.parse({ memory: { embedding } }).memory?.embedding).toEqual(
        embedding
      );
    }
    expect(() =>
      CogitatorConfigSchema.parse({
        memory: { embedding: { provider: 'ollama', dimensions: 1.5 } },
      })
    ).toThrow();
  });

  it('keeps every graph context option the context builder reads', () => {
    const graphContextOptions = {
      maxNodes: 20,
      maxEdges: 40,
      maxDepth: 2,
      includeInferred: true,
      entityTypes: ['person', 'organization'],
    };

    expect(
      CogitatorConfigSchema.parse({ memory: { contextBuilder: { graphContextOptions } } }).memory
        ?.contextBuilder?.graphContextOptions
    ).toEqual(graphContextOptions);
    expect(() =>
      CogitatorConfigSchema.parse({
        memory: { contextBuilder: { graphContextOptions: { entityTypes: ['planet'] } } },
      })
    ).toThrow();
  });

  it('keeps prompt injection patterns and fail mode, compiling patterns given as strings', () => {
    const promptInjection = CogitatorConfigSchema.parse({
      security: {
        promptInjection: { patterns: ['reveal the system prompt'], failMode: 'open' },
      },
    }).security?.promptInjection;

    expect(promptInjection?.patterns).toEqual([/reveal the system prompt/]);
    expect(promptInjection?.failMode).toBe('open');
    expect(() =>
      CogitatorConfigSchema.parse({ security: { promptInjection: { failMode: 'ignore' } } })
    ).toThrow();
  });

  it('keeps a guardrail constitution, backend plugin settings and A/B auto-deploy', () => {
    const constitution = {
      id: 'support',
      name: 'Support desk',
      version: '1.0.0',
      customizable: true,
      strictMode: false,
      principles: [
        {
          id: 'no-refund-promises',
          name: 'No refund promises',
          description: 'Never promise refunds the policy does not allow',
          category: 'custom',
          critiquePrompt: 'Does the reply promise a refund?',
          revisionPrompt: 'Rewrite the reply without promising a refund.',
          severity: 'medium',
          appliesTo: ['output'],
        },
      ],
    };
    const parsed = CogitatorConfigSchema.parse({
      guardrails: { constitution },
      llm: { plugins: { 'my-provider': { endpoint: 'http://localhost:9000', retries: 2 } } },
      prompts: { autoDeployWinner: true },
    });

    expect(parsed.guardrails?.constitution).toEqual(constitution);
    expect(parsed.llm?.plugins).toEqual({
      'my-provider': { endpoint: 'http://localhost:9000', retries: 2 },
    });
    expect(parsed.prompts).toEqual({ autoDeployWinner: true });
  });
});
