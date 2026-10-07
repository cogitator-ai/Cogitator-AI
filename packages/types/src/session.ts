/**
 * Session types for persistent conversation management
 */

export type SessionStatus = 'active' | 'paused' | 'archived';

export type CompactionStrategy = 'summary' | 'sliding-window' | 'hybrid';

export interface Session {
  readonly id: string;
  userId: string;
  channelType: string;
  channelId: string;
  agentId: string;
  status: SessionStatus;
  messageCount: number;
  metadata: Record<string, unknown>;
  lastActiveAt: Date;
  createdAt: Date;

  config?: SessionConfigOverrides;
}

export interface SessionConfigOverrides {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface SessionFilter {
  userId?: string;
  channelType?: string;
  agentId?: string;
  status?: SessionStatus;
  activeSince?: Date;
  limit?: number;
  offset?: number;
}

/**
 * When and how to compact a thread. It is compacted once its entries hold `threshold` tokens or
 * once it holds `messageThreshold` entries, whichever comes first; at least one must be set.
 */
export interface CompactionConfig {
  strategy: CompactionStrategy;
  /** Tokens the thread's entries must hold before it is compacted */
  threshold?: number;
  /** Entries (messages) the thread must hold before it is compacted */
  messageThreshold?: number;
  /** Newest entries kept verbatim after the summary */
  keepRecent: number;
  /** Model that writes the summary; handed to the summarizer as `options.model`. */
  summaryModel?: string;
  /** Instructions for the summary; handed to the summarizer as `options.prompt`. */
  summaryPrompt?: string;
}

export interface CompactionResult {
  sessionId: string;
  originalMessages: number;
  compactedMessages: number;
  summaryTokens: number;
}

export interface SessionManager {
  getOrCreate(params: {
    userId: string;
    channelType: string;
    channelId: string;
    agentId: string;
  }): Promise<Session>;

  get(sessionId: string): Promise<Session | null>;
  update(
    sessionId: string,
    data: Partial<Pick<Session, 'status' | 'metadata' | 'config'>>
  ): Promise<Session>;
  archive(sessionId: string): Promise<void>;
  list(filter?: SessionFilter): Promise<Session[]>;
  delete(sessionId: string): Promise<void>;

  compact(sessionId: string, config: CompactionConfig): Promise<CompactionResult>;
}
