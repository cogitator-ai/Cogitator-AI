import { describe, it, expect, vi, beforeEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RuntimeBuilder } from '../runtime-builder';
import { createHookRegistry } from '../hooks';
import type { AssistantConfigInput } from '../assistant-config';

let mockFormatForPrompt = vi.fn().mockResolvedValue('');

const slackConfigs = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const cogitatorInstances = vi.hoisted(() => [] as Array<{ config: unknown }>);

vi.mock('../channels/slack', () => ({
  slackChannel: (config: Record<string, unknown>) => {
    slackConfigs.push(config);
    return {
      type: 'slack',
      onMessage: () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
    };
  },
}));

const whatsappConfigs = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const webchatConfigs = vi.hoisted(
  () => [] as Array<{ port: number; path?: string; auth?: (token: string) => boolean }>
);
const sentTexts = vi.hoisted(() => [] as string[]);

vi.mock('../channels/whatsapp', () => ({
  whatsappChannel: (config: Record<string, unknown>) => {
    whatsappConfigs.push(config);
    return {
      type: 'whatsapp',
      onMessage: () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      sendText: async (_channelId: string, text: string) => {
        sentTexts.push(text);
        return `sent_${sentTexts.length}`;
      },
      editText: async () => undefined,
      sendFile: async () => undefined,
      sendTyping: async () => undefined,
    };
  },
}));

vi.mock('../channels/webchat', () => ({
  webchatChannel: (config: { port: number; path?: string; auth?: (token: string) => boolean }) => {
    webchatConfigs.push(config);
    return {
      type: 'webchat',
      onMessage: () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
    };
  },
}));

vi.mock('@cogitator-ai/memory', () => {
  class MockSQLiteAdapter {
    provider = 'sqlite' as const;
    connect = vi.fn().mockResolvedValue({ success: true });
    disconnect = vi.fn().mockResolvedValue({ success: true });
    constructor(_config: unknown) {}
  }

  class MockSQLiteGraphAdapter {
    initialize = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    addNode = vi.fn().mockResolvedValue({ success: true, data: { id: 'n1' } });
    queryNodes = vi.fn().mockResolvedValue({ success: true, data: [] });
    deleteNode = vi.fn().mockResolvedValue({ success: true });
    searchNodesSemantic = vi.fn().mockResolvedValue({ success: true, data: [] });
    constructor(_config: unknown) {}
  }

  class MockCoreFactsStore {
    initialize = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    get formatForPrompt() {
      return mockFormatForPrompt;
    }
    set = vi.fn().mockResolvedValue(undefined);
    get = vi.fn().mockResolvedValue(null);
    getAll = vi.fn().mockResolvedValue({});
    constructor(_config: unknown) {}
  }

  class MockSessionManager {
    constructor(_adapter: unknown) {}
    getOrCreate = vi.fn().mockResolvedValue({ id: 's1', messageCount: 0 });
    incrementMessageCount = vi.fn().mockResolvedValue(undefined);
  }

  class MockCompactionService {
    constructor(_config: unknown) {}
    compact = vi.fn().mockResolvedValue(undefined);
  }

  class MockLLMEntityExtractor {
    extract = vi
      .fn()
      .mockResolvedValue({ entities: [], relations: [], text: '', timestamp: new Date() });
    constructor(_backend: unknown, _config?: unknown) {}
  }

  return {
    SQLiteAdapter: MockSQLiteAdapter,
    SQLiteGraphAdapter: MockSQLiteGraphAdapter,
    CoreFactsStore: MockCoreFactsStore,
    SessionManager: MockSessionManager,
    CompactionService: MockCompactionService,
    LLMEntityExtractor: MockLLMEntityExtractor,
    createEmbeddingService: vi.fn(),
    InMemoryEmbeddingAdapter: vi.fn(),
  };
});

vi.mock('@cogitator-ai/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cogitator-ai/core')>();
  const makeTool = (name: string, description: string) => ({
    name,
    description,
    parameters: {},
    execute: vi.fn().mockResolvedValue({}),
  });

  class Agent {
    id: string;
    name: string;
    config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      this.id = `agent_test`;
      this.name = config.name as string;
      this.config = { temperature: 0.7, maxIterations: 10, timeout: 120000, ...config };
    }
    get model() {
      return this.config.model;
    }
    get instructions() {
      return this.config.instructions;
    }
    get tools() {
      return (this.config.tools as unknown[]) ?? [];
    }
  }

  class MockCogitator {
    close = vi.fn().mockResolvedValue(undefined);
    run = vi.fn().mockResolvedValue({ output: 'ok' });
    tools = { register: vi.fn() };
    getLLMBackend = vi.fn().mockReturnValue({
      chat: vi.fn().mockResolvedValue({
        id: '1',
        content: '{}',
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      }),
    });
    constructor(public config: unknown) {
      cogitatorInstances.push(this);
    }
  }

  const builtinTools = [
    makeTool('calculator', 'Perform mathematical calculations'),
    makeTool('datetime', 'Get current date and time'),
    makeTool('web_search', 'Search the web'),
    makeTool('github_api', 'GitHub API'),
    makeTool('file_read', 'Read a file'),
    makeTool('file_write', 'Write a file'),
    makeTool('file_list', 'List files'),
    makeTool('file_exists', 'Check if file exists'),
    makeTool('file_delete', 'Delete a file'),
  ];

  function createMemoryTools(_config: Record<string, unknown>) {
    return [
      makeTool('remember', 'Save a fact'),
      makeTool('recall', 'Search memories'),
      makeTool('forget', 'Delete facts'),
    ];
  }

  function createSchedulerTools(_config: Record<string, unknown>) {
    return [
      makeTool('schedule_task', 'Schedule a task'),
      makeTool('list_tasks', 'List tasks'),
      makeTool('cancel_task', 'Cancel a task'),
    ];
  }

  function createCapabilitiesTool(_capDoc: string) {
    return makeTool('lookup_capabilities', 'Check capabilities');
  }

  function createDeviceTools() {
    return [
      makeTool('clipboard_read', 'Read clipboard'),
      makeTool('clipboard_write', 'Write clipboard'),
      makeTool('system_info', 'System info'),
      makeTool('screenshot', 'Take screenshot'),
    ];
  }

  function parseModel(modelString: string) {
    if (modelString.includes('/')) {
      const [provider, ...rest] = modelString.split('/');
      return { provider, model: rest.join('/') };
    }
    return { provider: null, model: modelString };
  }

  function toolFactory(config: Record<string, unknown>) {
    return {
      ...config,
      toJSON: () => ({
        name: config.name,
        description: config.description,
        parameters: { type: 'object', properties: {} },
      }),
    };
  }

  return {
    Agent,
    Cogitator: MockCogitator,
    builtinTools,
    createMemoryTools,
    createSchedulerTools,
    createCapabilitiesTool,
    createDeviceTools,
    parseModel,
    restrictFileTools: actual.restrictFileTools,
    tool: toolFactory,
  };
});

const mcpServerTools = vi.hoisted(() => new Map<string, string[]>());

vi.mock('@cogitator-ai/mcp', () => ({
  MCPClient: {
    connect: vi.fn(async (config: { command: string }) => ({
      getTools: async (options?: { namePrefix?: string }) =>
        (mcpServerTools.get(config.command) ?? []).map((name) => ({
          name: `${options?.namePrefix ?? ''}${name}`,
          description: `${name} on ${config.command}`,
          parameters: {},
          execute: vi.fn(),
        })),
      close: vi.fn(async () => undefined),
    })),
  },
}));

const minimalConfig = {
  name: 'test-bot',
  personality: 'Helpful assistant',
  llm: { provider: 'google', model: 'google/gemini-2.5-flash' },
  channels: {},
  capabilities: {},
  memory: { adapter: 'sqlite', path: ':memory:' },
} satisfies AssistantConfigInput;

describe('RuntimeBuilder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFormatForPrompt = vi.fn().mockResolvedValue('');
  });

  it('builds runtime from minimal config', async () => {
    const builder = new RuntimeBuilder(minimalConfig, { GOOGLE_API_KEY: 'test-key' });
    const built = await builder.build();

    expect(built.agent).toBeDefined();
    expect(built.agent.name).toBe('test-bot');
    expect(built.cogitator).toBeDefined();
    expect(built.gateway).toBeDefined();
    expect(built.cleanup).toBeInstanceOf(Function);

    await built.cleanup();
  });

  it('applies the schema defaults to a config built in code', async () => {
    const built = await new RuntimeBuilder(minimalConfig, {}).build();

    const toolNames = built.agent.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('remember');
    await built.cleanup();
  });

  it('rejects a config the schema refuses', () => {
    expect(() => new RuntimeBuilder({ ...minimalConfig, name: 42 } as never, {})).toThrow();
  });

  it('includes memory tools when knowledgeGraph enabled', async () => {
    const config: AssistantConfigInput = {
      ...minimalConfig,
      memory: { ...minimalConfig.memory, knowledgeGraph: true },
    };

    const builder = new RuntimeBuilder(config, { GOOGLE_API_KEY: 'test-key' });
    const built = await builder.build();

    const toolNames = built.agent.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('remember');
    expect(toolNames).toContain('recall');
    expect(toolNames).toContain('forget');

    await built.cleanup();
  });

  it('passes SLACK_APP_TOKEN and SLACK_PORT to the Slack channel', async () => {
    slackConfigs.length = 0;
    const config: AssistantConfigInput = { ...minimalConfig, channels: { slack: {} } };
    const env = {
      GOOGLE_API_KEY: 'test-key',
      SLACK_BOT_TOKEN: 'xoxb-1',
      SLACK_SIGNING_SECRET: 'secret',
      SLACK_APP_TOKEN: 'xapp-1',
      SLACK_PORT: '3105',
    };

    const built = await new RuntimeBuilder(config, env).build();

    expect(slackConfigs).toEqual([
      { token: 'xoxb-1', signingSecret: 'secret', appToken: 'xapp-1', port: 3105 },
    ]);
    await built.cleanup();
  });

  it('warns when Slack runs without an app token', async () => {
    slackConfigs.length = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const config: AssistantConfigInput = { ...minimalConfig, channels: { slack: {} } };

    const built = await new RuntimeBuilder(config, {
      GOOGLE_API_KEY: 'test-key',
      SLACK_BOT_TOKEN: 'xoxb-1',
      SLACK_SIGNING_SECRET: 'secret',
    }).build();

    expect(slackConfigs).toEqual([{ token: 'xoxb-1', signingSecret: 'secret' }]);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('SLACK_APP_TOKEN'))).toBe(true);
    warn.mockRestore();
    await built.cleanup();
  });

  it('includes lookup_capabilities tool', async () => {
    const builder = new RuntimeBuilder(minimalConfig, { GOOGLE_API_KEY: 'test-key' });
    const built = await builder.build();

    const toolNames = built.agent.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('lookup_capabilities');

    await built.cleanup();
  });

  it('includes personality in agent instructions', async () => {
    const builder = new RuntimeBuilder(minimalConfig, { GOOGLE_API_KEY: 'test-key' });
    const built = await builder.build();

    expect(built.agent.instructions).toContain('Helpful assistant');

    await built.cleanup();
  });

  it('adds datetime and calculator tools by default', async () => {
    const builder = new RuntimeBuilder(minimalConfig, { GOOGLE_API_KEY: 'test-key' });
    const built = await builder.build();

    const toolNames = built.agent.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('calculator');
    expect(toolNames).toContain('datetime');

    await built.cleanup();
  });

  it('adds web_search tool when capability enabled', async () => {
    const config: AssistantConfigInput = {
      ...minimalConfig,
      capabilities: { webSearch: true },
    };

    const builder = new RuntimeBuilder(config, {
      GOOGLE_API_KEY: 'test-key',
      TAVILY_API_KEY: 'test-tavily-key',
    });
    const built = await builder.build();

    const toolNames = built.agent.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('web_search');

    await built.cleanup();
  });

  it('adds file tools when fileSystem capability enabled', async () => {
    const config: AssistantConfigInput = {
      ...minimalConfig,
      capabilities: { fileSystem: { paths: ['/tmp'] } },
    };

    const builder = new RuntimeBuilder(config, { GOOGLE_API_KEY: 'test-key' });
    const built = await builder.build();

    const toolNames = built.agent.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('file_read');
    expect(toolNames).toContain('file_write');
    expect(toolNames).toContain('file_list');

    await built.cleanup();
  });

  it('adds github_api tool when capability enabled', async () => {
    const config: AssistantConfigInput = {
      ...minimalConfig,
      capabilities: { github: true },
    };

    const builder = new RuntimeBuilder(config, { GOOGLE_API_KEY: 'test-key' });
    const built = await builder.build();

    const toolNames = built.agent.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('github_api');

    await built.cleanup();
  });

  it('includes scheduler tools and hint when enabled', async () => {
    const config: AssistantConfigInput = {
      ...minimalConfig,
      capabilities: { scheduler: true },
    };

    const builder = new RuntimeBuilder(config, { GOOGLE_API_KEY: 'test-key' });
    const built = await builder.build();

    const toolNames = built.agent.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('schedule_task');
    expect(toolNames).toContain('list_tasks');
    expect(toolNames).toContain('cancel_task');
    expect(built.agent.instructions).toContain('schedule_task');
    expect(built.scheduler).not.toBeNull();

    await built.cleanup();
  });

  it('adds core facts to instructions when available', async () => {
    mockFormatForPrompt = vi.fn().mockResolvedValue('name: Alice\nlanguage: English');

    const builder = new RuntimeBuilder(minimalConfig, { GOOGLE_API_KEY: 'test-key' });
    const built = await builder.build();

    expect(built.agent.instructions).toContain('What I know about the user');
    expect(built.agent.instructions).toContain('name: Alice');

    await built.cleanup();
  });

  it('cleanup closes resources without error', async () => {
    const builder = new RuntimeBuilder(minimalConfig, { GOOGLE_API_KEY: 'test-key' });
    const built = await builder.build();

    await expect(built.cleanup()).resolves.not.toThrow();
  });

  it('builds cogitator with correct provider config', async () => {
    const builder = new RuntimeBuilder(minimalConfig, { GOOGLE_API_KEY: 'my-key' });
    await builder.build();

    const latest = cogitatorInstances[cogitatorInstances.length - 1];
    expect(latest.config).toEqual(
      expect.objectContaining({
        llm: expect.objectContaining({
          defaultModel: 'google/gemini-2.5-flash',
          providers: expect.objectContaining({
            google: expect.objectContaining({ apiKey: 'my-key' }),
          }),
        }),
      })
    );
  });

  it('does not include memory tools when knowledgeGraph is explicitly false', async () => {
    const config: AssistantConfigInput = {
      ...minimalConfig,
      memory: { ...minimalConfig.memory, knowledgeGraph: false },
    };

    const builder = new RuntimeBuilder(config, { GOOGLE_API_KEY: 'test-key' });
    const built = await builder.build();

    const toolNames = built.agent.tools.map((t: { name: string }) => t.name);
    expect(toolNames).not.toContain('remember');
    expect(toolNames).not.toContain('recall');

    await built.cleanup();
  });

  it('adds rate limit middleware when configured', async () => {
    const config: AssistantConfigInput = {
      ...minimalConfig,
      rateLimit: { maxPerMinute: 10 },
    };

    const builder = new RuntimeBuilder(config, { GOOGLE_API_KEY: 'test-key' });
    const built = await builder.build();

    expect(built.gateway).toBeDefined();

    await built.cleanup();
  });

  it('returns null scheduler by default', async () => {
    const builder = new RuntimeBuilder(minimalConfig, { GOOGLE_API_KEY: 'test-key' });
    const built = await builder.build();

    expect(built.scheduler).toBeNull();

    await built.cleanup();
  });

  it('adds device tools when deviceTools capability enabled', async () => {
    const config: AssistantConfigInput = {
      ...minimalConfig,
      capabilities: { deviceTools: true },
    };

    const builder = new RuntimeBuilder(config, { GOOGLE_API_KEY: 'test-key' });
    const built = await builder.build();

    const toolNames = built.agent.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('clipboard_read');
    expect(toolNames).toContain('clipboard_write');
    expect(toolNames).toContain('system_info');
    expect(toolNames).toContain('screenshot');

    await built.cleanup();
  });

  it('uses correct model in agent config', async () => {
    const config: AssistantConfigInput = {
      ...minimalConfig,
      llm: { provider: 'openai', model: 'openai/gpt-4o' },
    };

    const builder = new RuntimeBuilder(config, { OPENAI_API_KEY: 'sk-test' });
    const built = await builder.build();

    expect(built.agent.model).toBe('openai/gpt-4o');

    await built.cleanup();
  });
  it('sandboxes file tools to the configured paths', async () => {
    const config: AssistantConfigInput = {
      ...minimalConfig,
      capabilities: { fileSystem: { paths: ['/tmp/cogitator-allowed'] } },
    };

    const builder = new RuntimeBuilder(config, { GOOGLE_API_KEY: 'test-key' });
    const built = await builder.build();

    const fileRead = built.agent.tools.find((t: { name: string }) => t.name === 'file_read') as {
      execute: (params: unknown, ctx: unknown) => Promise<{ error?: string }>;
    };
    const result = await fileRead.execute({ path: '/etc/passwd' }, {});
    expect(result.error).toContain('Access denied');

    await built.cleanup();
  });

  it('rebuilds instructions per message so core facts and time stay current', async () => {
    const builder = new RuntimeBuilder(minimalConfig, { GOOGLE_API_KEY: 'test-key' });
    const built = await builder.build();

    mockFormatForPrompt.mockResolvedValue('name: Bob');
    const factory = (
      built.gateway as unknown as {
        config: {
          agent: (user: { id: string; channelType: string }) => Promise<{
            id: string;
            instructions: string;
            model: string;
          }>;
        };
      }
    ).config.agent;
    const perMessage = await factory({ id: 'u1', channelType: 'telegram' });

    expect(perMessage.id).toBe(built.agent.id);
    expect(perMessage.instructions).toContain('name: Bob');
    expect(perMessage.model).toBe('google/gemini-2.5-flash');

    await built.cleanup();
  });

  it('builds a WhatsApp channel with its session under ~/.cogitator by default', async () => {
    whatsappConfigs.length = 0;
    const built = await new RuntimeBuilder(
      { ...minimalConfig, channels: { whatsapp: { ownerIds: ['15550001111'] } } },
      { GOOGLE_API_KEY: 'test-key' }
    ).build();

    expect(whatsappConfigs).toEqual([
      { sessionPath: join(homedir(), '.cogitator', 'whatsapp-session') },
    ]);
    expect(built.gateway.stats.connectedChannels).toContain('whatsapp');
    await built.cleanup();
  });

  it('expands ~ in the WhatsApp session path', async () => {
    whatsappConfigs.length = 0;
    const built = await new RuntimeBuilder(
      { ...minimalConfig, channels: { whatsapp: { sessionPath: '~/wa' } } },
      { GOOGLE_API_KEY: 'test-key' }
    ).build();

    expect(whatsappConfigs).toEqual([{ sessionPath: join(homedir(), 'wa') }]);
    await built.cleanup();
  });

  it('builds a WebChat channel guarded by WEBCHAT_TOKEN', async () => {
    webchatConfigs.length = 0;
    const built = await new RuntimeBuilder(
      { ...minimalConfig, channels: { webchat: { path: '/chat' } } },
      { GOOGLE_API_KEY: 'test-key', WEBCHAT_TOKEN: 's3cret' }
    ).build();

    expect(webchatConfigs).toHaveLength(1);
    const [webchat] = webchatConfigs;
    expect(webchat).toMatchObject({ port: 8080, path: '/chat' });
    expect(webchat.auth?.('s3cret')).toBe(true);
    expect(webchat.auth?.('s3cre')).toBe(false);
    expect(webchat.auth?.('')).toBe(false);
    await built.cleanup();
  });

  it('does not open WebChat without WEBCHAT_TOKEN', async () => {
    webchatConfigs.length = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const built = await new RuntimeBuilder(
      { ...minimalConfig, channels: { webchat: {} } },
      { GOOGLE_API_KEY: 'test-key' }
    ).build();

    expect(webchatConfigs).toEqual([]);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('WEBCHAT_TOKEN'))).toBe(true);
    warn.mockRestore();
    await built.cleanup();
  });

  it('passes hooks and approvals to the gateway', async () => {
    sentTexts.length = 0;
    const hooks = createHookRegistry();
    const received = vi.fn();
    const requested = vi.fn();
    hooks.on('message:received', received);
    hooks.on('approval:requested', requested);
    const format = vi.fn(
      (approvals: readonly unknown[], words: { approveWords: readonly string[] }) =>
        `approve ${approvals.length} with ${words.approveWords.join('/')}`
    );

    const built = await new RuntimeBuilder(
      {
        ...minimalConfig,
        channels: { whatsapp: {} },
        approvals: { approveWords: ['ok'], notAllowedMessage: 'not yours' },
      },
      { GOOGLE_API_KEY: 'test-key' },
      { hooks, approvals: { format } }
    ).build();

    const run = built.cogitator.run as unknown as ReturnType<typeof vi.fn>;
    run.mockResolvedValueOnce({
      output: '',
      status: 'paused',
      pendingApprovals: [
        { toolCallId: 'c1', toolName: 'file_delete', arguments: {}, description: 'Delete a file' },
      ],
    });

    await built.gateway.injectMessage({
      id: 'm1',
      channelType: 'whatsapp',
      channelId: '15550001111',
      userId: '15550001111',
      text: 'delete it',
      raw: {},
    });

    expect(received).toHaveBeenCalledTimes(1);
    expect(requested).toHaveBeenCalledTimes(1);
    expect(format).toHaveBeenCalledWith(
      [expect.objectContaining({ toolName: 'file_delete' })],
      expect.objectContaining({ approveWords: ['ok'] })
    );
    expect(sentTexts).toEqual(['approve 1 with ok']);
    await built.cleanup();
  });

  it('keeps same-named tools of several MCP servers apart and names them to the model', async () => {
    mcpServerTools.set('github-mcp', ['search', 'create_issue']);
    mcpServerTools.set('gitlab-mcp', ['search']);
    const builder = new RuntimeBuilder(
      {
        ...minimalConfig,
        mcpServers: {
          github: { command: 'github-mcp', args: [] },
          gitlab: { command: 'gitlab-mcp', args: [] },
        },
      },
      { GOOGLE_API_KEY: 'test-key' }
    );
    const built = await builder.build();

    const toolNames = built.agent.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toEqual(
      expect.arrayContaining(['mcp_github_search', 'mcp_github_create_issue', 'mcp_gitlab_search'])
    );
    expect(new Set(toolNames).size).toBe(toolNames.length);
    expect(built.agent.instructions).toContain(
      '- github: mcp_github_search, mcp_github_create_issue\n- gitlab: mcp_gitlab_search'
    );
    expect(built.agent.instructions).not.toContain('look for tools with mcp_ prefix');

    await built.cleanup();
  });

  it('requires a connection string for the postgres adapter', async () => {
    const config: AssistantConfigInput = {
      ...minimalConfig,
      memory: { ...minimalConfig.memory, adapter: 'postgres' },
    };

    const builder = new RuntimeBuilder(config, { GOOGLE_API_KEY: 'test-key' });
    await expect(builder.build()).rejects.toThrow('connectionString');
  });
});
