import type {
  GatewayConfig,
  GatewayStats,
  Channel,
  ChannelAction,
  ChannelButton,
  ChannelMessage,
  ChannelUser,
  CompactionConfig,
  CompactionResult,
  MiddlewareContext,
  GatewayMiddleware,
  HookRegistry,
  StreamConfig,
  ImageInput,
  Message,
  RunOptions,
  RunResult,
  Session,
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
  CONVERSATIONS_KEY,
  defaultThreadKey,
  findConversation,
  legacyThreadKey,
  readConversations,
  rememberConversation,
} from './thread-key';
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
  /**
   * Notes for each run of a message, such as the current time, sent with the input and not
   * saved with it (see `RunOptions.brief`), so they do not change the agent's instructions and
   * the prompt cache they open with
   */
  brief?: (msg: ChannelMessage) => string | undefined;
  /**
   * How long {@link Gateway.stop} waits for the queued messages and the runs in progress to be
   * answered, in milliseconds (default 30000). What is still running then is aborted, and what
   * is still waiting is dropped.
   */
  drainTimeout?: number;
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

const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

/** Why {@link Gateway.stop} aborts the runs still going past `drainTimeout` */
const GATEWAY_STOPPED = new Error('The gateway stopped');

/** Threads kept in the gateway's own bookkeeping (stats, sessions, envelope times) */
export const MAX_TRACKED_THREADS = 10_000;

/** Sets `key` as the most recent entry of `map`, dropping the least recent one past the limit */
function touch<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_TRACKED_THREADS) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
}

/** Resolves `true` once `promise` settles, or `false` after `ms` */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

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
  /** The stop of every run in progress */
  private readonly runs = new Set<AbortController>();
  /** The stop of each run, by the signal the run was given */
  private readonly stops = new WeakMap<AbortSignal, AbortController>();
  /** The stop of each run streaming into a draft with a stop button, by channel, chat and draft */
  private readonly stoppableDrafts = new Map<string, AbortController>();
  /** Approval prompts with buttons, by channel, chat and message: whose paused run each answers */
  private readonly approvalPrompts = new Map<string, ApprovalPrompt>();
  private readonly lastMessageTime = new Map<string, number>();
  private readonly threads = new Map<string, Omit<GatewaySessionInfo, 'threadId' | 'active'>>();
  private readonly inFlight = new Map<string, number>();
  /** Messages taken and not answered yet, for {@link idle} */
  private readonly pending = new Set<Promise<boolean>>();
  /** The stop in progress, which a second {@link stop} call returns */
  private stopping: Promise<void> | null = null;
  /** The last pending write of each user's session, so writes to one session never interleave */
  private readonly sessionWrites = new Map<string, Promise<void>>();
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

    const queueMode = config.queueMode ?? 'sequential';
    this.messageQueue =
      queueMode === 'parallel'
        ? null
        : new MessageQueue(queueMode, (msg, signal) => this.processMessage(msg, signal));

    this.debouncer = config.debounce?.enabled
      ? new InboundDebouncer(config.debounce, async (merged) => {
          this.dispatch(merged).catch(() => {});
        })
      : null;

    for (const channel of this.channels) {
      channel.onMessage((msg) => this.handleIncoming(msg, false));
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

  /**
   * Stops the gateway. Channels have already confirmed the messages they handed over, so it
   * first lets them be answered: messages held by `debounce` are flushed, and it waits up to
   * `drainTimeout` for the queues and the runs in progress. Then it aborts the runs still going,
   * drops the messages still waiting, waits for the aborted runs to settle (up to `drainTimeout`
   * again) and stops the channels. Messages that come in meanwhile are refused (see
   * {@link injectMessage}). A second call while it stops returns the same promise.
   */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.running) return Promise.resolve();
    this.running = false;
    const stopping = this.drainAndStop().finally(() => {
      this.stopping = null;
    });
    this.stopping = stopping;
    return stopping;
  }

  private async drainAndStop(): Promise<void> {
    const timeout = this.config.drainTimeout ?? DEFAULT_DRAIN_TIMEOUT_MS;

    if (this.debouncer) {
      await this.debouncer.flushAll();
      this.debouncer.dispose();
    }
    if (!(await settlesWithin(this.idle(), timeout))) {
      this.messageQueue?.dispose();
      for (const run of this.runs) run.abort(GATEWAY_STOPPED);
      await settlesWithin(this.idle(), timeout);
    }
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

  /**
   * Feeds a message to the gateway as if a channel had received it (the scheduler sends its
   * tasks this way). It resolves once the message is answered, or once it is buffered when
   * `debounce` is on. It rejects when the message was not answered: its run failed (also
   * reported to `onError`), it was aborted or dropped by {@link stop}, or it came in while the
   * gateway was stopping.
   */
  async injectMessage(msg: ChannelMessage): Promise<void> {
    return this.handleIncoming(msg, true);
  }

  /**
   * Resolves once every message the gateway has taken is answered: those waiting in their
   * thread's queue and the runs in progress, including messages that come in while it waits.
   * Messages held by `debounce` count from the moment they are flushed. {@link stop} waits
   * for it, up to `drainTimeout`.
   */
  async idle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled(this.pending);
    }
  }

  /**
   * Summarize older messages of a conversation thread, keeping `keepRecent` messages intact.
   * Runs regardless of the configured thresholds.
   */
  async compactThread(threadId: string, agent?: Agent): Promise<string> {
    const compaction = this.config.session?.compaction;
    if (!this.config.memory || !compaction) {
      return 'Compaction is not configured';
    }

    const result = await this.compact(threadId, { ...compaction, threshold: 0 }, agent);
    return result.compactedMessages < result.originalMessages
      ? `Compacted ${result.originalMessages} messages into ${result.compactedMessages}`
      : `Nothing to compact (${result.originalMessages} messages)`;
  }

  /**
   * Compacts every conversation thread the gateway knows, as {@link compactThread} does one: the
   * threads it served since it started and, unless `session.threadKey` names threads its own way,
   * the thread of every stored session. Threads go one at a time, and one that fails does not
   * stop the rest.
   */
  async compactAll(): Promise<string> {
    const compaction = this.config.session?.compaction;
    if (!this.config.memory || !compaction) {
      return 'Compaction is not configured';
    }

    const { threadIds, listError } = await this.knownThreads();
    const notListed = listError ? ` (stored sessions could not be listed: ${listError})` : '';
    if (threadIds.length === 0) return `No threads to compact${notListed}`;

    const agent = await this.resolveAgent({ id: 'system', channelType: 'system' });
    let compacted = 0;
    const failures: string[] = [];
    for (const threadId of threadIds) {
      try {
        const result = await this.compact(threadId, { ...compaction, threshold: 0 }, agent);
        if (result.compactedMessages < result.originalMessages) compacted++;
      } catch (error) {
        failures.push(`${threadId}: ${toError(error).message}`);
      }
    }

    const lines = [`Compacted ${compacted} of ${threadIds.length} threads${notListed}`];
    if (failures.length > 0) lines.push(`Failed (${failures.length}):`, ...failures);
    return lines.join('\n');
  }

  /**
   * The threads {@link compactAll} goes through: those served since the gateway started, and the
   * threads of each stored session when they are keyed by the default key (the conversations kept
   * in the session's metadata, or the chat it was created in) or by `legacyThreadKey`
   */
  private async knownThreads(): Promise<{ threadIds: string[]; listError?: string }> {
    const threadIds = new Set(this.threads.keys());
    const threadKey = this.config.session?.threadKey;
    if (!this.sessionManager || (threadKey && threadKey !== legacyThreadKey)) {
      return { threadIds: [...threadIds] };
    }
    try {
      for (const session of await this.sessionManager.list()) {
        if (threadKey) {
          threadIds.add(legacyThreadKey(session));
          continue;
        }
        const conversations = readConversations(session.metadata);
        for (const conversation of conversations.length > 0
          ? conversations
          : [{ channelId: session.channelId }]) {
          threadIds.add(
            defaultThreadKey({
              channelType: session.channelType,
              userId: session.userId,
              ...conversation,
            })
          );
        }
      }
    } catch (error) {
      return { threadIds: [...threadIds], listError: toError(error).message };
    }
    return { threadIds: [...threadIds] };
  }

  /**
   * Compacts the thread once it holds `threshold` tokens or `messageThreshold` messages, the
   * same rules `CompactionService` applies everywhere.
   */
  private async compactIfNeeded(threadId: string, agent: Agent): Promise<void> {
    const compaction = this.config.session?.compaction;
    if (!this.config.memory || !compaction) return;
    await this.compact(threadId, compaction, agent);
  }

  private async compact(
    threadId: string,
    config: CompactionConfig,
    agent?: Agent
  ): Promise<CompactionResult> {
    const memory = this.config.memory;
    if (!memory) throw new Error('Compaction needs memory');

    const targetAgent = agent ?? (await this.resolveAgent({ id: 'system', channelType: 'system' }));
    const service = new CompactionService({
      adapter: memory,
      summarize: this.createSummarizeFn(targetAgent, config),
    });
    const result = await service.compact(threadId, config);

    if (result.compactedMessages < result.originalMessages) {
      await this.hooks?.emit('session:compacted', { threadId, result });
    }
    return result;
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
      ...(action.conversationId ? { conversationId: action.conversationId } : {}),
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
    await this.handleIncoming(msg, false);
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

  /**
   * A message from a channel, a button or {@link injectMessage}. With a queue, a channel's message
   * is only queued, so the channel goes on to its next update while the thread waits its turn.
   * `untilAnswered` waits for the answer.
   */
  private async handleIncoming(msg: ChannelMessage, untilAnswered: boolean): Promise<void> {
    if (this.stopping) {
      const refused = new Error('The gateway is stopping: the message was dropped');
      this.config.onError?.(refused, msg);
      if (untilAnswered) throw refused;
      return;
    }
    if (this.debouncer) {
      this.debouncer.enqueue(msg);
      return;
    }
    const answered = this.dispatch(msg);
    if (untilAnswered || !this.messageQueue) {
      if (!(await answered) && untilAnswered) {
        throw new Error('The message was not answered: its run failed or was aborted');
      }
      return;
    }
    answered.catch(() => {});
  }

  /** Puts a message through the queue of its thread, resolving once it is done with */
  private dispatch(msg: ChannelMessage): Promise<boolean> {
    const answered = this.route(msg);
    this.pending.add(answered);
    const forget = () => {
      this.pending.delete(answered);
    };
    answered.then(forget, forget);
    return answered;
  }

  /** Resolves `true` once the message is handled, `false` when it failed or was dropped */
  private async route(incoming: ChannelMessage): Promise<boolean> {
    const msg = await this.locateScheduled(incoming);
    if (this.messageQueue) return this.messageQueue.push(msg, this.getThreadId(msg));
    return this.processMessage(msg);
  }

  /**
   * A scheduled message names only its chat, so with the default thread key it gets the topic or
   * conversation of the user's most recent conversation in that chat, kept in their session: the
   * task is then answered in the thread and topic it was set up in.
   */
  private async locateScheduled(msg: ChannelMessage): Promise<ChannelMessage> {
    if (
      !isScheduled(msg) ||
      msg.topicId ||
      msg.conversationId ||
      !this.sessionManager ||
      this.config.session?.threadKey
    ) {
      return msg;
    }
    try {
      const [session] = await this.sessionManager.list({
        userId: msg.userId,
        channelType: msg.channelType,
        limit: 1,
      });
      const conversation = session
        ? findConversation(readConversations(session.metadata), msg.channelId)
        : undefined;
      if (!conversation) return msg;
      return {
        ...msg,
        ...(conversation.topicId && { topicId: conversation.topicId }),
        ...(conversation.conversationId && { conversationId: conversation.conversationId }),
      };
    } catch (error) {
      this.config.onError?.(toError(error), msg);
      return msg;
    }
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

  /**
   * Handles one message, `false` when its run failed or was aborted. A message for a channel
   * the gateway does not run counts as handled: it never can be.
   */
  private async processMessage(msg: ChannelMessage, signal?: AbortSignal): Promise<boolean> {
    const channel = this.channels.find((ch) => ch.type === msg.channelType);
    if (!channel) return true;

    const threadId = this.getThreadId(msg);
    this.inFlight.set(threadId, (this.inFlight.get(threadId) ?? 0) + 1);

    const stop = new AbortController();
    const runSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
    this.stops.set(runSignal, stop);
    this.runs.add(stop);

    try {
      await this.processWithChannel(msg, channel, threadId, runSignal);
      return signal?.aborted !== true && stop.signal.reason !== GATEWAY_STOPPED;
    } catch (error) {
      if (!runSignal.aborted) this.config.onError?.(toError(error), msg);
      return false;
    } finally {
      this.runs.delete(stop);
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
    touch(this.threads, threadId, {
      channelType: msg.channelType,
      userId: msg.userId,
      ...(msg.userName || known?.userName ? { userName: msg.userName ?? known?.userName } : {}),
      messageCount: (known?.messageCount ?? 0) + 1,
      lastActiveAt: Date.now(),
    });

    const agent = await this.resolveAgent(user);

    if (this.sessionManager) {
      const sessionManager = this.sessionManager;
      await this.writeSession(`${msg.channelType}:${msg.userId}`, async () => {
        const session = await sessionManager.getOrCreate({
          userId: msg.userId,
          channelType: msg.channelType,
          channelId: msg.channelId,
          agentId: agent.name,
        });
        if (session.messageCount === 0) {
          await this.hooks?.emit('session:created', { session, threadId });
        }
        if (!this.config.session?.threadKey && !isScheduled(msg)) {
          await this.rememberConversation(sessionManager, session, msg);
        }
        await sessionManager.incrementMessageCount?.(session.id);
      });
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
      touch(this.lastMessageTime, threadId, Date.now());
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
    if (this.config.stream && channel.editable !== false) {
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
    const brief = this.config.brief?.(msg);
    return {
      useMemory: !!this.config.memory,
      ...(brief && { brief }),
      userId: msg.userId,
      channelType: msg.channelType,
      channelId: msg.channelId,
      ...(msg.topicId && { topicId: msg.topicId }),
      ...(msg.conversationId && { conversationId: msg.conversationId }),
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
    return defaultThreadKey(msg);
  }

  /**
   * Keeps the message's conversation in the user's session, so its thread is known after a
   * restart. A failure is reported to `onError` and does not keep the message from its answer.
   */
  private async rememberConversation(
    sessionManager: GatewaySessionManager,
    session: Session,
    msg: ChannelMessage
  ): Promise<void> {
    const conversations = rememberConversation(readConversations(session.metadata), msg);
    if (!conversations) return;
    try {
      await sessionManager.update(session.id, {
        metadata: { [CONVERSATIONS_KEY]: conversations },
      });
    } catch (error) {
      this.config.onError?.(toError(error), msg);
    }
  }

  /**
   * Runs `write` after every earlier write to the same session has finished, so a read, change
   * and write of its metadata never loses another one's change.
   */
  private async writeSession(key: string, write: () => Promise<void>): Promise<void> {
    const previous = this.sessionWrites.get(key) ?? Promise.resolve();
    const current = previous.then(write);
    const settled = current.catch(() => {});
    this.sessionWrites.set(key, settled);
    try {
      await current;
    } finally {
      if (this.sessionWrites.get(key) === settled) this.sessionWrites.delete(key);
    }
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

  /**
   * A summarizer that asks `options.model` with `options.prompt` as its system message, as
   * `CompactionService` hands them per call (the `hierarchical` strategy asks for chapter atoms
   * this way). Without them it falls back to the compaction's `summaryModel` / `summaryPrompt`,
   * then to the agent's model and {@link DEFAULT_SUMMARY_PROMPT}.
   */
  private createSummarizeFn(agent: Agent, compaction: CompactionConfig): SummarizeFn {
    return async (messages, options) => {
      const summaryModel = options?.model ?? compaction.summaryModel;
      const modelId = summaryModel ?? this.config.cogitator.resolveModel(agent);
      const explicitProvider = summaryModel ? undefined : agent.config?.provider;
      const prompt = options?.prompt ?? compaction.summaryPrompt ?? DEFAULT_SUMMARY_PROMPT;
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
