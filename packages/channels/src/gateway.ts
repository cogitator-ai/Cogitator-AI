import type {
  GatewayConfig,
  GatewayStats,
  Channel,
  ChannelMessage,
  ChannelUser,
  CompactionConfig,
  MiddlewareContext,
  GatewayMiddleware,
  StreamConfig,
  ImageInput,
  HookRegistry,
  Message,
  SessionManager as ISessionManager,
} from '@cogitator-ai/types';
import type { Agent, Cogitator } from '@cogitator-ai/core';
import { parseModel } from '@cogitator-ai/core';
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
  /**
   * Maximum duration of a single agent run in milliseconds.
   * Defaults to the agent's own `timeout` setting.
   */
  runTimeout?: number;
}

export interface GatewaySessionInfo {
  threadId: string;
  channelType: string;
  userId: string;
  userName?: string;
  messageCount: number;
  lastActiveAt: number;
  active: boolean;
}

type GatewaySessionManager = ISessionManager & {
  incrementMessageCount?(sessionId: string): Promise<void>;
};

const DEFAULT_SUMMARY_PROMPT =
  'Summarize the following conversation between a user and an assistant. ' +
  'Preserve facts, decisions, user preferences, open tasks and any commitments. ' +
  'Write a concise summary in the language of the conversation.';

const TYPING_INTERVAL_MS = 4000;

function messageText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((part) => (part.type === 'text' ? part.text : `[${part.type}]`))
    .join(' ');
}

function isScheduled(msg: ChannelMessage): boolean {
  const raw = msg.raw;
  return typeof raw === 'object' && raw !== null && 'scheduled' in raw && raw.scheduled === true;
}

function dayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export class Gateway {
  private readonly config: GatewayFullConfig;
  private readonly channels: Channel[];
  private readonly sessionManager: GatewaySessionManager | null;
  private readonly middlewares: GatewayMiddleware[];
  private readonly streamConfig: StreamConfig;
  private readonly debouncer: InboundDebouncer | null;
  private readonly messageQueue: MessageQueue | null;
  private readonly hooks: HookRegistry | null;
  private readonly lastMessageTime = new Map<string, number>();
  private readonly threads = new Map<string, Omit<GatewaySessionInfo, 'threadId' | 'active'>>();
  private readonly inFlight = new Map<string, number>();
  private running = false;
  private startedAt: number | null = null;
  private messageCount = 0;
  private messageCountDay = dayKey(Date.now());

  constructor(config: GatewayFullConfig) {
    this.config = config;
    this.channels = config.channels;
    this.middlewares = config.middleware ?? [];
    this.streamConfig = config.stream ?? { flushInterval: 500, minChunkSize: 20 };
    this.hooks = config.hooks ?? null;

    this.sessionManager =
      config.sessionManager ?? (config.memory ? new SessionManager(config.memory) : null);

    this.messageQueue =
      config.queueMode && config.queueMode !== 'parallel'
        ? new MessageQueue(config.queueMode, (msg, signal) => this.processMessage(msg, signal))
        : null;

    this.debouncer = config.debounce?.enabled
      ? new InboundDebouncer(config.debounce, (merged) => this.dispatch(merged))
      : null;

    for (const channel of this.channels) {
      channel.onMessage((msg) => this.handleIncoming(msg));
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();

    const results = await Promise.allSettled(this.channels.map((ch) => ch.start()));
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) {
      this.running = false;
      this.startedAt = null;
      await Promise.allSettled(this.channels.map((ch) => ch.stop()));
      throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason));
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.debouncer) await this.debouncer.flushAll();
    this.messageQueue?.dispose();

    await Promise.all(this.channels.map((ch) => ch.stop()));
    this.startedAt = null;
  }

  get stats(): GatewayStats {
    this.rollMessageCounter();
    return {
      uptime: this.startedAt ? Date.now() - this.startedAt : 0,
      activeSessions: this.inFlight.size,
      totalSessions: this.threads.size,
      messagesToday: this.messageCount,
      connectedChannels: this.channels.map((ch) => ch.type),
    };
  }

  getSessions(): GatewaySessionInfo[] {
    return [...this.threads.entries()]
      .map(([threadId, info]) => ({ threadId, ...info, active: this.inFlight.has(threadId) }))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  async injectMessage(msg: ChannelMessage): Promise<void> {
    return this.handleIncoming(msg);
  }

  /**
   * Summarize older messages of a conversation thread, keeping `keepRecent` messages intact.
   * Runs regardless of the configured message threshold.
   */
  async compactThread(threadId: string, agent?: Agent): Promise<string> {
    const compaction = this.config.session?.compaction;
    if (!this.config.memory || !compaction) {
      return 'Compaction is not configured';
    }

    const targetAgent = agent ?? (await this.resolveAgent({ id: 'system', channelType: 'system' }));
    const service = new CompactionService({
      adapter: this.config.memory,
      summarize: this.createSummarizeFn(targetAgent, compaction),
    });
    const result = await service.compact(threadId, { ...compaction, threshold: 0 });

    if (result.compactedMessages < result.originalMessages) {
      await this.hooks?.emit('session:compacted', { threadId, result });
      return `Compacted ${result.originalMessages} messages into ${result.compactedMessages}`;
    }
    return `Nothing to compact (${result.originalMessages} messages)`;
  }

  private async compactIfNeeded(threadId: string, agent: Agent): Promise<void> {
    const memory = this.config.memory;
    const compaction = this.config.session?.compaction;
    if (!memory || !compaction) return;

    const entries = await memory.getEntries({ threadId });
    if (!entries.success || entries.data.length < compaction.threshold) return;

    await this.compactThread(threadId, agent);
  }

  private async handleIncoming(msg: ChannelMessage): Promise<void> {
    if (this.debouncer) {
      this.debouncer.enqueue(msg);
      return;
    }
    await this.dispatch(msg);
  }

  private async dispatch(msg: ChannelMessage): Promise<void> {
    if (this.messageQueue) {
      this.messageQueue.push(msg, this.getThreadId(msg));
      return;
    }
    await this.processMessage(msg);
  }

  private rollMessageCounter(): void {
    const today = dayKey(Date.now());
    if (today !== this.messageCountDay) {
      this.messageCountDay = today;
      this.messageCount = 0;
    }
  }

  private async runMiddleware(msg: ChannelMessage, ctx: MiddlewareContext): Promise<boolean> {
    let reachedEnd = false;
    const runAll = async (index: number): Promise<void> => {
      if (index >= this.middlewares.length) {
        reachedEnd = true;
        return;
      }
      await this.middlewares[index].handle(msg, ctx, () => runAll(index + 1));
    };
    await runAll(0);
    return reachedEnd;
  }

  private async processMessage(msg: ChannelMessage, signal?: AbortSignal): Promise<void> {
    const channel = this.channels.find((ch) => ch.type === msg.channelType);
    if (!channel) return;

    const threadId = this.getThreadId(msg);
    this.inFlight.set(threadId, (this.inFlight.get(threadId) ?? 0) + 1);

    try {
      await this.processWithChannel(msg, channel, threadId, signal);
    } catch (error) {
      if (signal?.aborted) return;
      this.config.onError?.(error instanceof Error ? error : new Error(String(error)), msg);
    } finally {
      const remaining = (this.inFlight.get(threadId) ?? 1) - 1;
      if (remaining <= 0) this.inFlight.delete(threadId);
      else this.inFlight.set(threadId, remaining);
    }
  }

  private async processWithChannel(
    msg: ChannelMessage,
    channel: Channel,
    threadId: string,
    signal?: AbortSignal
  ): Promise<void> {
    const user: ChannelUser = {
      id: msg.userId,
      channelType: msg.channelType,
      name: msg.userName,
    };

    const ctx = this.createMiddlewareContext(threadId, user, channel);
    if (!(await this.runMiddleware(msg, ctx))) return;

    await this.handleAccepted(msg, channel, threadId, user, signal);
  }

  private async handleAccepted(
    originalMsg: ChannelMessage,
    channel: Channel,
    threadId: string,
    user: ChannelUser,
    signal?: AbortSignal
  ): Promise<void> {
    let msg = originalMsg;
    await this.hooks?.emit('message:received', { msg, threadId, user });

    this.rollMessageCounter();
    this.messageCount++;
    const known = this.threads.get(threadId);
    this.threads.set(threadId, {
      channelType: msg.channelType,
      userId: msg.userId,
      ...(msg.userName || known?.userName ? { userName: msg.userName ?? known?.userName } : {}),
      messageCount: (known?.messageCount ?? 0) + 1,
      lastActiveAt: Date.now(),
    });

    if (this.config.envelope?.enabled) {
      const prevTime = this.lastMessageTime.get(threadId);
      msg = { ...msg, text: formatEnvelope(msg, this.config.envelope, prevTime) };
      this.lastMessageTime.set(threadId, Date.now());
    }

    const agent = await this.resolveAgent(user);

    if (this.sessionManager) {
      const session = await this.sessionManager.getOrCreate({
        userId: msg.userId,
        channelType: msg.channelType,
        channelId: msg.channelId,
        agentId: agent.name,
      });
      if (session.messageCount === 0) {
        await this.hooks?.emit('session:created', { session, threadId });
      }
      await this.sessionManager.incrementMessageCount?.(session.id);
    }

    if (this.config.memory && this.config.session?.compaction) {
      try {
        await this.compactIfNeeded(threadId, agent);
      } catch (error) {
        this.config.onError?.(
          error instanceof Error ? error : new Error(String(error)),
          originalMsg
        );
      }
    }

    const tracker =
      this.config.reactions?.enabled && channel.setReaction
        ? new StatusReactionTracker(channel, msg.channelId, msg.id, this.config.reactions)
        : undefined;
    tracker?.setPhase('queued');

    const typingInterval = setInterval(() => {
      channel.sendTyping(msg.channelId).catch(() => {});
    }, TYPING_INTERVAL_MS);

    try {
      await channel.sendTyping(msg.channelId).catch(() => {});
      tracker?.setPhase('thinking');

      if (this.config.stream) {
        await this.runStreaming(agent, msg, channel, threadId, tracker, signal);
      } else {
        await this.runDirect(agent, msg, channel, threadId, tracker, signal);
      }

      tracker?.setPhase('done');
    } catch (error) {
      tracker?.setPhase('error');
      throw error;
    } finally {
      clearInterval(typingInterval);
      tracker?.dispose();
    }
  }

  private async extractMedia(
    msg: ChannelMessage,
    agent: Agent
  ): Promise<{ input: string; images?: ImageInput[] }> {
    let input = msg.text;
    let images: ImageInput[] | undefined;

    if (this.config.mediaProcessor && msg.attachments?.length) {
      const result = await this.config.mediaProcessor.process(
        msg.attachments,
        this.config.cogitator.resolveModel(agent)
      );

      if (result.images.length > 0) images = result.images;
      if (result.transcribedText) {
        input = result.transcribedText + (input ? `\n${input}` : '');
      }
      if (result.systemNotes.length > 0) {
        input = (input ? `${input}\n` : '') + result.systemNotes.join('\n');
      }
    }

    if (!input && !images?.length) {
      input = '[empty message]';
    }

    return { input, images };
  }

  private buildRunOptions(
    msg: ChannelMessage,
    threadId: string,
    input: string,
    images: ImageInput[] | undefined,
    tracker: StatusReactionTracker | undefined,
    signal: AbortSignal | undefined
  ) {
    return {
      input,
      threadId,
      threadAccess: 'shared' as const,
      useMemory: !!this.config.memory,
      userId: msg.userId,
      channelType: msg.channelType,
      channelId: msg.channelId,
      ...(images ? { images } : {}),
      ...(signal ? { signal } : {}),
      ...(this.config.runTimeout !== undefined ? { timeout: this.config.runTimeout } : {}),
      ...(tracker
        ? {
            onToolCall: () => tracker.setPhase('tool'),
            onToolResult: () => tracker.setPhase('thinking'),
          }
        : {}),
    };
  }

  private async sendChunked(
    channel: Channel,
    msg: ChannelMessage,
    output: string,
    replyTo: string | undefined
  ): Promise<string> {
    const chunks = chunkMessage(output, getPlatformLimit(msg.channelType));
    let sentId = '';
    for (let i = 0; i < chunks.length; i++) {
      const id = await channel.sendText(msg.channelId, chunks[i], {
        ...(i === 0 && replyTo ? { replyTo } : {}),
        format: 'markdown',
      });
      if (i === 0) sentId = id;
    }
    return sentId;
  }

  private async runDirect(
    agent: Agent,
    msg: ChannelMessage,
    channel: Channel,
    threadId: string,
    tracker: StatusReactionTracker | undefined,
    signal: AbortSignal | undefined
  ): Promise<void> {
    const { input, images } = await this.extractMedia(msg, agent);
    const replyTo = isScheduled(msg) ? undefined : msg.id;

    await this.hooks?.emit('agent:before_run', { msg, threadId, agent: agent.name });

    let result;
    try {
      result = await this.config.cogitator.run(
        agent,
        this.buildRunOptions(msg, threadId, input, images, tracker, signal)
      );
    } catch (error) {
      await this.hooks?.emit('agent:error', { msg, threadId, error });
      throw error;
    }

    await this.hooks?.emit('agent:after_run', { msg, threadId, output: result.output });
    if (signal?.aborted) return;

    const output = adaptMarkdown(result.output, msg.channelType);
    if (!output) return;

    await this.hooks?.emit('message:sending', {
      msg,
      threadId,
      text: output,
      channelId: msg.channelId,
    });

    const sentId = await this.sendChunked(channel, msg, output, replyTo);

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
    threadId: string,
    tracker: StatusReactionTracker | undefined,
    signal: AbortSignal | undefined
  ): Promise<void> {
    const { input, images } = await this.extractMedia(msg, agent);
    const replyTo = isScheduled(msg) ? undefined : msg.id;
    const streamCfg = {
      ...this.streamConfig,
      maxMessageChars: this.streamConfig.maxMessageChars ?? getPlatformLimit(msg.channelType),
    };
    const stream = new StreamBuffer(
      channel,
      msg.channelId,
      streamCfg,
      replyTo,
      !!channel.sendDraft,
      (text) => adaptMarkdown(text, msg.channelType)
    );
    stream.start();

    await this.hooks?.emit('agent:before_run', { msg, threadId, agent: agent.name });
    await this.hooks?.emit('stream:started', { msg, threadId });

    let tokenCount = 0;
    let result;
    try {
      result = await this.config.cogitator.run(agent, {
        ...this.buildRunOptions(msg, threadId, input, images, tracker, signal),
        stream: true,
        onToken: (token: string) => {
          tokenCount++;
          stream.append(token);
        },
      });
    } catch (error) {
      await stream.abort();
      await this.hooks?.emit('agent:error', { msg, threadId, error });
      throw error;
    }

    if (signal?.aborted) {
      await stream.abort();
      return;
    }

    if (tokenCount > 0) {
      await stream.finish();
    } else {
      await stream.abort();
      const output = adaptMarkdown(result.output, msg.channelType);
      if (output) await this.sendChunked(channel, msg, output, replyTo);
    }

    await this.hooks?.emit('agent:after_run', { msg, threadId, output: result.output });
    await this.hooks?.emit('stream:finished', {
      msg,
      threadId,
      messageIds: stream.getMessageIds(),
    });
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
      return (await agentOrFactory(user)) as Agent;
    }
    return agentOrFactory as Agent;
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

  private createSummarizeFn(agent: Agent, compaction: CompactionConfig): SummarizeFn {
    const modelId = compaction.summaryModel ?? this.config.cogitator.resolveModel(agent);
    const explicitProvider = compaction.summaryModel ? undefined : agent.config?.provider;
    const prompt = compaction.summaryPrompt ?? DEFAULT_SUMMARY_PROMPT;

    return async (messages) => {
      const backend = this.config.cogitator.getLLMBackend(modelId, explicitProvider);
      const model = explicitProvider ? modelId : parseModel(modelId).model;
      const transcript = messages.map((m) => `${m.role}: ${messageText(m)}`).join('\n');
      const response = await backend.chat({
        model,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: transcript },
        ],
      });
      const summary = response.content.trim();
      if (!summary) throw new Error('Summarization model returned an empty summary');
      return summary;
    };
  }
}
