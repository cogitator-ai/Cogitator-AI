import type {
  MemoryAdapter,
  Session,
  SessionManager as ISessionManager,
  SessionFilter,
  SessionStatus,
  SessionConfigOverrides,
  CompactionConfig,
  CompactionResult,
  Thread,
} from '@cogitator-ai/types';
import type { CompactionService } from './compaction';

export interface SessionManagerOptions {
  /** Enables `compact()`; without it compaction must be done with CompactionService directly */
  compaction?: CompactionService;
  /**
   * @deprecated Sessions are found with the adapter's `listThreads`, no index thread is kept any
   * more. The option is ignored.
   */
  indexRefreshInterval?: number;
}

interface SessionMetadata {
  _session: true;
  userId: string;
  channelType: string;
  channelId: string;
  status: SessionStatus;
  messageCount: number;
  lastActiveAt: string;
  config?: SessionConfigOverrides;
  [key: string]: unknown;
}

function threadToSession(thread: Thread): Session {
  const meta = thread.metadata as SessionMetadata;
  return {
    id: thread.id,
    userId: meta.userId,
    channelType: meta.channelType,
    channelId: meta.channelId,
    agentId: thread.agentId,
    status: meta.status ?? 'active',
    messageCount: meta.messageCount ?? 0,
    metadata: extractUserMetadata(meta),
    lastActiveAt: new Date(meta.lastActiveAt ?? thread.updatedAt),
    createdAt: thread.createdAt,
    config: meta.config,
  };
}

const SESSION_INTERNAL_KEYS = new Set([
  '_session',
  'userId',
  'channelType',
  'channelId',
  'createdAt',
  'status',
  'messageCount',
  'lastActiveAt',
  'config',
]);

function extractUserMetadata(meta: SessionMetadata): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(meta)) {
    if (!SESSION_INTERNAL_KEYS.has(key)) {
      result[key] = meta[key];
    }
  }
  return result;
}

/** Threads read per `listThreads` call when listing sessions. */
const SESSION_PAGE = 200;

function isSessionThread(thread: Thread): boolean {
  return (thread.metadata as SessionMetadata)?._session === true;
}

export class SessionManager implements ISessionManager {
  constructor(
    private readonly adapter: MemoryAdapter,
    private readonly options: SessionManagerOptions = {}
  ) {}

  async getOrCreate(params: {
    userId: string;
    channelType: string;
    channelId: string;
    agentId: string;
  }): Promise<Session> {
    const threadId = `session_${params.channelType}_${params.userId}`;

    const existing = await this.adapter.getThread(threadId);
    if (existing.success && existing.data) {
      const session = threadToSession(existing.data);
      if (session.status === 'archived') {
        await this.adapter.updateThread(threadId, {
          ...(existing.data.metadata as Record<string, unknown>),
          status: 'active',
          lastActiveAt: new Date().toISOString(),
        });
        return { ...session, status: 'active', lastActiveAt: new Date() };
      }
      return session;
    }

    const meta: SessionMetadata = {
      _session: true,
      userId: params.userId,
      channelType: params.channelType,
      channelId: params.channelId,
      status: 'active',
      messageCount: 0,
      lastActiveAt: new Date().toISOString(),
    };

    const result = await this.adapter.createThread(params.agentId, meta, threadId);
    if (!result.success) {
      throw new Error(`Failed to create session: ${result.error}`);
    }
    return threadToSession(result.data);
  }

  async get(sessionId: string): Promise<Session | null> {
    const result = await this.adapter.getThread(sessionId);
    if (!result.success || !result.data) return null;
    if (!isSessionThread(result.data)) return null;
    return threadToSession(result.data);
  }

  async update(
    sessionId: string,
    data: Partial<Pick<Session, 'status' | 'metadata' | 'config'>>
  ): Promise<Session> {
    const existing = await this.adapter.getThread(sessionId);
    if (!existing.success || !existing.data) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const currentMeta = existing.data.metadata as SessionMetadata;

    let safeMetadata: Record<string, unknown> | undefined;
    if (data.metadata) {
      safeMetadata = {};
      for (const [key, value] of Object.entries(data.metadata)) {
        if (!SESSION_INTERNAL_KEYS.has(key)) {
          safeMetadata[key] = value;
        }
      }
    }

    const updatedMeta: SessionMetadata = {
      ...currentMeta,
      ...(data.status !== undefined && { status: data.status }),
      ...(data.config !== undefined && { config: data.config }),
      ...(safeMetadata !== undefined && { ...safeMetadata }),
      lastActiveAt: new Date().toISOString(),
    };

    const result = await this.adapter.updateThread(sessionId, updatedMeta);
    if (!result.success) {
      throw new Error(`Failed to update session: ${result.error}`);
    }

    return threadToSession(result.data);
  }

  async archive(sessionId: string): Promise<void> {
    await this.update(sessionId, { status: 'archived' });
  }

  /**
   * Sessions matching `filter`, most recently active first, found with the adapter's
   * `listThreads` among the threads marked as sessions.
   */
  async list(filter?: SessionFilter): Promise<Session[]> {
    const metadata: Record<string, string | boolean> = {
      _session: true,
      ...(filter?.userId !== undefined && { userId: filter.userId }),
      ...(filter?.channelType !== undefined && { channelType: filter.channelType }),
    };
    const sessions: Session[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.adapter.listThreads({
        metadata,
        ...(filter?.agentId !== undefined && { agentId: filter.agentId }),
        ...(filter?.activeSince && { updatedAfter: filter.activeSince }),
        limit: SESSION_PAGE,
        ...(cursor && { cursor }),
      });
      if (!page.success) throw new Error(`Failed to list sessions: ${page.error}`);
      for (const thread of page.data.threads) {
        const session = threadToSession(thread);
        if (filter?.status && session.status !== filter.status) continue;
        if (filter?.activeSince && session.lastActiveAt < filter.activeSince) continue;
        sessions.push(session);
      }
      cursor = page.data.nextCursor;
    } while (cursor);

    sessions.sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime());

    const offset = filter?.offset ?? 0;
    const end = filter?.limit !== undefined ? offset + filter.limit : undefined;
    return sessions.slice(offset, end);
  }

  async delete(sessionId: string): Promise<void> {
    const result = await this.adapter.deleteThread(sessionId);
    if (!result.success) {
      throw new Error(`Failed to delete session: ${result.error}`);
    }
  }

  async incrementMessageCount(sessionId: string): Promise<void> {
    const existing = await this.adapter.getThread(sessionId);
    if (!existing.success || !existing.data) return;

    const meta = existing.data.metadata as SessionMetadata;
    await this.adapter.updateThread(sessionId, {
      ...meta,
      messageCount: (meta.messageCount ?? 0) + 1,
      lastActiveAt: new Date().toISOString(),
    });
  }

  /**
   * Compact a session's history with the CompactionService passed in the options.
   */
  async compact(sessionId: string, config: CompactionConfig): Promise<CompactionResult> {
    if (!this.options.compaction) {
      throw new Error(
        'Session compaction needs a summarizer: create the SessionManager with { compaction: new CompactionService(...) }'
      );
    }
    return this.options.compaction.compact(sessionId, config);
  }
}
