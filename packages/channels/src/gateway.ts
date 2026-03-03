import type {
  GatewayConfig,
  GatewayStats,
  Channel,
  ChannelMessage,
  ChannelUser,
  MiddlewareContext,
  GatewayMiddleware,
  StreamConfig,
  ImageInput,
  HookRegistry,
} from '@cogitator-ai/types';
import type { Agent } from '@cogitator-ai/core';
import type { Cogitator } from '@cogitator-ai/core';
import { SessionManager, CompactionService } from '@cogitator-ai/memory';
import type { SummarizeFn } from '@cogitator-ai/memory';
import { StreamBuffer } from './stream-buffer';
import { adaptMarkdown, chunkMessage, getPlatformLimit } from './formatters/markdown';
import type { MediaProcessor } from './media/media-processor';
import { StatusReactionTracker } from './status-reactions';
import { InboundDebouncer } from './inbound-debounce';
import { formatEnvelope } from './envelope';
import { MessageQueue } from './message-queue';

export interface GatewayFullConfig extends GatewayConfig {
  cogitator: Cogitator;
  mediaProcessor?: MediaProcessor;
}

export class Gateway {
  private readonly config: GatewayFullConfig;
  private readonly channels: Channel[];
  private readonly sessionManager: SessionManager | null;
  private readonly compactionService: CompactionService | null;
  private readonly middlewares: GatewayMiddleware[];
  private readonly streamConfig: StreamConfig;
  private readonly debouncer: InboundDebouncer | null;
  private readonly messageQueue: MessageQueue | null;
  private readonly hooks: HookRegistry | null;
  private readonly lastMessageTime = new Map<string, number>();
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

    this.hooks = config.hooks ?? null;

    this.debouncer = config.debounce?.enabled
      ? new InboundDebouncer(config.debounce, (merged) => this.processMessage(merged))
      : null;

    this.messageQueue =
      config.queueMode && config.queueMode !== 'parallel'
        ? new MessageQueue(config.queueMode, (msg) => this.processMessage(msg))
        : null;

    for (const channel of this.channels) {
      channel.onMessage((msg) => this.handleIncoming(msg));
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

    if (this.debouncer) await this.debouncer.flushAll();
    this.messageQueue?.dispose();

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
    return this.handleIncoming(msg);
  }

  private async handleIncoming(msg: ChannelMessage): Promise<void> {
    if (this.debouncer) {
      this.debouncer.enqueue(msg);
    } else if (this.messageQueue) {
      const threadId = this.getThreadId(msg);
      this.messageQueue.push(msg, threadId);
    } else {
      await this.processMessage(msg);
    }
  }

  private async processMessage(msg: ChannelMessage): Promise<void> {
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

      await this.hooks?.emit('message:received', { msg, threadId, user });

      this.messageCount++;

      if (this.config.envelope?.enabled) {
        const prevTime = this.lastMessageTime.get(threadId);
        msg = { ...msg, text: formatEnvelope(msg, this.config.envelope, prevTime) };
        this.lastMessageTime.set(threadId, Date.now());
      }

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

      const reactionsEnabled = this.config.reactions?.enabled && channel.setReaction;
      let tracker: StatusReactionTracker | undefined;

      if (reactionsEnabled) {
        tracker = new StatusReactionTracker(channel, msg.channelId, msg.id, this.config.reactions);
        tracker.setPhase('queued');
      }

      await channel.sendTyping(msg.channelId);
      const typingInterval = setInterval(() => {
        channel.sendTyping(msg.channelId).catch(() => {});
      }, 4000);

      try {
        tracker?.setPhase('thinking');

        if (this.config.stream) {
          await this.runStreaming(agent, msg, channel, threadId);
        } else {
          await this.runDirect(agent, msg, channel, threadId);
        }

        tracker?.setPhase('done');
      } catch (error) {
        tracker?.setPhase('error');
        throw error;
      } finally {
        clearInterval(typingInterval);
        tracker?.dispose();
      }
    } catch (error) {
      if (this.config.onError) {
        this.config.onError(error instanceof Error ? error : new Error(String(error)), msg);
      }
    }
  }

  private async extractMedia(
    msg: ChannelMessage,
    agent: Agent
  ): Promise<{ input: string; images?: ImageInput[] }> {
    let input = msg.text;
    let images: ImageInput[] | undefined;

    if (this.config.mediaProcessor && msg.attachments?.length) {
      console.log(
        `[gateway] Processing ${msg.attachments.length} attachment(s), types: ${msg.attachments.map((a) => a.type).join(', ')}`
      );
      const result = await this.config.mediaProcessor.process(msg.attachments, agent.model);
      console.log(
        `[gateway] Media result: images=${result.images.length}, text=${!!result.transcribedText}, notes=${result.systemNotes.length}`
      );

      if (result.images.length > 0) images = result.images;
      if (result.transcribedText) {
        input = result.transcribedText + (input ? `\n${input}` : '');
      }
      if (result.systemNotes.length > 0) {
        input = (input || '') + '\n' + result.systemNotes.join('\n');
      }
    }

    if (!input && !images?.length) {
      input = '[empty message]';
    }

    return { input, images };
  }

  private async runDirect(
    agent: Agent,
    msg: ChannelMessage,
    channel: Channel,
    threadId: string
  ): Promise<void> {
    const { input, images } = await this.extractMedia(msg, agent);
    const replyTo = (msg.raw as Record<string, unknown>)?.scheduled ? undefined : msg.id;

    await this.hooks?.emit('agent:before_run', { msg, threadId, agent: agent.name });

    let result;
    try {
      result = await this.config.cogitator.run(agent, {
        input,
        threadId,
        useMemory: !!this.config.memory,
        userId: msg.userId,
        channelType: msg.channelType,
        channelId: msg.channelId,
        ...(images ? { images } : {}),
      });
    } catch (error) {
      await this.hooks?.emit('agent:error', { msg, threadId, error });
      throw error;
    }

    await this.hooks?.emit('agent:after_run', { msg, threadId, output: result.output });

    const output = adaptMarkdown(result.output, msg.channelType);

    await this.hooks?.emit('message:sending', {
      msg,
      threadId,
      text: output,
      channelId: msg.channelId,
    });

    const limit = getPlatformLimit(msg.channelType);
    const chunks = chunkMessage(output, limit);
    let sentId = '';

    for (let i = 0; i < chunks.length; i++) {
      sentId = await channel.sendText(msg.channelId, chunks[i], {
        ...(i === 0 && replyTo ? { replyTo } : {}),
        format: 'markdown',
      });
    }

    await this.hooks?.emit('message:sent', {
      msg,
      threadId,
      text: output,
      messageId: sentId,
    });
  }

  private async runStreaming(
    agent: Agent,
    msg: ChannelMessage,
    channel: Channel,
    threadId: string
  ): Promise<void> {
    const { input, images } = await this.extractMedia(msg, agent);
    console.log(
      `[gateway] Running LLM, input: "${input.slice(0, 200)}", images: ${images?.length ?? 0}`
    );
    const replyTo = (msg.raw as Record<string, unknown>)?.scheduled ? undefined : msg.id;
    const useDraft = !!channel.sendDraft;
    const streamCfg = {
      ...this.streamConfig,
      maxMessageChars: this.streamConfig.maxMessageChars ?? getPlatformLimit(msg.channelType),
    };
    const stream = new StreamBuffer(channel, msg.channelId, streamCfg, replyTo, useDraft);
    stream.start();

    await this.hooks?.emit('agent:before_run', { msg, threadId, agent: agent.name });
    await this.hooks?.emit('stream:started', { msg, threadId });

    try {
      let tokenCount = 0;

      const runPromise = this.config.cogitator.run(agent, {
        input,
        threadId,
        useMemory: !!this.config.memory,
        userId: msg.userId,
        channelType: msg.channelType,
        channelId: msg.channelId,
        stream: true,
        onToken: (token) => {
          tokenCount++;
          stream.append(token);
        },
        ...(images ? { images } : {}),
      });

      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('LLM response timeout (90s)')), 90_000)
      );

      const result = await Promise.race([runPromise, timeout]);

      if (tokenCount > 0) {
        await stream.finish();
      } else {
        await stream.abort();
        if (result.output) {
          const output = adaptMarkdown(result.output, msg.channelType);
          const limit = getPlatformLimit(msg.channelType);
          const chunks = chunkMessage(output, limit);
          for (let i = 0; i < chunks.length; i++) {
            await channel.sendText(msg.channelId, chunks[i], {
              ...(i === 0 && replyTo ? { replyTo } : {}),
              format: 'markdown',
            });
          }
        }
      }

      await this.hooks?.emit('agent:after_run', { msg, threadId, output: result.output });
      await this.hooks?.emit('stream:finished', {
        msg,
        threadId,
        messageIds: stream.getMessageIds(),
      });
    } catch (error) {
      console.error('[gateway] LLM run error:', (error as Error).message);
      await stream.abort();
      await this.hooks?.emit('agent:error', { msg, threadId, error });
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
