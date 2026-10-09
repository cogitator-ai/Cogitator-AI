/**
 * Channel types for messaging platform integration
 */

import type { Agent } from './agent';
import type { CompactionConfig, CompactionResult, Session, SessionManager } from './session';
import type { MemoryAdapter } from './memory';
import type { ToolApprovalDecision, ToolApprovalRequest } from './runtime';

export type ChannelType =
  'telegram' | 'discord' | 'slack' | 'whatsapp' | 'webchat' | 'bluesky' | 'threads' | (string & {});

export type AttachmentType = 'image' | 'file' | 'audio' | 'video';

export interface Attachment {
  type: AttachmentType;
  url?: string;
  buffer?: Uint8Array;
  mimeType: string;
  filename?: string;
  /** Text shown with an outgoing file, formatted as `SendOptions.format` says */
  caption?: string;
}

export interface ChannelMessage {
  readonly id: string;
  readonly channelType: ChannelType;
  readonly channelId: string;
  readonly userId: string;
  userName?: string;
  groupId?: string;
  text: string;
  attachments?: Attachment[];
  replyTo?: string;
  /**
   * The topic or thread inside the chat the message was posted in, such as a Telegram forum
   * topic or a topic of a private chat. Replies go to the same topic.
   */
  topicId?: string;
  raw: unknown;
}

export interface ChannelUser {
  readonly id: string;
  readonly channelType: ChannelType;
  name?: string;
  username?: string;
}

/** A button under a message. Exactly one of `data`, `url` or `copyText` says what it does. */
export interface ChannelButton {
  text: string;
  /** Sent back as `ChannelAction.data` when the button is pressed */
  data?: string;
  /** Opened when the button is pressed */
  url?: string;
  /** Copied to the clipboard when the button is pressed */
  copyText?: string;
  /** Color of the button, where the platform has colors */
  style?: 'primary' | 'success' | 'danger';
  /** Shown but does nothing */
  disabled?: boolean;
}

export interface SendOptions {
  replyTo?: string;
  format?: 'plain' | 'markdown' | 'html';
  silent?: boolean;
  /** Rows of buttons under the message, on channels that support them */
  buttons?: ChannelButton[][];
  /** The topic or thread of the chat to post in (`ChannelMessage.topicId`) */
  topicId?: string;
  /** Keep the message from being forwarded or saved, where the platform allows it */
  protect?: boolean;
  /** Link preview: `false` to turn it off, or which link to preview and how */
  linkPreview?: false | { url?: string; aboveText?: boolean; size?: 'small' | 'large' };
  /** A platform message effect, such as a Telegram message effect id (private chats only) */
  effect?: string;
  /** Show the message to this user only, where the platform has ephemeral messages */
  visibleTo?: string;
}

/** Options of a streamed draft */
export interface DraftOptions extends SendOptions {
  /**
   * Show the user a button that stops the generation. A press arrives through
   * `Channel.onStop` with the draft's id.
   */
  canStop?: boolean;
}

/** A button press: the `data` of a `ChannelButton` a user pressed */
export interface ChannelAction {
  /** Identifier to answer the press with (`Channel.answerAction`) */
  readonly id: string;
  readonly channelType: ChannelType;
  readonly channelId: string;
  readonly userId: string;
  userName?: string;
  /** The message the button is under */
  messageId?: string;
  topicId?: string;
  data: string;
  raw: unknown;
}

/** A user stopped a streamed draft with its stop button */
export interface ChannelStop {
  readonly channelType: ChannelType;
  readonly channelId: string;
  readonly draftId: number;
  topicId?: string;
}

/** A command in a channel's command menu */
export interface ChannelCommand {
  /** The command without its slash: lowercase letters, digits and underscores */
  command: string;
  description: string;
}

export interface Channel {
  readonly type: ChannelType;

  start(): Promise<void>;
  stop(): Promise<void>;

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void;

  sendText(channelId: string, text: string, options?: SendOptions): Promise<string>;
  editText(
    channelId: string,
    messageId: string,
    text: string,
    options?: SendOptions
  ): Promise<void>;
  /** Sends a file; resolves with the id of its message where the channel knows it */
  sendFile(channelId: string, file: Attachment, options?: SendOptions): Promise<string | void>;

  sendTyping(channelId: string, options?: Pick<SendOptions, 'topicId'>): Promise<void>;

  deleteMessage?(channelId: string, messageId: string): Promise<void>;

  sendDraft?(
    channelId: string,
    draftId: number,
    text: string,
    options?: DraftOptions
  ): Promise<void>;
  setReaction?(channelId: string, messageId: string, emoji: string): Promise<void>;

  /**
   * True when the channel renders standard (GitHub Flavored) Markdown itself, so text with
   * `format: 'markdown'` is sent as written instead of adapted to a platform dialect.
   */
  readonly nativeMarkdown?: boolean;
  /** The longest message the channel sends as one, in characters, when it differs from the platform default */
  readonly maxMessageChars?: number;

  /**
   * Several files sent together as one album, where the platform groups them; resolves with
   * the ids of the messages where the channel knows them
   */
  sendFiles?(
    channelId: string,
    files: Attachment[],
    options?: SendOptions
  ): Promise<string[] | void>;
  /** Called when a user presses a button with `data` */
  onAction?(handler: (action: ChannelAction) => Promise<void>): void;
  /** Acknowledges a button press, optionally with a short notice shown to the user */
  answerAction?(actionId: string, options?: { text?: string; alert?: boolean }): Promise<void>;
  /** Replaces a message's buttons; `null` removes them */
  editButtons?(
    channelId: string,
    messageId: string,
    buttons: ChannelButton[][] | null
  ): Promise<void>;
  /** Called when a user stops a streamed draft that was sent with `canStop` */
  onStop?(handler: (stop: ChannelStop) => void): void;
  /** Sets the command menu users see; `chatId` limits it to one chat */
  setCommands?(commands: ChannelCommand[], scope?: { chatId?: string }): Promise<void>;
}

export interface StreamConfig {
  flushInterval: number;
  minChunkSize: number;
  minInitialChars?: number;
  maxMessageChars?: number;
  deleteOnAbort?: boolean;
  /**
   * Show a stop button on streamed drafts where the channel supports it (default true).
   * A press stops the run and keeps what was written so far as the reply.
   */
  stopButton?: boolean;
}

export interface MiddlewareContext {
  threadId: string;
  user: ChannelUser;
  channel: Channel;
  set(key: string, value: unknown): void;
  get<T>(key: string): T | undefined;
}

export interface GatewayMiddleware {
  readonly name: string;
  handle(msg: ChannelMessage, ctx: MiddlewareContext, next: () => Promise<void>): Promise<void>;
}

export type OwnerConfig = Record<string, string>;

export type StatusPhase = 'queued' | 'thinking' | 'tool' | 'done' | 'error';

export type QueueMode = 'parallel' | 'sequential' | 'interrupt' | 'collect';

export interface StatusReactionConfig {
  enabled?: boolean;
  emojis?: Partial<Record<StatusPhase, string>>;
  debounceMs?: number;
  stallSoftMs?: number;
  stallHardMs?: number;
}

export interface DebounceConfig {
  enabled?: boolean;
  delayMs?: number;
  byChannel?: Partial<Record<ChannelType, number>>;
}

export interface EnvelopeConfig {
  enabled?: boolean;
  includeTimestamp?: boolean;
  includeElapsed?: boolean;
  timezone?: string;
  includeSender?: boolean;
  includeChannel?: boolean;
  includeChatType?: boolean;
}

/** Fields shared by the payloads of hooks fired while handling one inbound message */
export interface MessageHookEvent {
  msg: ChannelMessage;
  threadId: string;
}

/** Payload of `message:received`: a message passed the middleware chain */
export interface MessageReceivedEvent extends MessageHookEvent {
  user: ChannelUser;
}

/** Payload of `message:sending`: a reply is about to be sent */
export interface MessageSendingEvent extends MessageHookEvent {
  text: string;
  channelId: string;
}

/** Payload of `message:sent`: a reply was sent; `messageId` is the first chunk's id */
export interface MessageSentEvent extends MessageHookEvent {
  text: string;
  messageId: string;
}

/** Payload of `agent:before_run`; `agent` is the agent's name */
export interface AgentBeforeRunEvent extends MessageHookEvent {
  agent: string;
}

/** Payload of `agent:after_run` */
export interface AgentAfterRunEvent extends MessageHookEvent {
  output: string;
}

/** Payload of `agent:error`: the run threw */
export interface AgentErrorEvent extends MessageHookEvent {
  error: Error;
}

/** Payload of `session:created`: the first message of a new session */
export interface SessionCreatedEvent {
  session: Session;
  threadId: string;
}

/** Payload of `session:compacted`: older messages of a thread were summarized */
export interface SessionCompactedEvent {
  threadId: string;
  result: CompactionResult;
}

/** Payload of `stream:started`: a streaming reply began */
export type StreamStartedEvent = MessageHookEvent;

/** Payload of `stream:finished`: ids of the messages the streamed reply was sent as */
export interface StreamFinishedEvent extends MessageHookEvent {
  messageIds: readonly string[];
}

/** Payload of `approval:requested`: a run paused and the chat was asked */
export interface ApprovalRequestedEvent {
  msg: ChannelMessage;
  threadId: string;
  userId: string;
  approvals: readonly ToolApprovalRequest[];
}

/**
 * Payload of `approval:resolved`. `superseded` is true when the user
 * sent a new message instead of answering, so the runtime declined the calls.
 * `approvals` is missing when the pause predates this process (e.g. a restart).
 */
export interface ApprovalResolvedEvent {
  msg: ChannelMessage;
  threadId: string;
  userId: string;
  decision: ToolApprovalDecision;
  approvals?: readonly ToolApprovalRequest[];
  superseded: boolean;
}

/**
 * Payload of `action:received`: a user pressed a button the gateway does not handle itself.
 * Call `answer` to acknowledge it with a notice; the gateway answers it silently otherwise.
 */
export interface ActionReceivedEvent {
  action: ChannelAction;
  answer(options?: { text?: string; alert?: boolean }): Promise<void>;
}

/** Payload type of every gateway hook, by hook name */
export interface HookPayloads {
  'message:received': MessageReceivedEvent;
  'message:sending': MessageSendingEvent;
  'message:sent': MessageSentEvent;
  'agent:before_run': AgentBeforeRunEvent;
  'agent:after_run': AgentAfterRunEvent;
  'agent:error': AgentErrorEvent;
  'session:created': SessionCreatedEvent;
  'session:compacted': SessionCompactedEvent;
  'stream:started': StreamStartedEvent;
  'stream:finished': StreamFinishedEvent;
  'approval:requested': ApprovalRequestedEvent;
  'approval:resolved': ApprovalResolvedEvent;
  'action:received': ActionReceivedEvent;
}

export type HookName = keyof HookPayloads;

export type HookHandler<T = unknown> = (event: T) => void | Promise<void>;

/**
 * Gateway lifecycle hooks. Handlers receive the payload type of the hook they
 * are registered for (see `HookPayloads`); a handler typed `HookHandler`
 * (`unknown` payload) is still accepted for any hook.
 */
export interface HookRegistry {
  on<K extends HookName>(hook: K, handler: HookHandler<HookPayloads[K]>): void;
  off<K extends HookName>(hook: K, handler: HookHandler<HookPayloads[K]>): void;
  emit<K extends HookName>(hook: K, event: HookPayloads[K]): Promise<void>;
}

export interface GatewayConfig {
  agent: Agent | ((user: ChannelUser) => Agent | Promise<Agent>);
  channels: Channel[];
  memory?: MemoryAdapter;
  sessionManager?: SessionManager;
  middleware?: GatewayMiddleware[];

  /**
   * @deprecated Never read by the gateway. Owners are configured on the middleware that
   * uses them: `ownerCommands({ ownerIds })` and `dmPolicy({ ownerIds })`.
   */
  owner?: OwnerConfig;

  session?: {
    threadKey?: (msg: ChannelMessage) => string;
    compaction?: CompactionConfig;
  };

  stream?: StreamConfig;

  reactions?: StatusReactionConfig;
  debounce?: DebounceConfig;
  envelope?: EnvelopeConfig;
  queueMode?: QueueMode;
  hooks?: HookRegistry;

  onError?: (error: Error, msg: ChannelMessage) => void;
}

export interface GatewayStats {
  uptime: number;
  activeSessions: number;
  totalSessions: number;
  messagesToday: number;
  connectedChannels: string[];
}
