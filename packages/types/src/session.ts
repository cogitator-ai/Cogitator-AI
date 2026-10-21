/**
 * Session types for persistent conversation management
 */

export type SessionStatus = 'active' | 'paused' | 'archived';

/**
 * How a thread is compacted: `hierarchical` keeps a tree of grounded atoms (see
 * `CompactionLevels`), `summary` one summary text, `sliding-window` drops old entries, `hybrid`
 * one of the last two by how much there is to drop
 */
export type CompactionStrategy = 'hierarchical' | 'summary' | 'sliding-window' | 'hybrid';

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
  /**
   * Tokens of the newest conversation kept verbatim, in place of `keepRecent` when set: a
   * suffix of whole turns, so a tool call keeps its result
   */
  keepRecentTokens?: number;
  /** `hierarchical`: tokens of conversation one chapter covers (default 4000) */
  chapterTokens?: number;
  /**
   * `hierarchical`: chapters read at once (default 1). One at a time, each chapter is told every
   * item still open before it, so it can close it. Read at once, a chapter is not told the items
   * the model finds in the chapters read along with it, only those found before.
   */
  chapterConcurrency?: number;
  /** `hierarchical`: chapters kept before the oldest are folded into an arc (default 4) */
  chaptersPerArc?: number;
  /** `hierarchical`: arcs kept before the oldest are folded into the saga (default 4) */
  arcsPerSaga?: number;
  /** Model that writes the summary; handed to the summarizer as `options.model`. */
  summaryModel?: string;
  /** Instructions for the summary; handed to the summarizer as `options.prompt`. */
  summaryPrompt?: string;
}

/** A compaction about to happen after a run, for `MemoryCompactionConfig.beforeCompact` */
export interface BeforeCompactEvent {
  threadId: string;
  /** Tokens of the thread's conversation */
  tokens: number;
  /** Tokens past which the thread is compacted */
  threshold: number;
}

/**
 * Compaction of a run's thread after the run (`memory.compaction`): once the conversation of the
 * run's branch passes `at` of the model's context window, it is compacted `hierarchical`ly, the
 * newest `keepRecentTokens` kept verbatim (by default the less of 20000 and a quarter of the
 * window). The settings of `CompactionConfig` apply, and `strategy` is always `hierarchical`.
 */
export interface MemoryCompactionConfig extends Partial<
  Omit<CompactionConfig, 'strategy' | 'threshold' | 'messageThreshold'>
> {
  /** Share of the model's context window the conversation passes to be compacted (default 0.8) */
  at?: number;
  /**
   * Called before a compaction, a chance to save what matters to memory: `false` cancels it,
   * `{ instructions }` adds to what the summarizer is asked
   */
  beforeCompact?: (
    event: BeforeCompactEvent
  ) => void | false | { instructions?: string } | Promise<void | false | { instructions?: string }>;
  /** Called after a compaction with what it did */
  afterCompact?: (result: CompactionResult) => void | Promise<void>;
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
