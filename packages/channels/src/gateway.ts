import type {
  GatewayConfig,
  GatewayStats,
  Channel,
  ChannelMessage,
  ChannelUser,
  MiddlewareContext,
  GatewayMiddleware,
  StreamConfig,
} from '@cogitator-ai/types';
import type { Agent } from '@cogitator-ai/core';
import type { Cogitator } from '@cogitator-ai/core';
import { SessionManager, CompactionService } from '@cogitator-ai/memory';
import type { SummarizeFn } from '@cogitator-ai/memory';
import { StreamBuffer } from './stream-buffer';

export interface GatewayFullConfig extends GatewayConfig {
  cogitator: Cogitator;
}

export class Gateway {
  private readonly config: GatewayFullConfig;
  private readonly channels: Channel[];
  private readonly sessionManager: SessionManager | null;
  private readonly compactionService: CompactionService | null;
  private readonly middlewares: GatewayMiddleware[];
  private readonly streamConfig: StreamConfig;
  private running = false;
  private startedAt: number | null = null;
  private messageCount = 0;

  constructor(config: GatewayFullConfig) {
    this.config = config;
    this.channels = config.channels;
    this.middlewares = config.middleware ?? [];
    this.streamConfig = config.stream ?? { flushInterval: 500, minChunkSize: 20 };

    if (config.memory) {
      this.sessionManager = config.sessionManager ? null : new SessionManager(config.memory);
      this.compactionService = config.session?.compaction
        ? new CompactionService({
            adapter: config.memory,
            summarize: this.createSummarizeFn(),
          })
        : null;
    } else {
      this.sessionManager = null;
      this.compactionService = null;
    }

    for (const channel of this.channels) {
      channel.onMessage((msg) => this.handleMessage(msg));
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();

    await Promise.all(this.channels.map((ch) => ch.start()));
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    await Promise.all(this.channels.map((ch) => ch.stop()));
  }

  get stats(): GatewayStats {
    return {
      uptime: this.startedAt ? Date.now() - this.startedAt : 0,
      activeSessions: 0,
      totalSessions: 0,
      messagesToday: this.messageCount,
      connectedChannels: this.channels.map((ch) => ch.type),
    };
  }

  async injectMessage(msg: ChannelMessage): Promise<void> {
    return this.handleMessage(msg);
  }

  private async handleMessage(msg: ChannelMessage): Promise<void> {
    try {
      const channel = this.channels.find((ch) => ch.type === msg.channelType);
      if (!channel) return;

      const user: ChannelUser = {
        id: msg.userId,
        channelType: msg.channelType,
        name: msg.userName,
      };

      const threadId = this.getThreadId(msg);
      const ctx = this.createMiddlewareContext(threadId, user, channel);

      let middlewarePassed = true;
      if (this.middlewares.length > 0) {
        let nextCalled = false;
        const runAll = async (index: number): Promise<void> => {
          if (index >= this.middlewares.length) {
            nextCalled = true;
            return;
          }
          await this.middlewares[index].handle(msg, ctx, () => runAll(index + 1));
        };
        await runAll(0);
        middlewarePassed = nextCalled;
      }

      if (!middlewarePassed) return;

      this.messageCount++;

      if (this.sessionManager) {
        const session = await this.sessionManager.getOrCreate({
          userId: msg.userId,
          channelType: msg.channelType,
          channelId: msg.channelId,
          agentId: this.getAgentName(),
        });

        await this.sessionManager.incrementMessageCount(session.id);

        if (this.compactionService && this.config.session?.compaction) {
          const compaction = this.config.session.compaction;
          if (session.messageCount >= compaction.threshold) {
            await this.compactionService.compact(session.id, compaction);
          }
        }
      }

      const agent = await this.resolveAgent(user);

      await channel.sendTyping(msg.channelId);

      if (this.config.stream) {
        await this.runStreaming(agent, msg, channel, threadId);
      } else {
        await this.runDirect(agent, msg, channel, threadId);
      }
    } catch (error) {
      if (this.config.onError) {
        this.config.onError(error instanceof Error ? error : new Error(String(error)), msg);
      }
    }
  }

  private async runDirect(
    agent: Agent,
    msg: ChannelMessage,
    channel: Channel,
    threadId: string
  ): Promise<void> {
    const result = await this.config.cogitator.run(agent, {
      input: msg.text,
      threadId,
      useMemory: !!this.config.memory,
    });

    await channel.sendText(msg.channelId, result.output, {
      replyTo: msg.id,
      format: 'markdown',
    });
  }

  private async runStreaming(
    agent: Agent,
    msg: ChannelMessage,
    channel: Channel,
    threadId: string
  ): Promise<void> {
    const stream = new StreamBuffer(channel, msg.channelId, this.streamConfig, msg.id);
    stream.start();

    try {
      await this.config.cogitator.run(agent, {
        input: msg.text,
        threadId,
        useMemory: !!this.config.memory,
        stream: true,
        onToken: (token) => stream.append(token),
      });

      await stream.finish();
    } catch (error) {
      stream.abort();
      throw error;
    }
  }

  private getThreadId(msg: ChannelMessage): string {
    if (this.config.session?.threadKey) {
      return this.config.session.threadKey(msg);
    }
    return `${msg.channelType}:${msg.userId}`;
  }

  private async resolveAgent(user: ChannelUser): Promise<Agent> {
    const agentOrFactory = this.config.agent;
    if (typeof agentOrFactory === 'function') {
      return agentOrFactory(user) as Promise<Agent>;
    }
    return agentOrFactory as Agent;
  }

  private getAgentName(): string {
    const agentOrFactory = this.config.agent;
    if (typeof agentOrFactory === 'function') {
      return 'dynamic';
    }
    return (agentOrFactory as Agent).name;
  }

  private createMiddlewareContext(
    threadId: string,
    user: ChannelUser,
    channel: Channel
  ): MiddlewareContext {
    const store = new Map<string, unknown>();
    return {
      threadId,
      user,
      channel,
      set(key: string, value: unknown) {
        store.set(key, value);
      },
      get<T>(key: string): T | undefined {
        return store.get(key) as T | undefined;
      },
    };
  }

  private createSummarizeFn(): SummarizeFn {
    return async (messages) => {
      const text = messages
        .map(
          (m) =>
            `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`
        )
        .join('\n');
      return `[Summary of ${messages.length} messages]: ${text.slice(0, 500)}`;
    };
  }
}
