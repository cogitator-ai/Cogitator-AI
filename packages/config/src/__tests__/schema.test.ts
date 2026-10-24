import { describe, it, expect } from 'vitest';
import { CogitatorConfigSchema, DeployConfigSchema, LLMProviderSchema } from '../schema';

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

  it('keeps tool output clearing in context, as true or with its options', () => {
    expect(CogitatorConfigSchema.parse({ context: { clearToolOutputs: true } }).context).toEqual({
      clearToolOutputs: true,
    });
    const options = {
      trigger: 50_000,
      keep: 2,
      exclude: ['read_file'],
      clearInputs: true,
      clearAtLeast: 4_000,
    };
    expect(
      CogitatorConfigSchema.parse({ context: { enabled: false, clearToolOutputs: options } })
        .context
    ).toEqual({ enabled: false, clearToolOutputs: options });
    expect(() =>
      CogitatorConfigSchema.parse({ context: { clearToolOutputs: { keep: -1 } } })
    ).toThrow();
  });

  it('accepts a base URL and headers for Anthropic and Google', () => {
    const result = CogitatorConfigSchema.parse({
      llm: {
        providers: {
          anthropic: {
            apiKey: 'sk-ant-xxx',
            baseUrl: 'https://gateway.example.com/anthropic',
            headers: { 'x-gateway-key': 'secret' },
          },
          google: {
            apiKey: 'google-xxx',
            baseUrl: 'https://gateway.example.com/gemini/v1beta',
            headers: { 'x-team': 'research' },
          },
        },
      },
    });

    expect(result.llm?.providers?.anthropic).toEqual({
      apiKey: 'sk-ant-xxx',
      baseUrl: 'https://gateway.example.com/anthropic',
      headers: { 'x-gateway-key': 'secret' },
    });
    expect(result.llm?.providers?.google?.headers).toEqual({ 'x-team': 'research' });
  });

  it.each([
    { baseUrl: 'https://gateway.example.com/ollama', apiKey: 'ollama-secret' },
    { apiKey: 'ollama-secret' },
    {},
  ])('preserves Ollama headers while applying URL defaults (%j)', (options) => {
    const headers = { 'X-Gateway-Key': 'gateway-secret' };
    const result = CogitatorConfigSchema.parse({
      llm: { providers: { ollama: { ...options, headers } } },
    });

    expect(result.llm?.providers?.ollama).toEqual({
      ...options,
      baseUrl:
        options.baseUrl ?? (options.apiKey ? 'https://ollama.com' : 'http://localhost:11434'),
      headers,
    });
  });

  it.each([
    { 'X-Key': 'secret\nInjected: value' },
    { 'X-Key': 'secret\rInjected: value' },
    { 'X-Retries': 3 },
  ])('rejects invalid Ollama headers (%j)', (headers) => {
    const result = CogitatorConfigSchema.safeParse({
      llm: { providers: { ollama: { headers } } },
    });

    expect(result.success).toBe(false);
  });

  it('accepts prices of your own per million tokens and rejects negative ones', () => {
    const pricing = {
      'ollama/llama3.3:70b': { input: 0.1, output: 0.1 },
      'my-finetune': { input: 2, output: 8, inputCached: 0.5 },
    };
    expect(CogitatorConfigSchema.parse({ llm: { pricing } }).llm?.pricing).toEqual(pricing);
    expect(
      CogitatorConfigSchema.safeParse({ llm: { pricing: { m: { input: -1, output: 1 } } } }).success
    ).toBe(false);
    expect(CogitatorConfigSchema.safeParse({ llm: { pricing: { m: { input: 1 } } } }).success).toBe(
      false
    );
  });

  it('accepts an OpenAI-compatible server profile by name or field by field', () => {
    const result = CogitatorConfigSchema.parse({
      llm: {
        providers: {
          openai: { apiKey: 'lm-studio', baseUrl: 'http://localhost:1234/v1', profile: 'lmstudio' },
          vllm: {
            baseUrl: 'http://gpu:8000/v1',
            profile: { maxTokensField: 'max_completion_tokens', reasoningEffort: ['low', 'high'] },
            headers: { authorization: 'Bearer internal' },
          },
          openrouter: { apiKey: 'or-xxx', headers: { 'X-Title': 'My app' } },
        },
      },
    });

    expect(result.llm?.providers?.openai?.profile).toBe('lmstudio');
    expect(result.llm?.providers?.vllm?.profile).toEqual({
      maxTokensField: 'max_completion_tokens',
      reasoningEffort: ['low', 'high'],
    });
    expect(result.llm?.providers?.openrouter?.headers).toEqual({ 'X-Title': 'My app' });
    expect(
      CogitatorConfigSchema.safeParse({
        llm: { providers: { openai: { apiKey: 'x', profile: 'unknown-server' } } },
      }).success
    ).toBe(false);
  });

  it('rejects a header value with a line break, which no HTTP client would send', () => {
    const result = CogitatorConfigSchema.safeParse({
      llm: {
        providers: { anthropic: { apiKey: 'k', headers: { 'x-key': 'secret\nX-Other: 1' } } },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects headers that are not strings', () => {
    const result = CogitatorConfigSchema.safeParse({
      llm: { providers: { anthropic: { apiKey: 'sk-ant-xxx', headers: { 'x-retries': 3 } } } },
    });
    expect(result.success).toBe(false);
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
        maxToolResultLength: 20000,
      },
    };

    const result = CogitatorConfigSchema.parse(config);
    expect(result.llm?.defaultProvider).toBe('groq');
    expect(result.llm?.providers?.ollama?.baseUrl).toBe('http://localhost:11434');
    expect(result.llm?.providers?.groq?.apiKey).toBe('gsk-xxx');
    expect(result.llm?.providers?.azure?.deployment).toBe('gpt-4o');
    expect(result.llm?.providers?.bedrock?.region).toBeUndefined();
    expect(result.limits?.maxConcurrentRuns).toBe(10);
    expect(result.limits?.maxToolResultLength).toBe(20000);
  });

  it('rejects a tool result limit that is not a positive integer', () => {
    for (const maxToolResultLength of [0, -5, 1.5]) {
      expect(() => CogitatorConfigSchema.parse({ limits: { maxToolResultLength } })).toThrow();
    }
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

  it('keeps the circuit breaker settings of fallback models', () => {
    const breaker = { failureThreshold: 3, resetTimeout: 60_000, halfOpenRequests: 1 };
    expect(
      CogitatorConfigSchema.parse({ llm: { modelCircuitBreaker: breaker } }).llm
        ?.modelCircuitBreaker
    ).toEqual(breaker);
    expect(() =>
      CogitatorConfigSchema.parse({ llm: { modelCircuitBreaker: { failureThreshold: 0 } } })
    ).toThrow();
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

  it('keeps every memory.compaction setting that YAML can hold', () => {
    const compaction = {
      at: 0.75,
      keepRecent: 4,
      keepRecentTokens: 12000,
      chapterTokens: 3000,
      chaptersPerArc: 5,
      arcsPerSaga: 3,
      summaryModel: 'openai/gpt-4o-mini',
      summaryPrompt: 'Keep the deadlines.',
    };

    expect(CogitatorConfigSchema.parse({ memory: { compaction } }).memory?.compaction).toEqual(
      compaction
    );
    expect(CogitatorConfigSchema.parse({ memory: { compaction: {} } }).memory?.compaction).toEqual(
      {}
    );
  });

  it('keeps every memory.extraction setting that YAML can hold and refuses the rest', () => {
    const extraction = {
      model: 'anthropic/claude-haiku-5-5',
      prompt: 'Mind the allergies.',
      windowTokens: 3000,
      activationConfidence: 0.8,
      mode: 'shadow' as const,
      scope: 'thread' as const,
      timeZone: 'Europe/Lisbon',
    };

    expect(CogitatorConfigSchema.parse({ memory: { extraction } }).memory?.extraction).toEqual(
      extraction
    );
    for (const invalid of [
      { windowTokens: 0 },
      { activationConfidence: 1.5 },
      { mode: 'dry-run' },
      { scope: 'world' },
      { timeZone: 'Mars/Olympus' },
      { model: '' },
    ]) {
      expect(() => CogitatorConfigSchema.parse({ memory: { extraction: invalid } })).toThrow();
    }
  });

  it('rejects memory.compaction settings the compaction cannot run with', () => {
    const invalid = [
      { at: 0 },
      { at: 1.2 },
      { keepRecent: -1 },
      { keepRecentTokens: 10.5 },
      { chapterTokens: 0 },
      { chaptersPerArc: 0 },
      { arcsPerSaga: -2 },
      { summaryModel: '' },
    ];

    for (const compaction of invalid) {
      expect(() => CogitatorConfigSchema.parse({ memory: { compaction } })).toThrow();
    }
    expect(CogitatorConfigSchema.parse({ memory: { compaction: { at: 1 } } }).memory).toEqual({
      compaction: { at: 1 },
    });
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

describe('ContextBuilderConfigSchema partitions', () => {
  it('keeps the partition budgets and refuses a share outside 0 to 1', async () => {
    const { ContextBuilderConfigSchema } = await import('../schema');

    expect(
      ContextBuilderConfigSchema.parse({
        strategy: 'recent',
        partitions: { facts: { share: 0 }, pinned: { required: false } },
      }).partitions
    ).toEqual({ facts: { share: 0 }, pinned: { required: false } });
    expect(() =>
      ContextBuilderConfigSchema.parse({ partitions: { recall: { share: 1.5 } } })
    ).toThrow();
    expect(() => ContextBuilderConfigSchema.parse({ partitions: { other: {} } })).toThrow();
  });
});

describe('DeployConfigSchema', () => {
  it('keeps the Fly app, organization and the Ollama service settings', () => {
    const deploy = {
      target: 'docker',
      app: 'acme-api',
      org: 'acme',
      services: { redis: true, ollama: true },
      ollama: {
        models: ['qwen3:8b', 'hf.co/acme/model:Q4_K_M'],
        gpu: true,
        image: 'ollama/ollama:rocm',
      },
    };
    expect(DeployConfigSchema.parse(deploy)).toEqual(deploy);
  });

  it('refuses app names Fly would refuse', () => {
    for (const app of ['Acme', 'acme_api', '-acme', 'acme-', 'a'.repeat(64), '']) {
      expect(DeployConfigSchema.safeParse({ app }).success, app).toBe(false);
    }
    expect(DeployConfigSchema.safeParse({ app: 'a'.repeat(63) }).success).toBe(true);
  });

  it('refuses an organization or a model name that would read as a flag', () => {
    expect(DeployConfigSchema.safeParse({ org: '--help' }).success).toBe(false);
    expect(DeployConfigSchema.safeParse({ ollama: { models: ['-v'] } }).success).toBe(false);
    expect(DeployConfigSchema.safeParse({ ollama: { models: ['llama 3'] } }).success).toBe(false);
  });
});
