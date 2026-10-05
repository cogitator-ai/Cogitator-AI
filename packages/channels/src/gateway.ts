import type {
  GatewayConfig,
  GatewayStats,
  Channel,
  ChannelAction,
  ChannelButton,
  ChannelMessage,
  ChannelUser,
  CompactionConfig,
  MiddlewareContext,
  GatewayMiddleware,
  HookRegistry,
  StreamConfig,
  ImageInput,
  Message,
  RunOptions,
  RunResult,
  SessionManager as ISessionManager,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from '@cogitator-ai/types';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
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
import {
  DEFAULT_APPROVE_WORDS,
  DEFAULT_DENY_WORDS,
  DEFAULT_NOT_ALLOWED_MESSAGE,
  DEFAULT_EXPIRED_MESSAGE,
  APPROVE_ACTION,
  DENY_ACTION,
  formatApprovalPrompt,
  parseApprovalReply,
} from './approvals';
import type {
  ApprovalReplyWords,
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
  GatewayApprovalsConfig,
} from './approvals';

export interface GatewayFullConfig extends GatewayConfig {
  cogitator: Cogitator;
  mediaProcessor?: MediaProcessor;
  /**
   * Maximum duration of a single agent run in milliseconds.
   * Defaults to the agent's own `timeout` setting.
   */
  runTimeout?: number;
  hooks?: HookRegistry;
  /**
   * How runs paused for tool approval are put to the chat and answered.
   * A paused run sends a prompt listing the waiting calls; the user who
   * started the run replies with an approve or deny word to continue it.
   */
  approvals?: GatewayApprovalsConfig;
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

interface PausedThread {
  userId: string;
  approvals: readonly ToolApprovalRequest[];
}

/** Markdown as the channel takes it: as written when it renders Markdown itself. */
function adaptFor(channel: Channel, msg: ChannelMessage, text: string): string {
  return channel.nativeMarkdown ? text : adaptMarkdown(text, msg.channelType);
}

/** The longest message the channel sends as one. */
function limitFor(channel: Channel, msg: ChannelMessage): number {
  return channel.maxMessageChars ?? getPlatformLimit(msg.channelType);
}

function draftKey(channelType: string, channelId: string, draftId: number): string {
  return `${channelType}:${channelId}:${draftId}`;
}

function promptKey(channelType: string, channelId: string, messageId: string): string {
  return `${channelType}:${channelId}:${messageId}`;
}

/** An approval prompt with buttons: whose paused run it answers, and where it was sent. */
interface ApprovalPrompt {
  threadId: string;
  userId: string;
  channel: Channel;
  channelId: string;
  messageId: string;
}

type RunInvocation = (extra: Pick<RunOptions, 'stream' | 'onToken'>) => Promise<RunResult>;

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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isResumeRejection(error: unknown): boolean {
  return (
    CogitatorError.isCogitatorError(error) &&
    (error.code === ErrorCode.RUN_NOT_PAUSED || error.code === ErrorCode.THREAD_ACCESS_DENIED)
  );
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
  private readonly approvalWords: ApprovalReplyWords;
  private readonly pausedThreads = new Map<string, PausedThread>();
  /** The stop of each run, by the signal the run was given */
  private readonly stops = new WeakMap<AbortSignal, AbortController>();
  /** The stop of each run streaming into a draft with a stop button, by channel, chat and draft */
  private readonly stoppableDrafts = new Map<string, AbortController>();
  /** Approval prompts with buttons, by channel, chat and message: whose paused run each answers */
  private readonly approvalPrompts = new Map<string, ApprovalPrompt>();
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
    this.approvalWords = {
      approveWords: config.approvals?.approveWords ?? DEFAULT_APPROVE_WORDS,
      denyWords: config.approvals?.denyWords ?? DEFAULT_DENY_WORDS,
    };

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
      channel.onAction?.((action) => this.handleAction(channel, action));
      channel.onStop?.((stop) => {
        this.stoppableDrafts
          .get(draftKey(stop.channelType, stop.channelId, stop.draftId))
          ?.abort(new Error('Stopped by the user'));
      });
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

  /**
   * A button press. The gateway's own Approve and Deny buttons answer a paused run as the reply
   * words do, through the same middleware and checks; every other press goes to the
   * `action:received` hook.
   */
  private async handleAction(channel: Channel, action: ChannelAction): Promise<void> {
    let answered = false;
    const answer = async (options?: { text?: string; alert?: boolean }) => {
      if (answered) return;
      answered = true;
      await channel.answerAction?.(action.id, options);
    };

    try {
      if (action.data === APPROVE_ACTION || action.data === DENY_ACTION) {
        await this.answerApprovalButton(channel, action, answer);
        return;
      }
      await this.hooks?.emit('action:received', { action, answer });
    } finally {
      await answer().catch(() => {});
    }
  }

  private async answerApprovalButton(
    channel: Channel,
    action: ChannelAction,
    answer: (options?: { text?: string; alert?: boolean }) => Promise<void>
  ): Promise<void> {
    const approve = action.data === APPROVE_ACTION;
    const msg: ChannelMessage = {
      id: action.messageId ?? action.id,
      channelType: action.channelType,
      channelId: action.channelId,
      userId: action.userId,
      ...(action.userName ? { userName: action.userName } : {}),
      ...(action.channelId.startsWith('-') ? { groupId: action.channelId } : {}),
      ...(action.topicId ? { topicId: action.topicId } : {}),
      text: (approve ? this.approvalWords.approveWords : this.approvalWords.denyWords)[0] ?? '',
      raw: action.raw,
    };
    const key = action.messageId
      ? promptKey(action.channelType, action.channelId, action.messageId)
      : undefined;
    const prompt = key ? this.approvalPrompts.get(key) : undefined;

    if (!prompt || !this.pausedThreads.has(prompt.threadId)) {
      if (key) this.approvalPrompts.delete(key);
      if (action.messageId) {
        await channel.editButtons?.(action.channelId, action.messageId, null).catch(() => {});
      }
      await answer({
        text: this.config.approvals?.expiredMessage ?? DEFAULT_EXPIRED_MESSAGE,
        alert: true,
      });
      return;
    }
    if (prompt.userId !== action.userId || this.getThreadId(msg) !== prompt.threadId) {
      await answer({
        text: this.config.approvals?.notAllowedMessage ?? DEFAULT_NOT_ALLOWED_MESSAGE,
        alert: true,
      });
      return;
    }

    await answer();
    await this.closePrompts(prompt.threadId, approve);
    await this.handleIncoming(msg);
  }

  /**
   * Retires the buttons of a thread's approval prompts once it is answered: they show the
   * decision, or go away when the request was dropped.
   */
  private async closePrompts(threadId: string, approved: boolean | null): Promise<void> {
    const labels = this.config.approvals?.buttonLabels;
    for (const [key, prompt] of this.approvalPrompts) {
      if (prompt.threadId !== threadId) continue;
      this.approvalPrompts.delete(key);
      const buttons =
        approved === null
          ? null
          : [
              [
                approved
                  ? {
                      text: labels?.approved ?? 'Approved',
                      disabled: true,
                      style: 'success' as const,
                    }
                  : { text: labels?.denied ?? 'Denied', disabled: true, style: 'danger' as const },
              ],
            ];
      await prompt.channel
        .editButtons?.(prompt.channelId, prompt.messageId, buttons)
        .catch(() => {});
    }
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

    const stop = new AbortController();
    const runSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
    this.stops.set(runSignal, stop);

    try {
      await this.processWithChannel(msg, channel, threadId, runSignal);
    } catch (error) {
      if (runSignal.aborted) return;
      this.config.onError?.(toError(error), msg);
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
    msg: ChannelMessage,
    channel: Channel,
    threadId: string,
    user: ChannelUser,
    signal?: AbortSignal
  ): Promise<void> {
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

    const decision = this.readApprovalReply(msg, threadId, known !== undefined);

    if (!decision && this.config.memory && this.config.session?.compaction) {
      try {
        await this.compactIfNeeded(threadId, agent);
      } catch (error) {
        this.config.onError?.(toError(error), msg);
      }
    }

    const tracker =
      this.config.reactions?.enabled && channel.setReaction
        ? new StatusReactionTracker(channel, msg.channelId, msg.id, this.config.reactions)
        : undefined;
    tracker?.setPhase('queued');

    const typing = () =>
      msg.topicId
        ? channel.sendTyping(msg.channelId, { topicId: msg.topicId })
        : channel.sendTyping(msg.channelId);
    const typingInterval = setInterval(() => {
      typing().catch(() => {});
    }, TYPING_INTERVAL_MS);

    try {
      await typing().catch(() => {});
      tracker?.setPhase('thinking');

      const resumed =
        decision !== null &&
        (await this.resumeWithReply(agent, msg, channel, threadId, decision, tracker, signal));
      if (!resumed) {
        await this.runMessage(agent, msg, channel, threadId, tracker, signal);
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

  /**
   * An approve/deny reply is worth a resume when this thread paused in this
   * process, or when the gateway has not seen the thread since it started:
   * the pause then lives only in the runtime's checkpoint store.
   */
  private readApprovalReply(
    msg: ChannelMessage,
    threadId: string,
    seenBefore: boolean
  ): ToolApprovalDecision | null {
    if (isScheduled(msg) || msg.attachments?.length) return null;
    if (seenBefore && !this.pausedThreads.has(threadId)) return null;
    return parseApprovalReply(msg.text, this.approvalWords);
  }

  private async runMessage(
    agent: Agent,
    originalMsg: ChannelMessage,
    channel: Channel,
    threadId: string,
    tracker: StatusReactionTracker | undefined,
    signal: AbortSignal | undefined
  ): Promise<void> {
    await this.supersedePause(originalMsg, threadId);

    let msg = originalMsg;
    if (this.config.envelope?.enabled) {
      const prevTime = this.lastMessageTime.get(threadId);
      msg = { ...msg, text: formatEnvelope(msg, this.config.envelope, prevTime) };
      this.lastMessageTime.set(threadId, Date.now());
    }

    const { input, images } = await this.extractMedia(msg, agent);
    const options: RunOptions = {
      ...this.buildRunOptions(msg, tracker, signal),
      input,
      threadId,
      threadAccess: 'shared',
      ...(images ? { images } : {}),
    };

    await this.deliver(agent, msg, channel, threadId, signal, (extra) =>
      this.config.cogitator.run(agent, { ...options, ...extra })
    );
  }

  private async resumeWithReply(
    agent: Agent,
    msg: ChannelMessage,
    channel: Channel,
    threadId: string,
    decision: ToolApprovalDecision,
    tracker: StatusReactionTracker | undefined,
    signal: AbortSignal | undefined
  ): Promise<boolean> {
    const approvals = this.pausedThreads.get(threadId)?.approvals;
    const options = { ...this.buildRunOptions(msg, tracker, signal), defaultDecision: decision };

    try {
      await this.deliver(agent, msg, channel, threadId, signal, async (extra) => {
        const result = await this.config.cogitator.resume(agent, threadId, {
          ...options,
          ...extra,
        });
        this.pausedThreads.delete(threadId);
        await this.closePrompts(threadId, decision.approved);
        const event: ApprovalResolvedEvent = {
          msg,
          threadId,
          userId: msg.userId,
          decision,
          ...(approvals ? { approvals } : {}),
          superseded: false,
        };
        await this.hooks?.emit('approval:resolved', event);
        return result;
      });
      return true;
    } catch (error) {
      if (!CogitatorError.isCogitatorError(error)) throw error;
      if (error.code === ErrorCode.RUN_NOT_PAUSED) {
        this.pausedThreads.delete(threadId);
        await this.closePrompts(threadId, null);
        return false;
      }
      if (error.code === ErrorCode.THREAD_ACCESS_DENIED) {
        const text = this.config.approvals?.notAllowedMessage ?? DEFAULT_NOT_ALLOWED_MESSAGE;
        await this.sendReply(channel, msg, threadId, adaptFor(channel, msg, text), msg.id);
        return true;
      }
      throw error;
    }
  }

  private async supersedePause(msg: ChannelMessage, threadId: string): Promise<void> {
    const paused = this.pausedThreads.get(threadId);
    if (!paused) return;
    this.pausedThreads.delete(threadId);
    await this.closePrompts(threadId, null);
    const event: ApprovalResolvedEvent = {
      msg,
      threadId,
      userId: paused.userId,
      decision: { approved: false, reason: 'The user moved on without answering' },
      approvals: paused.approvals,
      superseded: true,
    };
    await this.hooks?.emit('approval:resolved', event);
  }

  private async requestApprovals(
    result: RunResult,
    msg: ChannelMessage,
    channel: Channel,
    threadId: string,
    replyTo: string | undefined
  ): Promise<void> {
    const approvals = result.status === 'paused' ? (result.pendingApprovals ?? []) : [];
    if (approvals.length === 0) return;

    this.pausedThreads.set(threadId, { userId: msg.userId, approvals });
    const event: ApprovalRequestedEvent = { msg, threadId, userId: msg.userId, approvals };
    await this.hooks?.emit('approval:requested', event);

    const format = this.config.approvals?.format ?? formatApprovalPrompt;
    const prompt = adaptFor(channel, msg, format(approvals, this.approvalWords));
    const labels = this.config.approvals?.buttonLabels;
    const buttons =
      channel.onAction && this.config.approvals?.buttons !== false
        ? [
            [
              {
                text: labels?.approve ?? 'Approve',
                data: APPROVE_ACTION,
                style: 'success' as const,
              },
              { text: labels?.deny ?? 'Deny', data: DENY_ACTION, style: 'danger' as const },
            ],
          ]
        : undefined;
    if (!prompt) return;
    const ids = await this.sendReply(channel, msg, threadId, prompt, replyTo, buttons);
    const last = ids[ids.length - 1];
    if (buttons && last) {
      this.approvalPrompts.set(promptKey(channel.type, msg.channelId, last), {
        threadId,
        userId: msg.userId,
        channel,
        channelId: msg.channelId,
        messageId: last,
      });
    }
  }

  private async deliver(
    agent: Agent,
    msg: ChannelMessage,
    channel: Channel,
    threadId: string,
    signal: AbortSignal | undefined,
    invoke: RunInvocation
  ): Promise<void> {
    if (this.config.stream) {
      await this.runStreaming(agent, msg, channel, threadId, signal, invoke);
    } else {
      await this.runDirect(agent, msg, channel, threadId, signal, invoke);
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
    tracker: StatusReactionTracker | undefined,
    signal: AbortSignal | undefined
  ) {
    return {
      useMemory: !!this.config.memory,
      userId: msg.userId,
      channelType: msg.channelType,
      channelId: msg.channelId,
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
    replyTo: string | undefined,
    buttons?: ChannelButton[][]
  ): Promise<string[]> {
    const chunks = chunkMessage(output, limitFor(channel, msg));
    const ids: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      ids.push(
        await channel.sendText(msg.channelId, chunks[i], {
          ...(i === 0 && replyTo ? { replyTo } : {}),
          ...(i === chunks.length - 1 && buttons ? { buttons } : {}),
          ...(msg.topicId ? { topicId: msg.topicId } : {}),
          format: 'markdown',
        })
      );
    }
    return ids;
  }

  private async sendReply(
    channel: Channel,
    msg: ChannelMessage,
    threadId: string,
    text: string,
    replyTo: string | undefined,
    buttons?: ChannelButton[][]
  ): Promise<string[]> {
    await this.hooks?.emit('message:sending', {
      msg,
      threadId,
      text,
      channelId: msg.channelId,
    });

    const ids = await this.sendChunked(channel, msg, text, replyTo, buttons);

    await this.hooks?.emit('message:sent', {
      msg,
      threadId,
      text,
      messageId: ids[0] ?? '',
    });
    return ids;
  }

  private async runDirect(
    agent: Agent,
    msg: ChannelMessage,
    channel: Channel,
    threadId: string,
    signal: AbortSignal | undefined,
    invoke: RunInvocation
  ): Promise<void> {
    const replyTo = isScheduled(msg) ? undefined : msg.id;

    await this.hooks?.emit('agent:before_run', { msg, threadId, agent: agent.name });

    let result: RunResult;
    try {
      result = await invoke({});
    } catch (error) {
      if (!isResumeRejection(error)) {
        await this.hooks?.emit('agent:error', { msg, threadId, error: toError(error) });
      }
      throw error;
    }

    await this.hooks?.emit('agent:after_run', { msg, threadId, output: result.output });
    if (signal?.aborted) return;

    const output = adaptFor(channel, msg, result.output);
    if (output) await this.sendReply(channel, msg, threadId, output, replyTo);

    await this.requestApprovals(result, msg, channel, threadId, output ? undefined : replyTo);
  }

  private async runStreaming(
    agent: Agent,
    msg: ChannelMessage,
    channel: Channel,
    threadId: string,
    signal: AbortSignal | undefined,
    invoke: RunInvocation
  ): Promise<void> {
    const replyTo = isScheduled(msg) ? undefined : msg.id;
    const streamCfg = {
      ...this.streamConfig,
      maxMessageChars: this.streamConfig.maxMessageChars ?? limitFor(channel, msg),
    };
    const stop = signal ? this.stops.get(signal) : undefined;
    const stream = new StreamBuffer(
      channel,
      msg.channelId,
      streamCfg,
      replyTo,
      !!channel.sendDraft,
      (text) => adaptFor(channel, msg, text),
      {
        ...(msg.topicId ? { topicId: msg.topicId } : {}),
        canStop: !!stop && !!channel.onStop && this.streamConfig.stopButton !== false,
      }
    );
    stream.start();
    const stoppable =
      stop && channel.onStop && this.streamConfig.stopButton !== false && stream.draftId !== null
        ? draftKey(channel.type, msg.channelId, stream.draftId)
        : undefined;
    if (stoppable && stop) this.stoppableDrafts.set(stoppable, stop);
    try {
      await this.streamRun(agent, msg, channel, threadId, signal, invoke, stream, stop, replyTo);
    } finally {
      if (stoppable) this.stoppableDrafts.delete(stoppable);
    }
  }

  /**
   * Streams one run into its buffer. A run the user stopped keeps what it wrote so far as its
   * reply instead of failing.
   */
  private async streamRun(
    agent: Agent,
    msg: ChannelMessage,
    channel: Channel,
    threadId: string,
    signal: AbortSignal | undefined,
    invoke: RunInvocation,
    stream: StreamBuffer,
    stop: AbortController | undefined,
    replyTo: string | undefined
  ): Promise<void> {
    const stoppedByUser = () => stop?.signal.aborted === true;
    const keepWhatWasWritten = async () => {
      await stream.finish();
      await this.hooks?.emit('stream:finished', {
        msg,
        threadId,
        messageIds: stream.getMessageIds(),
      });
    };

    await this.hooks?.emit('agent:before_run', { msg, threadId, agent: agent.name });
    await this.hooks?.emit('stream:started', { msg, threadId });

    let tokenCount = 0;
    let result: RunResult;
    try {
      result = await invoke({
        stream: true,
        onToken: (token: string) => {
          tokenCount++;
          stream.append(token);
        },
      });
    } catch (error) {
      if (stoppedByUser()) {
        await keepWhatWasWritten();
        return;
      }
      await stream.abort();
      if (!isResumeRejection(error)) {
        await this.hooks?.emit('agent:error', { msg, threadId, error: toError(error) });
      }
      throw error;
    }

    if (stoppedByUser()) {
      await keepWhatWasWritten();
      return;
    }
    if (signal?.aborted) {
      await stream.abort();
      return;
    }

    let replied = tokenCount > 0;
    if (replied) {
      await stream.finish();
    } else {
      await stream.abort();
      const output = adaptFor(channel, msg, result.output);
      if (output) {
        await this.sendChunked(channel, msg, output, replyTo);
        replied = true;
      }
    }

    await this.hooks?.emit('agent:after_run', { msg, threadId, output: result.output });
    await this.hooks?.emit('stream:finished', {
      msg,
      threadId,
      messageIds: stream.getMessageIds(),
    });

    await this.requestApprovals(result, msg, channel, threadId, replied ? undefined : replyTo);
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
