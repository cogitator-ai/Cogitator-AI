/**
 * Channel types for messaging platform integration
 */

import type { Agent } from './agent';
import type { CompactionConfig, CompactionResult, Session, SessionManager } from './session';
import type { MemoryAdapter } from './memory';
import type { ToolApprovalDecision, ToolApprovalRequest } from './runtime';

export type ChannelType = 'telegram' | 'discord' | 'slack' | 'whatsapp' | 'webchat' | (string & {});

export type AttachmentType = 'image' | 'file' | 'audio' | 'video';

export interface Attachment {
  type: AttachmentType;
  url?: string;
  buffer?: Uint8Array;
  mimeType: string;
  filename?: string;
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
  raw: unknown;
}

export interface ChannelUser {
  readonly id: string;
  readonly channelType: ChannelType;
  name?: string;
  username?: string;
}

export interface SendOptions {
  replyTo?: string;
  format?: 'plain' | 'markdown' | 'html';
  silent?: boolean;
}

export interface Channel {
  readonly type: ChannelType;

  start(): Promise<void>;
  stop(): Promise<void>;

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void;

  sendText(channelId: string, text: string, options?: SendOptions): Promise<string>;
  editText(channelId: string, messageId: string, text: string): Promise<void>;
  sendFile(channelId: string, file: Attachment): Promise<void>;

  sendTyping(channelId: string): Promise<void>;

  deleteMessage?(channelId: string, messageId: string): Promise<void>;

  sendDraft?(
    channelId: string,
    draftId: number,
    text: string,
    options?: SendOptions
  ): Promise<void>;
  setReaction?(channelId: string, messageId: string, emoji: string): Promise<void>;
}

export interface StreamConfig {
  flushInterval: number;
  minChunkSize: number;
  minInitialChars?: number;
  maxMessageChars?: number;
  deleteOnAbort?: boolean;
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
