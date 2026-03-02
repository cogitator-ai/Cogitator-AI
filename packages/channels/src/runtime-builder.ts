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
import { createSelfConfigTools } from './tools/self-config';
import { Gateway } from './gateway';
import { HeartbeatScheduler } from './heartbeat';
import { SimpleTimerStore } from './simple-timer-store';
import { telegramChannel } from './channels/telegram';
import { discordChannel } from './channels/discord';
import { slackChannel } from './channels/slack';
import { terminalChannel } from './channels/terminal';
import { ownerCommands } from './middleware/owner-commands';
import { rateLimit } from './middleware/rate-limit';
import { autoExtract } from './middleware/auto-extract';
import { dmPolicy } from './middleware/dm-policy';
import type { EntityExtractor } from './middleware/auto-extract';
import { generateCapabilitiesDoc } from './capabilities';
import { MediaProcessor } from './media/media-processor';
import type { SttProvider } from './media/media-processor';
import { LocalWhisper } from './media/whisper-local';
import { createWhisperDownloadTool } from './media/whisper-tool';
import { GroqSttProvider, OpenAISttProvider } from './media/whisper-api';
import type { AssistantConfigOutput } from './assistant-config';

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
    cogitator.memory = memoryAdapter;

    let graphAdapter: SQLiteGraphAdapter | null = null;
    if (this.config.memory.knowledgeGraph !== false) {
      graphAdapter = new SQLiteGraphAdapter({ path: resolvedPath });
      await graphAdapter.initialize();
    }

    const coreFacts = new CoreFactsStore({ path: resolvedPath });
    await coreFacts.initialize();

    const tools: Tool[] = [];

    if (this.config.capabilities.webSearch) {
      const hasSearchKey =
        this.env.TAVILY_API_KEY || this.env.BRAVE_API_KEY || this.env.SERPER_API_KEY;
      if (hasSearchKey) {
        const found = builtinTools.find((t) => t.name === 'web_search');
        if (found) tools.push(found);
      }
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
      timerStore = new SimpleTimerStore({
        persistPath: join(homedir(), '.cogitator', 'timers.json'),
      });
      const channelEntries = Object.entries(this.config.channels ?? {});
      const firstChannel = channelEntries[0];
      const firstOwnerId = firstChannel
        ? ((firstChannel[1] as Record<string, unknown>)?.ownerIds as string[])?.[0]
        : undefined;
      tools.push(
        ...createSchedulerTools({
          store: timerStore,
          defaultChannel: firstChannel?.[0] ?? 'system',
          defaultUserId: firstOwnerId,
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

      tools.push(...createSelfTools({ toolsDir }));
    }

    const whisper = new LocalWhisper();
    const sttProvider = this.buildSttProvider();
    if (!sttProvider) {
      tools.push(createWhisperDownloadTool(whisper));
    }

    const visionChecker = await this.buildVisionChecker();
    const mediaProcessor = new MediaProcessor(whisper, visionChecker, sttProvider);

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
      model: this.fullModelId,
      instructions,
      tools,
      maxIterations: 15,
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

    if (this.config.security) {
      middleware.push(
        dmPolicy({
          mode: this.config.security.dmPolicy,
          allowlist: this.config.security.allowlist,
          groupPolicy: this.config.security.groupPolicy,
          groupAllowlist: this.config.security.groupAllowlist,
          storePath: this.config.security.storePath,
          ownerIds,
        })
      );
    }

    if (Object.keys(ownerIds).length > 0) {
      middleware.push(
        ownerCommands({
          ownerIds,
          authorizedUserIds: this.config.security?.commandAccess?.authorized,
          publicCommands: this.config.security?.commandAccess?.publicCommands,
        })
      );
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
      mediaProcessor,
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
    if (scheduler) scheduler.start();

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
    const llmBackend = cogitator.getLLMBackend(this.fullModelId);
    const modelName = parseModel(this.fullModelId).model;
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
      tools.push(...browserTools(session));

      const { z } = await import('zod');
      tools.push(
        createTool({
          name: 'browser_search',
          description:
            'Search the web and return results text. This is the preferred way to search.',
          parameters: z.object({
            query: z.string().describe('Search query'),
          }),
          execute: async ({ query }) => {
            await session.ensureStarted();
            const page = session.page;
            const encoded = encodeURIComponent(query);
            await page.goto(`https://html.duckduckgo.com/html/?q=${encoded}`, {
              waitUntil: 'domcontentloaded',
            });
            const text = await page.innerText('body');
            return { query, results: text.slice(0, 4000) };
          },
        }),
        createTool({
          name: 'browser_visit',
          description:
            'Visit a URL and return the page text content. Use for reading articles, docs, etc.',
          parameters: z.object({
            url: z.string().describe('Full URL to visit'),
          }),
          execute: async ({ url }) => {
            await session.ensureStarted();
            const page = session.page;
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            const title = await page.title();
            const text = await page.innerText('body');
            return { url, title, content: text.slice(0, 6000) };
          },
        })
      );

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

      for (const rawPath of this.config.capabilities.rag.paths) {
        const resolved = rawPath.startsWith('~/') ? join(homedir(), rawPath.slice(2)) : rawPath;
        await pipeline.ingest(resolved).catch((err: Error) => {
          console.warn(`[RuntimeBuilder] Failed to ingest RAG path "${rawPath}":`, err.message);
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

  private get fullModelId(): string {
    const { provider, model } = this.config.llm;
    if (model.includes('/')) return model;
    return `${provider}/${model}`;
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
      providers.ollama = {
        baseUrl: this.env.OLLAMA_URL ?? 'http://localhost:11434',
        apiKey: this.env.OLLAMA_API_KEY,
      };
    }

    return new Cogitator({
      llm: {
        defaultModel: this.fullModelId,
        providers,
      },
    });
  }

  private buildChannels(): Channel[] {
    const channels: Channel[] = [];

    const ownerName = /assistant for (\w+)/i.exec(this.config.personality)?.[1] ?? undefined;
    channels.push(terminalChannel({ userName: ownerName }));

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

    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    instructions += `\n\nCurrent date and time: ${dateStr}, ${timeStr}.`;

    if (coreFactsText) {
      instructions += `\n\n## What I know about the user\n${coreFactsText}`;
    }

    instructions += `\n\nIMPORTANT: Use your tools when relevant. Don't guess answers when tools can provide accurate data.`;

    const fsCfg = this.config.capabilities.fileSystem;
    if (fsCfg) {
      const paths =
        typeof fsCfg === 'object' && 'paths' in fsCfg
          ? (fsCfg.paths as string[]).map((p) => p.replace(/^~/, homedir()))
          : [homedir()];
      instructions += `\nYou have filesystem access. Allowed paths: ${paths.join(', ')}. Use file_read, file_write, file_list tools. Always use absolute paths.`;
    }

    if (this.config.capabilities.browser) {
      instructions += `\n\n## Browser
You control a real browser. Key tools:
- browser_search(query) — web search, returns page text. Best for finding information.
- browser_visit(url) — visit any URL and get page content. Best for reading articles, checking sites, monitoring.
- browser_navigate, browser_click, browser_type, browser_get_text etc. — for complex interactions (filling forms, clicking buttons, multi-step workflows).
Respond based ONLY on extracted text. NEVER hallucinate content.`;
    }

    if (this.config.capabilities.scheduler) {
      instructions += `\n\n## Scheduling
You have a schedule_task tool for reminders, recurring actions, and deferred tasks.

When to use — IMMEDIATELY call schedule_task when the user:
- Says "remind me", "напомни", "in 10 minutes", "later", "through X time"
- Asks to schedule, set a timer, or defer something
- Says "every day at 9am", "each morning", "weekly"

Examples:
- "Remind me to check Slack in 5 min" → schedule_task({description: "Check Slack", delay: "5m"})
- "Every morning at 9" → schedule_task({description: "Morning briefing", cron: "0 9 * * *"})
- "At 3pm today" → schedule_task({description: "...", at: "${new Date().toISOString().split('T')[0]}T15:00:00"})

The channel and userId are filled automatically from the current conversation — do NOT pass them manually.
When the task fires, you will execute it — describe what to DO, not just what to say.
IMPORTANT: Do not just say "I'll remind you" — you MUST call schedule_task for it to work.`;
    }

    instructions += `\nIf the user asks what you can do, use lookup_capabilities to check your available tools.`;

    if (this.config.capabilities.selfConfig) {
      instructions += `\n\n## Self-Configuration
You can read and modify your own configuration using config_read and config_update. After updating config, you will automatically restart with the new settings.
You also have env_check and env_set tools to manage environment variables (.env file).

When the user asks to switch LLM provider or model:
1. Use env_check to verify required keys are set
2. If missing, tell the user what's needed and offer to set it via env_set if they provide the key
3. Then use config_update to change llm.provider and llm.model

Required env vars per provider:
- google: GOOGLE_API_KEY
- openai: OPENAI_API_KEY
- anthropic: ANTHROPIC_API_KEY
- ollama (local): none
- ollama (cloud): OLLAMA_URL=https://ollama.com, OLLAMA_API_KEY

Other env vars: GITHUB_TOKEN (for GitHub capability), TG_TOKEN, DISCORD_TOKEN, SLACK_BOT_TOKEN.`;
    }

    if (this.config.capabilities.selfTools) {
      instructions += `\nYou can create custom tools using create_tool. Write JavaScript ESM code with a default export containing name, description, parameters (JSON Schema), and an async execute function. You have full Node.js access (fetch, fs, child_process, etc.). After creating a tool, ALWAYS use test_tool to verify it works. If test fails, use create_tool again with fixed code. Use list_custom_tools to see existing tools and delete_tool to remove them. Custom tools are available after restart.`;
    }

    if (this.config.mcpServers && Object.keys(this.config.mcpServers).length > 0) {
      const serverNames = Object.keys(this.config.mcpServers);
      instructions += `\nYou have MCP (Model Context Protocol) servers connected: ${serverNames.join(', ')}. Their tools are available to you — look for tools with mcp_ prefix.`;
    }

    instructions += `\n\n## Media
You can receive images and voice messages from users.
- Images are automatically analyzed if your model supports vision.
- Voice messages require a speech recognition model. If it's not downloaded yet, suggest using download_stt_model tool (~75MB, works offline).`;

    return instructions;
  }

  private buildSttProvider(): SttProvider | null {
    if (this.env.GROQ_API_KEY) {
      return new GroqSttProvider({ apiKey: this.env.GROQ_API_KEY });
    }
    if (this.env.OPENAI_API_KEY) {
      return new OpenAISttProvider({ apiKey: this.env.OPENAI_API_KEY });
    }
    return null;
  }

  private async buildVisionChecker(): Promise<(modelId: string) => boolean> {
    try {
      const models = (await import('@cogitator-ai/models' as string)) as {
        getModel: (id: string) => { capabilities?: { supportsVision?: boolean } } | null;
        initializeModels: () => Promise<unknown>;
      };
      await models.initializeModels().catch(() => {});
      return (modelId: string) => {
        const model = models.getModel(modelId);
        return model?.capabilities?.supportsVision ?? true;
      };
    } catch {
      return () => true;
    }
  }

  private resolveToolsDir(): string {
    const cfg = this.config.capabilities.selfTools;
    if (typeof cfg === 'object' && cfg.path) {
      return cfg.path.replace(/^~/, homedir());
    }
    return join(homedir(), '.cogitator', 'tools');
  }
}
