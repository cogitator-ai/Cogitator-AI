/**
 * Channel types for messaging platform integration
 */

import type { Agent } from './agent';
import type { CompactionConfig, SessionManager } from './session';
import type { MemoryAdapter } from './memory';

export type ChannelType = 'telegram' | 'discord' | 'slack' | 'whatsapp' | 'webchat' | (string & {});

export type AttachmentType = 'image' | 'file' | 'audio' | 'video';

export interface Attachment {
  type: AttachmentType;
  url?: string;
  buffer?: Buffer;
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
}

export interface StreamConfig {
  flushInterval: number;
  minChunkSize: number;
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

export interface GatewayConfig {
  agent: Agent | ((user: ChannelUser) => Agent | Promise<Agent>);
  channels: Channel[];
  memory?: MemoryAdapter;
  sessionManager?: SessionManager;
  middleware?: GatewayMiddleware[];

  owner?: OwnerConfig;

  session?: {
    threadKey?: (msg: ChannelMessage) => string;
    compaction?: CompactionConfig;
  };

  stream?: StreamConfig;

  onError?: (error: Error, msg: ChannelMessage) => void;
}

export interface GatewayStats {
  uptime: number;
  activeSessions: number;
  totalSessions: number;
  messagesToday: number;
  connectedChannels: string[];
}
