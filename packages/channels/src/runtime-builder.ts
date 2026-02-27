import type { Tool, Channel, GatewayMiddleware } from '@cogitator-ai/types';
import {
  Agent,
  Cogitator,
  builtinTools,
  createMemoryTools,
  createCapabilitiesTool,
} from '@cogitator-ai/core';
import { SQLiteAdapter, SQLiteGraphAdapter, CoreFactsStore } from '@cogitator-ai/memory';
import { Gateway } from './gateway';
import { HeartbeatScheduler } from './heartbeat';
import { telegramChannel } from './channels/telegram';
import { discordChannel } from './channels/discord';
import { slackChannel } from './channels/slack';
import { ownerCommands } from './middleware/owner-commands';
import { rateLimit } from './middleware/rate-limit';
import { generateCapabilitiesDoc } from './capabilities';

export interface AssistantConfig {
  name: string;
  personality: string;
  llm: {
    provider: 'google' | 'openai' | 'anthropic' | 'ollama';
    model: string;
  };
  channels: {
    telegram?: { ownerIds?: string[] };
    discord?: { ownerIds?: string[] };
    slack?: { ownerIds?: string[] };
  };
  capabilities: {
    webSearch?: boolean;
    fileSystem?: { paths: string[] };
    github?: boolean;
    deviceTools?: boolean;
    browser?: boolean;
    scheduler?: boolean;
    rag?: { paths: string[] };
  };
  mcpServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  memory: {
    adapter: 'sqlite' | 'postgres';
    path?: string;
    autoExtract?: boolean;
    knowledgeGraph?: boolean;
    compaction?: { threshold: number };
  };
  stream?: { flushInterval?: number; minChunkSize?: number };
  rateLimit?: { maxPerMinute: number };
}

export interface BuiltRuntime {
  agent: Agent;
  cogitator: Cogitator;
  gateway: Gateway;
  scheduler: HeartbeatScheduler | null;
  cleanup: () => Promise<void>;
}

export class RuntimeBuilder {
  constructor(
    private config: AssistantConfig,
    private env: Record<string, string | undefined>
  ) {}

  async build(): Promise<BuiltRuntime> {
    const cogitator = this.buildCogitator();

    const memoryPath = this.config.memory.path ?? '~/.cogitator/memory.db';
    const resolvedPath = memoryPath.replace(/^~/, process.env.HOME ?? '.');

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

    const scheduler = this.buildScheduler();

    const cleanup = async () => {
      if (scheduler) scheduler.stop();
      await gateway.stop();
      await coreFacts.close();
      if (graphAdapter) await graphAdapter.close();
      await memoryAdapter.disconnect();
      await cogitator.close();
    };

    return { agent, cogitator, gateway, scheduler, cleanup };
  }

  private buildCogitator(): Cogitator {
    const { provider } = this.config.llm;

    const providersConfig: Record<string, Record<string, string | undefined>> = {};

    if (provider === 'google') {
      providersConfig.google = { apiKey: this.env.GOOGLE_API_KEY ?? this.env.GEMINI_API_KEY };
    } else if (provider === 'openai') {
      providersConfig.openai = { apiKey: this.env.OPENAI_API_KEY };
    } else if (provider === 'anthropic') {
      providersConfig.anthropic = { apiKey: this.env.ANTHROPIC_API_KEY };
    } else if (provider === 'ollama') {
      providersConfig.ollama = { baseUrl: this.env.OLLAMA_URL ?? 'http://localhost:11434' };
    }

    return new Cogitator({
      llm: {
        defaultModel: this.config.llm.model,
        providers: providersConfig as never,
      },
    });
  }

  private buildChannels(): Channel[] {
    const channels: Channel[] = [];

    if (this.config.channels.telegram) {
      const token = this.env.TG_TOKEN ?? this.env.TELEGRAM_TOKEN;
      if (token) {
        channels.push(telegramChannel({ token }));
      }
    }

    if (this.config.channels.discord) {
      const token = this.env.DISCORD_TOKEN;
      if (token) {
        channels.push(discordChannel({ token }));
      }
    }

    if (this.config.channels.slack) {
      const token = this.env.SLACK_BOT_TOKEN;
      const signingSecret = this.env.SLACK_SIGNING_SECRET;
      if (token && signingSecret) {
        channels.push(slackChannel({ token, signingSecret }));
      }
    }

    return channels;
  }

  private buildScheduler(): HeartbeatScheduler | null {
    return null;
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

    return instructions;
  }
}
