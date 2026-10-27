import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { loadConfig, defineConfig } from '../config';

describe('loadConfig', () => {
  const testConfigPath = 'test-merge-config.yaml';

  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('COGITATOR_')) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    if (existsSync(testConfigPath)) {
      unlinkSync(testConfigPath);
    }
  });

  describe('priority order', () => {
    it('overrides take precedence over env vars', () => {
      process.env.COGITATOR_LLM_DEFAULT_MODEL = 'env-model';

      const config = loadConfig({
        skipYaml: true,
        overrides: {
          llm: { defaultModel: 'override-model' },
        },
      });

      expect(config.llm?.defaultModel).toBe('override-model');
    });

    it('env vars take precedence over YAML', () => {
      writeFileSync(
        testConfigPath,
        `
llm:
  defaultModel: yaml-model
`
      );
      process.env.COGITATOR_LLM_DEFAULT_MODEL = 'env-model';

      const config = loadConfig({ configPath: testConfigPath });

      expect(config.llm?.defaultModel).toBe('env-model');
    });

    it('YAML provides base config', () => {
      writeFileSync(
        testConfigPath,
        `
llm:
  defaultProvider: openai
  defaultModel: gpt-4
limits:
  maxConcurrentRuns: 5
`
      );

      const config = loadConfig({ configPath: testConfigPath, skipEnv: true });

      expect(config.llm?.defaultProvider).toBe('openai');
      expect(config.llm?.defaultModel).toBe('gpt-4');
      expect(config.limits?.maxConcurrentRuns).toBe(5);
    });

    it('YAML sets memory.compaction', () => {
      writeFileSync(
        testConfigPath,
        `
memory:
  adapter: memory
  compaction:
    at: 0.7
    keepRecentTokens: 8000
    chaptersPerArc: 3
    summaryModel: openai/gpt-4o-mini
`
      );

      const config = loadConfig({ configPath: testConfigPath, skipEnv: true });

      expect(config.memory?.compaction).toEqual({
        at: 0.7,
        keepRecentTokens: 8000,
        chaptersPerArc: 3,
        summaryModel: 'openai/gpt-4o-mini',
      });
    });
  });

  describe('deep merge behavior', () => {
    it('merges nested objects', () => {
      writeFileSync(
        testConfigPath,
        `
llm:
  providers:
    openai:
      apiKey: yaml-key
    ollama:
      baseUrl: http://localhost:11434
`
      );

      const config = loadConfig({
        configPath: testConfigPath,
        skipEnv: true,
        overrides: {
          llm: {
            providers: {
              openai: { apiKey: 'override-key', baseUrl: 'https://custom.com' },
            },
          },
        },
      });

      expect(config.llm?.providers?.openai?.apiKey).toBe('override-key');
      expect(config.llm?.providers?.openai?.baseUrl).toBe('https://custom.com');
      expect(config.llm?.providers?.ollama?.baseUrl).toBe('http://localhost:11434');
    });

    it('replaces arrays entirely', () => {
      const config = loadConfig({
        skipYaml: true,
        skipEnv: true,
        overrides: {
          llm: { defaultProvider: 'openai' },
        },
      });

      expect(config.llm?.defaultProvider).toBe('openai');
    });
  });

  describe('skip options', () => {
    it('skipEnv prevents env loading', () => {
      process.env.COGITATOR_LLM_DEFAULT_MODEL = 'env-model';

      const config = loadConfig({ skipYaml: true, skipEnv: true });

      expect(config.llm?.defaultModel).toBeUndefined();
    });

    it('skipYaml prevents YAML loading', () => {
      writeFileSync(
        testConfigPath,
        `
llm:
  defaultModel: yaml-model
`
      );

      const config = loadConfig({ configPath: testConfigPath, skipYaml: true, skipEnv: true });

      expect(config.llm?.defaultModel).toBeUndefined();
    });
  });

  describe('validation', () => {
    it('throws on invalid provider', () => {
      expect(() =>
        loadConfig({
          skipYaml: true,
          skipEnv: true,
          overrides: {
            llm: { defaultProvider: 'invalid' as 'openai' },
          },
        })
      ).toThrow('Invalid configuration');
    });

    it('accepts all runtime LLM providers', () => {
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
      ] as const;

      for (const provider of providers) {
        const config = loadConfig({
          skipYaml: true,
          skipEnv: true,
          overrides: {
            llm: { defaultProvider: provider },
          },
        });

        expect(config.llm?.defaultProvider).toBe(provider);
      }
    });

    it('throws on invalid limits', () => {
      expect(() =>
        loadConfig({
          skipYaml: true,
          skipEnv: true,
          overrides: {
            limits: { maxConcurrentRuns: -1 },
          },
        })
      ).toThrow('Invalid configuration');
    });
  });
});

describe('defineConfig', () => {
  it('validates and returns config', () => {
    const config = defineConfig({
      llm: {
        defaultProvider: 'openai',
        defaultModel: 'gpt-4',
      },
    });

    expect(config.llm?.defaultProvider).toBe('openai');
  });

  it('throws on invalid config', () => {
    expect(() =>
      defineConfig({
        llm: { defaultProvider: 'invalid' as 'openai' },
      })
    ).toThrow('Invalid configuration');
  });
});

describe('loadConfig hardening', () => {
  const path = 'test-hardening-config.yaml';
  const saved = { ...process.env };

  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('COGITATOR_') || key.startsWith('OLLAMA_')) delete process.env[key];
    }
  });

  afterEach(() => {
    if (existsSync(path)) unlinkSync(path);
    process.env = { ...saved };
  });

  it('keeps a YAML Ollama baseUrl when only OLLAMA_API_KEY is in the environment', () => {
    writeFileSync(path, 'llm:\n  providers:\n    ollama:\n      baseUrl: http://gpu-box:11434\n');
    process.env.OLLAMA_API_KEY = 'key';
    expect(loadConfig({ configPath: path }).llm?.providers?.ollama).toEqual({
      baseUrl: 'http://gpu-box:11434',
      apiKey: 'key',
    });
  });

  it('defaults the Ollama baseUrl to Ollama Cloud for key-only configs and localhost otherwise', () => {
    process.env.OLLAMA_API_KEY = 'key';
    expect(loadConfig({ skipYaml: true }).llm?.providers?.ollama?.baseUrl).toBe(
      'https://ollama.com'
    );

    delete process.env.OLLAMA_API_KEY;
    writeFileSync(path, 'llm:\n  providers:\n    ollama: {}\n');
    expect(loadConfig({ configPath: path, skipEnv: true }).llm?.providers?.ollama?.baseUrl).toBe(
      'http://localhost:11434'
    );
  });

  it('formats validation errors with field paths', () => {
    expect(() => defineConfig({ deploy: { port: 70000 } })).toThrow(/deploy\.port/);
    expect(() => defineConfig({ deploy: { instances: 1.5 } })).toThrow(/Invalid configuration/);
  });

  it('passes sandbox and embedding options from YAML through to the runtime config', () => {
    writeFileSync(
      path,
      [
        'sandbox:',
        '  allowNativeFallback: false',
        '  pool:',
        '    reuseContainers: true',
        'memory:',
        '  embedding:',
        '    provider: openai',
        '    apiKey: sk-test',
        '    dimensions: 1536',
        '',
      ].join('\n')
    );

    const config = loadConfig({ configPath: path, skipEnv: true });

    expect(config.sandbox).toEqual({ allowNativeFallback: false, pool: { reuseContainers: true } });
    expect(config.memory?.embedding).toEqual({
      provider: 'openai',
      apiKey: 'sk-test',
      dimensions: 1536,
    });
  });

  it('ignores prototype-polluting keys during merge', () => {
    writeFileSync(path, '__proto__:\n  polluted: true\nllm:\n  defaultModel: x\n');
    const config = loadConfig({ configPath: path, skipEnv: true });
    expect(config.llm?.defaultModel).toBe('x');
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
});

describe('loadConfig with an env of its own', () => {
  const path = 'test-own-env-config.yaml';

  afterEach(() => {
    if (existsSync(path)) unlinkSync(path);
  });

  it('reads the file references, COGITATOR_* and shared variables from env, not process.env', () => {
    writeFileSync(
      path,
      'llm:\n  defaultModel: ${CHAT_MODEL:-ollama/qwen3:8b}\nmemory:\n  embedding:\n    provider: ollama\n    baseUrl: ${EMBED_URL:-http://localhost:11434}\n'
    );
    const config = loadConfig({
      configPath: path,
      env: {
        CHAT_MODEL: 'ollama/llama3.2',
        EMBED_URL: 'http://ollama:11434',
        COGITATOR_LLM_DEFAULT_PROVIDER: 'ollama',
        OLLAMA_HOST: 'gpu-box',
      },
    });

    expect(config.llm?.defaultModel).toBe('ollama/llama3.2');
    expect(config.llm?.defaultProvider).toBe('ollama');
    expect(config.llm?.providers?.ollama?.baseUrl).toBe('http://gpu-box:11434');
    expect(config.memory?.embedding).toMatchObject({ baseUrl: 'http://ollama:11434' });
  });

  it('lets COGITATOR_LLM_DEFAULT_MODEL of env win over the file', () => {
    writeFileSync(path, 'llm:\n  defaultModel: ollama/qwen3:8b\n');
    expect(
      loadConfig({ configPath: path, env: { COGITATOR_LLM_DEFAULT_MODEL: 'openai/gpt-5' } }).llm
        ?.defaultModel
    ).toBe('openai/gpt-5');
  });
});

describe('multitaskStrategy', () => {
  const path = 'test-multitask-config.yaml';

  afterEach(() => {
    if (existsSync(path)) unlinkSync(path);
  });

  it('keeps the strategy of a YAML file and of defineConfig', () => {
    writeFileSync(path, 'multitaskStrategy: rollback\n');
    expect(loadConfig({ configPath: path, skipEnv: true }).multitaskStrategy).toBe('rollback');
    expect(defineConfig({ multitaskStrategy: 'enqueue' }).multitaskStrategy).toBe('enqueue');
  });

  it('refuses a strategy it does not know', () => {
    writeFileSync(path, 'multitaskStrategy: later\n');
    expect(() => loadConfig({ configPath: path, skipEnv: true })).toThrow(/multitaskStrategy/);
  });
});

describe('durable', () => {
  const path = 'test-durable-config.yaml';

  afterEach(() => {
    if (existsSync(path)) unlinkSync(path);
  });

  it('keeps durable runs of a YAML file and of defineConfig', () => {
    writeFileSync(
      path,
      'durable:\n  leaseMs: 30000\n  owner: worker-1\n  onStoreError: continue\n  storeRetries: 5\n'
    );
    expect(loadConfig({ configPath: path, skipEnv: true }).durable).toEqual({
      leaseMs: 30000,
      owner: 'worker-1',
      onStoreError: 'continue',
      storeRetries: 5,
    });
    expect(defineConfig({ durable: true }).durable).toBe(true);
  });

  it('refuses a lease, a store policy or retries out of bounds', () => {
    for (const bad of [
      'leaseMs: -1',
      'onStoreError: ignore',
      'storeRetries: -1',
      'storeRetries: 1.5',
      'storeRetries: 99',
    ]) {
      writeFileSync(path, `durable:\n  ${bad}\n`);
      expect(() => loadConfig({ configPath: path, skipEnv: true })).toThrow(/durable/);
    }
  });
});

describe('permissions, budgets and limits.onExceeded', () => {
  const path = 'test-permissions-config.yaml';

  afterEach(() => {
    if (existsSync(path)) unlinkSync(path);
  });

  const yaml = `
limits:
  maxTokensPerRun: 20000
  onExceeded: interrupt
permissions:
  mode: acceptEdits
  allow:
    - Bash(npm test *)
    - Read(src/**)
  ask:
    - Bash(git push *)
  deny:
    - Read(./.env)
  settings:
    root: \${PROJECT_ROOT:-/srv/app}
    userDirs: [/home/ci/.claude]
    layers: [project, local]
    trusted: false
  classifier:
    model: anthropic/claude-haiku-4-5
    timeout: 10000
    transcriptMessages: 8
  rememberIn: session
  rememberLayers: [session, local]
budget:
  session:
    maxCostUsd: 2.5
    maxTokens: 400000
  agent:
    maxToolCalls: 50
  warnAt: 0.75
  allowRaise: false
`;

  it('keeps them through a YAML file and the environment', () => {
    writeFileSync(path, yaml);
    const config = loadConfig({
      configPath: path,
      env: { PROJECT_ROOT: '/work/repo', COGITATOR_LLM_DEFAULT_MODEL: 'ollama/qwen3:8b' },
    });

    expect(config.limits).toEqual({ maxTokensPerRun: 20000, onExceeded: 'interrupt' });
    expect(config.permissions).toEqual({
      mode: 'acceptEdits',
      allow: ['Bash(npm test *)', 'Read(src/**)'],
      ask: ['Bash(git push *)'],
      deny: ['Read(./.env)'],
      settings: {
        root: '/work/repo',
        userDirs: ['/home/ci/.claude'],
        layers: ['project', 'local'],
        trusted: false,
      },
      classifier: { model: 'anthropic/claude-haiku-4-5', timeout: 10000, transcriptMessages: 8 },
      rememberIn: 'session',
      rememberLayers: ['session', 'local'],
    });
    expect(config.budget).toEqual({
      session: { maxCostUsd: 2.5, maxTokens: 400000 },
      agent: { maxToolCalls: 50 },
      warnAt: 0.75,
      allowRaise: false,
    });
    expect(config.llm?.defaultModel).toBe('ollama/qwen3:8b');
  });

  it('keeps them through defineConfig and overrides, settings as true or a mode of its own', () => {
    expect(
      defineConfig({
        permissions: { mode: 'dontAsk', settings: true, deny: ['Bash(rm *)'] },
        budget: { session: { maxCostUsd: 1 } },
        limits: { onExceeded: 'throw' },
      })
    ).toMatchObject({
      permissions: { mode: 'dontAsk', settings: true, deny: ['Bash(rm *)'] },
      budget: { session: { maxCostUsd: 1 } },
      limits: { onExceeded: 'throw' },
    });

    writeFileSync(path, 'permissions:\n  mode: plan\n  allow: [Read]\n');
    const config = loadConfig({
      configPath: path,
      skipEnv: true,
      overrides: { permissions: { mode: 'bypassPermissions' } },
    });
    expect(config.permissions).toEqual({ mode: 'bypassPermissions', allow: ['Read'] });
  });

  it.each([
    ['an unknown mode', 'permissions:\n  mode: yolo\n', /permissions\.mode/],
    ['a rule that is not text', 'permissions:\n  allow: [42]\n', /permissions\.allow/],
    ['a layer it cannot save to', 'permissions:\n  rememberIn: managed\n', /rememberIn/],
    ['a classifier without a model', 'permissions:\n  classifier:\n    timeout: 5\n', /model/],
    ['a negative budget', 'budget:\n  session:\n    maxCostUsd: -1\n', /maxCostUsd/],
    ['a warning share over 1', 'budget:\n  warnAt: 2\n', /warnAt/],
    ['an unknown onExceeded', 'limits:\n  onExceeded: ignore\n', /onExceeded/],
  ])('refuses %s', (_name, content, problem) => {
    writeFileSync(path, content);
    expect(() => loadConfig({ configPath: path, skipEnv: true })).toThrow(problem);
  });
});

describe('hooks and project instructions', () => {
  const path = 'test-hooks-config.yaml';

  afterEach(() => {
    if (existsSync(path)) unlinkSync(path);
  });

  it('keeps them through a YAML file', () => {
    writeFileSync(
      path,
      `
hooks:
  settings:
    root: /srv/app
    trustedRoots: [/srv/app]
  promptModel: ollama/qwen3:8b
  allowedHttpHookUrls: ['https://hooks.example.com/*']
  env:
    allow: [PATH, HOME]
  hooks:
    PreToolUse:
      - matcher: Bash
        hooks:
          - type: command
            command: node
            args: ['$\${CLAUDE_PROJECT_DIR}/.claude/hooks/guard.js']
            timeout: 30
          - type: http
            url: https://hooks.example.com/pre
    Stop:
      - hooks:
          - type: prompt
            prompt: Are all tasks done? $ARGUMENTS
instructions:
  projectFiles:
    maxChars: 16000
    allowImportsFrom: [/srv/shared]
`
    );
    const config = loadConfig({ configPath: path, skipEnv: true });
    expect(config.hooks).toEqual({
      settings: { root: '/srv/app', trustedRoots: ['/srv/app'] },
      promptModel: 'ollama/qwen3:8b',
      allowedHttpHookUrls: ['https://hooks.example.com/*'],
      env: { allow: ['PATH', 'HOME'] },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: 'node',
                args: ['$' + '{CLAUDE_PROJECT_DIR}/.claude/hooks/guard.js'],
                timeout: 30,
              },
              { type: 'http', url: 'https://hooks.example.com/pre' },
            ],
          },
        ],
        Stop: [{ hooks: [{ type: 'prompt', prompt: 'Are all tasks done? $ARGUMENTS' }] }],
      },
    });
    expect(config.instructions).toEqual({
      projectFiles: { maxChars: 16000, allowImportsFrom: ['/srv/shared'] },
    });
  });

  it.each([
    [
      'an unknown handler type',
      'hooks:\n  hooks:\n    Stop:\n      - hooks:\n          - type: agent\n',
      /hooks/,
    ],
    ['an event it does not know', 'hooks:\n  hooks:\n    Nope: []\n', /hooks/],
    ['a negative limit', 'instructions:\n  projectFiles:\n    maxChars: -1\n', /maxChars/],
  ])('refuses %s', (_name, text, error) => {
    writeFileSync(path, text);
    expect(() => loadConfig({ configPath: path, skipEnv: true })).toThrow(error);
  });
});

describe('subagents and commands', () => {
  const path = 'test-subagents-config.yaml';

  afterEach(() => {
    if (existsSync(path)) unlinkSync(path);
  });

  it('keeps them through a YAML file', () => {
    writeFileSync(
      path,
      `
llm:
  modelAliases:
    sonnet: anthropic/claude-sonnet-5
subagents:
  files:
    root: /srv/app
    trusted: true
  approvalMode: bubble
  maxDepth: 2
  messages: conversation
  agents:
    reviewer:
      description: Reviews code
      prompt: You review.
      tools: [Read, Grep]
      permissionMode: plan
      maxTurns: 6
commands:
  files: true
  commands:
    standup: Summarize $ARGUMENTS
    fix:
      template: Fix issue $0
      allowedTools: ['Bash(gh *)']
      disallowedTools: [Write]
      effort: high
`
    );
    const config = loadConfig({ configPath: path, skipEnv: true });
    expect(config.llm?.modelAliases).toEqual({ sonnet: 'anthropic/claude-sonnet-5' });
    expect(config.subagents).toEqual({
      files: { root: '/srv/app', trusted: true },
      approvalMode: 'bubble',
      maxDepth: 2,
      messages: 'conversation',
      agents: {
        reviewer: {
          description: 'Reviews code',
          prompt: 'You review.',
          tools: ['Read', 'Grep'],
          permissionMode: 'plan',
          maxTurns: 6,
        },
      },
    });
    expect(config.commands).toEqual({
      files: true,
      commands: {
        standup: 'Summarize $ARGUMENTS',
        fix: {
          template: 'Fix issue $0',
          allowedTools: ['Bash(gh *)'],
          disallowedTools: ['Write'],
          effort: 'high',
        },
      },
    });
  });
});

describe('experimental_plugins', () => {
  const path = 'test-plugins-config.yaml';

  afterEach(() => {
    if (existsSync(path)) unlinkSync(path);
  });

  it('keeps them through a YAML file', () => {
    writeFileSync(
      path,
      `
experimental_plugins:
  dirs: [./plugins/review]
  installed: false
  settings:
    root: /srv/app
    trusted: true
  enabled:
    review@inline: true
    noisy@team: false
  options:
    review@inline:
      level: 2
      strict: true
  permissions:
    deny: ['WebFetch(domain:internal.example.com)']
  isolation:
    maxHeapMb: 128
  watch:
    debounceMs: 500
`
    );
    const config = loadConfig({ configPath: path, skipEnv: true });
    expect(config.experimental_plugins).toEqual({
      dirs: ['./plugins/review'],
      installed: false,
      settings: { root: '/srv/app', trusted: true },
      enabled: { 'review@inline': true, 'noisy@team': false },
      options: { 'review@inline': { level: 2, strict: true } },
      permissions: { deny: ['WebFetch(domain:internal.example.com)'] },
      isolation: { maxHeapMb: 128 },
      watch: { debounceMs: 500 },
    });
  });
});
