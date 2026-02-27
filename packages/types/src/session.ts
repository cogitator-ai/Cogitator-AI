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

export interface CompactionConfig {
  strategy: CompactionStrategy;
  threshold: number;
  keepRecent: number;
  summaryModel?: string;
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
