import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Tool, Channel, GatewayMiddleware, LLMProvidersConfig } from '@cogitator-ai/types';
import {
  Agent,
  Cogitator,
  builtinTools,
  createMemoryTools,
  createSchedulerTools,
  createCapabilitiesTool,
  createDeviceTools,
  createSelfConfigTools,
  createSelfTools,
  loadCustomTools,
  parseModel,
  tool as createTool,
} from '@cogitator-ai/core';
import {
  SQLiteAdapter,
  SQLiteGraphAdapter,
  CoreFactsStore,
  LLMEntityExtractor,
  createEmbeddingService,
  InMemoryEmbeddingAdapter,
} from '@cogitator-ai/memory';
import type { LLMBackendMinimal } from '@cogitator-ai/memory';
import type { EmbeddingServiceConfig } from '@cogitator-ai/types';
import { Gateway } from './gateway';
import { HeartbeatScheduler } from './heartbeat';
import { SimpleTimerStore } from './simple-timer-store';
import { telegramChannel } from './channels/telegram';
import { discordChannel } from './channels/discord';
import { slackChannel } from './channels/slack';
import { ownerCommands } from './middleware/owner-commands';
import { rateLimit } from './middleware/rate-limit';
import { autoExtract } from './middleware/auto-extract';
import type { EntityExtractor } from './middleware/auto-extract';
import { generateCapabilitiesDoc } from './capabilities';
import type { AssistantConfigOutput } from '@cogitator-ai/config';

export type AssistantConfig = AssistantConfigOutput;

export interface BuiltRuntime {
  agent: Agent;
  cogitator: Cogitator;
  gateway: Gateway;
  scheduler: HeartbeatScheduler | null;
  cleanup: () => Promise<void>;
}

interface CleanupResources {
  browserSession?: { close(): Promise<void> };
  mcpClients: Array<{ close(): Promise<void> }>;
}

export interface RuntimeBuilderOpts {
  configPath?: string;
  configHelpers?: {
    parseYaml: (s: string) => unknown;
    stringifyYaml: (o: unknown) => string;
    validateConfig: (o: unknown) => unknown;
  };
}

export class RuntimeBuilder {
  constructor(
    private config: AssistantConfig,
    private env: Record<string, string | undefined>,
    private opts?: RuntimeBuilderOpts
  ) {}

  async build(): Promise<BuiltRuntime> {
    const cogitator = this.buildCogitator();
    const cleanupResources: CleanupResources = { mcpClients: [] };

    const memoryPath = this.config.memory.path ?? '~/.cogitator/memory.db';
    const resolvedPath = memoryPath.replace(/^~/, homedir());

    const memoryAdapter = new SQLiteAdapter({ provider: 'sqlite', path: resolvedPath });
    await memoryAdapter.connect();

    let graphAdapter: SQLiteGraphAdapter | null = null;
    if (this.config.memory.knowledgeGraph !== false) {
      graphAdapter = new SQLiteGraphAdapter({ path: resolvedPath });
      await graphAdapter.initialize();
    }

    const coreFacts = new CoreFactsStore({ path: resolvedPath });
    await coreFacts.initialize();

    const tools: Tool[] = [];

    if (this.config.capabilities.webSearch) {
      const found = builtinTools.find((t) => t.name === 'web_search');
      if (found) tools.push(found);
    }

    if (this.config.capabilities.fileSystem) {
      tools.push(...builtinTools.filter((t) => t.name.startsWith('file_')));
    }

    if (this.config.capabilities.github) {
      const found = builtinTools.find((t) => t.name === 'github_api');
      if (found) tools.push(found);
    }

    tools.push(...builtinTools.filter((t) => t.name === 'calculator' || t.name === 'datetime'));

    if (graphAdapter) {
      tools.push(
        ...createMemoryTools({
          graphAdapter,
          coreFacts,
          agentId: this.config.name,
        })
      );
    }

    let timerStore: SimpleTimerStore | null = null;
    if (this.config.capabilities.scheduler) {
      timerStore = new SimpleTimerStore();
      tools.push(
        ...createSchedulerTools({
          store: timerStore,
          defaultChannel: 'system',
        })
      );
    }

    if (this.config.capabilities.deviceTools) {
      tools.push(...createDeviceTools());
    }

    if (this.config.capabilities.selfConfig && this.opts?.configPath && this.opts.configHelpers) {
      tools.push(
        ...createSelfConfigTools({
          configPath: this.opts.configPath,
          ...this.opts.configHelpers,
          onConfigUpdated: () => {
            console.log(`[${this.config.name}] Config updated, restarting...`);
            process.exit(78);
          },
        })
      );
    }

    const toolsDir = this.resolveToolsDir();
    if (this.config.capabilities.selfTools) {
      const customTools = await loadCustomTools(toolsDir);
      if (customTools.length > 0) {
        tools.push(...customTools);
        console.log(`[${this.config.name}] Loaded ${customTools.length} custom tool(s)`);
      }

      tools.push(
        ...createSelfTools({
          toolsDir,
          onToolsChanged: () => {
            console.log(`[${this.config.name}] Custom tools changed, restart to activate`);
          },
        })
      );
    }

    await this.wireBrowser(tools, cleanupResources);
    await this.wireRAG(tools);
    await this.wireMCPServers(tools, cleanupResources);

    const coreFactsText = await coreFacts.formatForPrompt();
    const channels = this.buildChannels();

    const capDoc = generateCapabilitiesDoc({
      tools: tools.map((t) => ({ name: t.name, description: t.description })),
      channels: channels.map((c) => c.type),
    });
    tools.push(createCapabilitiesTool(capDoc));

    const instructions = this.buildInstructions(coreFactsText);

    const agent = new Agent({
      name: this.config.name,
      model: this.config.llm.model,
      instructions,
      tools,
    });

    const middleware: GatewayMiddleware[] = [];

    const ownerIds: Record<string, string> = {};
    if (this.config.channels.telegram?.ownerIds?.[0]) {
      ownerIds.telegram = this.config.channels.telegram.ownerIds[0];
    }
    if (this.config.channels.discord?.ownerIds?.[0]) {
      ownerIds.discord = this.config.channels.discord.ownerIds[0];
    }
    if (this.config.channels.slack?.ownerIds?.[0]) {
      ownerIds.slack = this.config.channels.slack.ownerIds[0];
    }
    if (Object.keys(ownerIds).length > 0) {
      middleware.push(ownerCommands({ ownerIds }));
    }

    if (this.config.rateLimit) {
      middleware.push(rateLimit({ maxPerMinute: this.config.rateLimit.maxPerMinute }));
    }

    if (this.config.memory.autoExtract !== false && graphAdapter) {
      const extractorBackend = this.createExtractorBackend(cogitator);
      const llmExtractor = new LLMEntityExtractor(extractorBackend);
      const extractor: EntityExtractor = {
        async extract(text: string) {
          const result = await llmExtractor.extract(text);
          return {
            entities: result.entities.map((e) => ({
              name: e.name,
              type: e.type,
              confidence: e.confidence,
              description: e.description,
            })),
            relations: result.relations.map((r) => ({
              from: r.sourceEntity,
              to: r.targetEntity,
              type: r.type,
              confidence: r.confidence,
            })),
          };
        },
      };
      middleware.push(
        autoExtract({
          extractor,
          graphAdapter,
          agentId: this.config.name,
          coreFacts,
        })
      );
    }

    const streamConfig = this.config.stream
      ? {
          flushInterval: this.config.stream.flushInterval ?? 600,
          minChunkSize: this.config.stream.minChunkSize ?? 30,
        }
      : { flushInterval: 600, minChunkSize: 30 };

    const gateway = new Gateway({
      agent,
      cogitator,
      channels,
      middleware,
      memory: memoryAdapter,
      stream: streamConfig,
      session: this.config.memory.compaction
        ? {
            compaction: {
              strategy: 'summary',
              threshold: this.config.memory.compaction.threshold,
              keepRecent: 10,
            },
          }
        : undefined,
      onError: (err, msg) => {
        console.error(`[${this.config.name}] Error for ${msg.userId}:`, err.message);
      },
    });

    const scheduler = this.buildScheduler(timerStore, gateway);

    const cleanup = async () => {
      if (scheduler) scheduler.stop();
      await gateway.stop();
      await coreFacts.close();
      if (graphAdapter) await graphAdapter.close();
      await memoryAdapter.disconnect();
      if (cleanupResources.browserSession) {
        await cleanupResources.browserSession.close().catch(() => {});
      }
      for (const client of cleanupResources.mcpClients) {
        await client.close().catch(() => {});
      }
      await cogitator.close();
    };

    return { agent, cogitator, gateway, scheduler, cleanup };
  }

  private createExtractorBackend(cogitator: Cogitator): LLMBackendMinimal {
    const llmBackend = cogitator.getLLMBackend(this.config.llm.model);
    const modelName = parseModel(this.config.llm.model).model;
    return {
      async chat(options: {
        messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
        responseFormat?: { type: 'json_object' };
      }) {
        const response = await llmBackend.chat({
          model: modelName,
          messages: options.messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          responseFormat: options.responseFormat,
        });
        return { content: response.content ?? '' };
      },
    };
  }

  private async wireBrowser(tools: Tool[], resources: CleanupResources): Promise<void> {
    if (!this.config.capabilities.browser) return;

    const browserCfg = this.config.capabilities.browser;
    const headless = typeof browserCfg === 'object' ? (browserCfg.headless ?? true) : true;
    const stealth = typeof browserCfg === 'object' ? (browserCfg.stealth ?? false) : false;

    try {
      const { BrowserSession, browserTools } = await import('@cogitator-ai/browser');

      await this.ensurePlaywright();

      const session = new BrowserSession({
        headless,
        ...(stealth ? { stealth: true } : {}),
      });
      await session.start();
      tools.push(...browserTools(session));
      resources.browserSession = session;
    } catch (err) {
      console.warn(
        '[RuntimeBuilder] Browser capability failed:',
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private async ensurePlaywright(): Promise<void> {
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');

    const cacheDir =
      process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), 'Library', 'Caches', 'ms-playwright');

    if (existsSync(cacheDir)) return;

    console.log('[RuntimeBuilder] Installing Playwright chromium...');
    const { execSync } = await import('node:child_process');
    execSync('npx playwright install chromium', { stdio: 'inherit' });
  }

  private async wireRAG(tools: Tool[]): Promise<void> {
    if (!this.config.capabilities.rag) return;

    try {
      const { RAGPipelineBuilder, TextLoader, ragTools } = await import('@cogitator-ai/rag');

      const embeddingConfig = this.resolveEmbeddingConfig();
      if (!embeddingConfig) {
        console.warn(
          '[RuntimeBuilder] RAG requires embedding configuration for the active provider'
        );
        return;
      }

      const embeddingService = createEmbeddingService(embeddingConfig);
      const embeddingAdapter = new InMemoryEmbeddingAdapter();

      const pipeline = new RAGPipelineBuilder()
        .withLoader(new TextLoader())
        .withEmbeddingService(embeddingService)
        .withEmbeddingAdapter(embeddingAdapter)
        .withConfig({ chunking: { strategy: 'recursive', chunkSize: 512, chunkOverlap: 50 } })
        .build();

      for (const path of this.config.capabilities.rag.paths) {
        await pipeline.ingest(path).catch((err: Error) => {
          console.warn(`[RuntimeBuilder] Failed to ingest RAG path "${path}":`, err.message);
        });
      }

      const [searchTool, ingestTool] = ragTools(pipeline);
      tools.push(
        createTool({
          name: searchTool.name,
          description: searchTool.description,
          parameters: searchTool.parameters,
          execute: searchTool.execute,
        }),
        createTool({
          name: ingestTool.name,
          description: ingestTool.description,
          parameters: ingestTool.parameters,
          execute: ingestTool.execute,
        })
      );
    } catch {
      console.warn('[RuntimeBuilder] RAG capability requires @cogitator-ai/rag package');
    }
  }

  private async wireMCPServers(tools: Tool[], resources: CleanupResources): Promise<void> {
    if (!this.config.mcpServers) return;

    try {
      const { MCPClient } = await import('@cogitator-ai/mcp');

      for (const [name, serverConfig] of Object.entries(this.config.mcpServers)) {
        try {
          const client = await MCPClient.connect({
            transport: 'stdio',
            command: serverConfig.command,
            args: serverConfig.args,
            env: serverConfig.env,
          });
          const serverTools = await client.getTools();
          tools.push(...serverTools);
          resources.mcpClients.push(client);
        } catch (err) {
          console.warn(
            `[RuntimeBuilder] Failed to connect MCP server "${name}":`,
            err instanceof Error ? err.message : String(err)
          );
        }
      }
    } catch {
      console.warn('[RuntimeBuilder] MCP servers require @cogitator-ai/mcp package');
    }
  }

  private resolveEmbeddingConfig(): EmbeddingServiceConfig | null {
    const { provider } = this.config.llm;

    if (provider === 'google') {
      const apiKey = this.env.GOOGLE_API_KEY ?? this.env.GEMINI_API_KEY;
      if (!apiKey) return null;
      return { provider: 'google', apiKey };
    }

    if (provider === 'openai') {
      const apiKey = this.env.OPENAI_API_KEY;
      if (!apiKey) return null;
      return { provider: 'openai', apiKey };
    }

    if (provider === 'ollama') {
      return {
        provider: 'ollama',
        baseUrl: this.env.OLLAMA_URL ?? 'http://localhost:11434',
      };
    }

    if (provider === 'anthropic') {
      const apiKey = this.env.OPENAI_API_KEY;
      if (apiKey) return { provider: 'openai', apiKey };
      console.warn(
        '[RuntimeBuilder] Anthropic has no embedding API; set OPENAI_API_KEY for RAG embeddings'
      );
      return null;
    }

    return null;
  }

  private buildCogitator(): Cogitator {
    const { provider } = this.config.llm;
    const providers: LLMProvidersConfig = {};

    if (provider === 'google') {
      providers.google = { apiKey: this.env.GOOGLE_API_KEY ?? this.env.GEMINI_API_KEY ?? '' };
    } else if (provider === 'openai') {
      providers.openai = { apiKey: this.env.OPENAI_API_KEY ?? '' };
    } else if (provider === 'anthropic') {
      providers.anthropic = { apiKey: this.env.ANTHROPIC_API_KEY ?? '' };
    } else if (provider === 'ollama') {
      providers.ollama = { baseUrl: this.env.OLLAMA_URL ?? 'http://localhost:11434' };
    }

    return new Cogitator({
      llm: {
        defaultModel: this.config.llm.model,
        providers,
      },
    });
  }

  private buildChannels(): Channel[] {
    const channels: Channel[] = [];

    if (this.config.channels.telegram) {
      const token = this.env.TG_TOKEN ?? this.env.TELEGRAM_TOKEN;
      if (token) {
        channels.push(telegramChannel({ token }));
      } else {
        console.warn('[RuntimeBuilder] Telegram configured but TG_TOKEN not found in env');
      }
    }

    if (this.config.channels.discord) {
      const token = this.env.DISCORD_TOKEN;
      if (token) {
        channels.push(discordChannel({ token }));
      } else {
        console.warn('[RuntimeBuilder] Discord configured but DISCORD_TOKEN not found in env');
      }
    }

    if (this.config.channels.slack) {
      const token = this.env.SLACK_BOT_TOKEN;
      const signingSecret = this.env.SLACK_SIGNING_SECRET;
      if (token && signingSecret) {
        channels.push(slackChannel({ token, signingSecret }));
      } else {
        console.warn(
          '[RuntimeBuilder] Slack configured but SLACK_BOT_TOKEN/SLACK_SIGNING_SECRET not found in env'
        );
      }
    }

    return channels;
  }

  private buildScheduler(
    timerStore: SimpleTimerStore | null,
    gateway: Gateway
  ): HeartbeatScheduler | null {
    if (!timerStore) return null;

    return new HeartbeatScheduler(timerStore, {
      onFire: async (msg) => {
        await gateway.injectMessage(msg);
      },
      pollInterval: 30_000,
    });
  }

  private buildInstructions(coreFactsText: string): string {
    let instructions = this.config.personality;

    if (coreFactsText) {
      instructions += `\n\n## What I know about the user\n${coreFactsText}`;
    }

    instructions += `\n\nIMPORTANT: Use your tools when relevant. Don't guess answers when tools can provide accurate data.`;

    if (this.config.capabilities.scheduler) {
      instructions += `\nYou can schedule tasks for the future using schedule_task. Use it when the user asks you to remind them or do something later.`;
    }

    instructions += `\nIf the user asks what you can do, use lookup_capabilities to check your available tools.`;

    if (this.config.capabilities.selfConfig) {
      instructions += `\nYou can read and modify your own configuration using config_read and config_update. After updating config, you will automatically restart with the new settings.`;
    }

    if (this.config.capabilities.selfTools) {
      instructions += `\nYou can create custom tools using create_tool. Write JavaScript ESM code with a default export containing name, description, parameters (JSON Schema), and an async execute function. You have full Node.js access (fetch, fs, child_process, etc.). Use test_tool to verify your tools work before telling the user. If a test fails, read the error, fix the code, and retry until it works. Use list_custom_tools to see existing custom tools and delete_tool to remove them. Custom tools persist across restarts.`;
    }

    return instructions;
  }

  private resolveToolsDir(): string {
    const cfg = this.config.capabilities.selfTools;
    if (typeof cfg === 'object' && cfg.path) {
      return cfg.path.replace(/^~/, homedir());
    }
    return join(homedir(), '.cogitator', 'tools');
  }
}
