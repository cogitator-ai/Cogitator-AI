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

const SESSION_INDEX_THREAD = '__cogitator_session_index__';
const LEGACY_CHANNEL_TYPES = ['telegram', 'discord', 'slack', 'whatsapp', 'webchat'];

interface SessionIndexMetadata {
  _sessionIndex: true;
  sessions: string[];
  [key: string]: unknown;
}

export interface SessionManagerOptions {
  /** Enables `compact()`; without it compaction must be done with CompactionService directly */
  compaction?: CompactionService;
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

function isSessionThread(thread: Thread): boolean {
  return (thread.metadata as SessionMetadata)?._session === true;
}

export class SessionManager implements ISessionManager {
  private indexQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapter: MemoryAdapter,
    private readonly options: SessionManagerOptions = {}
  ) {}

  /**
   * Sessions are tracked in an index thread so they can be listed with any adapter.
   * Updates are serialized within this manager.
   */
  private updateIndex(mutate: (sessions: Set<string>) => void): Promise<void> {
    const run = async (): Promise<void> => {
      const existing = await this.adapter.getThread(SESSION_INDEX_THREAD);
      const meta = existing.success
        ? (existing.data?.metadata as SessionIndexMetadata | undefined)
        : undefined;
      const sessions = new Set(meta?._sessionIndex ? meta.sessions : []);
      mutate(sessions);

      const metadata: SessionIndexMetadata = { _sessionIndex: true, sessions: [...sessions] };
      const result =
        existing.success && existing.data
          ? await this.adapter.updateThread(SESSION_INDEX_THREAD, metadata)
          : await this.adapter.createThread('system', metadata, SESSION_INDEX_THREAD);
      if (!result.success) {
        throw new Error(`Failed to update session index: ${result.error}`);
      }
    };

    const next = this.indexQueue.then(run, run);
    this.indexQueue = next.catch(() => {});
    return next;
  }

  private async indexedSessionIds(): Promise<string[]> {
    const index = await this.adapter.getThread(SESSION_INDEX_THREAD);
    if (!index.success || !index.data) return [];
    const meta = index.data.metadata as SessionIndexMetadata;
    return meta._sessionIndex ? meta.sessions : [];
  }

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
    await this.updateIndex((sessions) => sessions.add(threadId));

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
   * List sessions tracked by this manager's index (plus sessions created before the index
   * existed, found by user id for the built-in channel types).
   */
  async list(filter?: SessionFilter): Promise<Session[]> {
    const ids = new Set(await this.indexedSessionIds());
    if (filter?.userId) {
      for (const channelType of LEGACY_CHANNEL_TYPES) {
        ids.add(`session_${channelType}_${filter.userId}`);
      }
    }

    const threads: Thread[] = [];
    for (const id of ids) {
      const result = await this.adapter.getThread(id);
      if (result.success && result.data && isSessionThread(result.data)) {
        threads.push(result.data);
      }
    }

    let sessions = threads.map(threadToSession);

    if (filter?.userId) {
      sessions = sessions.filter((s) => s.userId === filter.userId);
    }
    if (filter?.channelType) {
      sessions = sessions.filter((s) => s.channelType === filter.channelType);
    }
    if (filter?.agentId) {
      sessions = sessions.filter((s) => s.agentId === filter.agentId);
    }
    if (filter?.status) {
      sessions = sessions.filter((s) => s.status === filter.status);
    }
    if (filter?.activeSince) {
      const since = filter.activeSince;
      sessions = sessions.filter((s) => s.lastActiveAt >= since);
    }

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
    await this.updateIndex((sessions) => sessions.delete(sessionId));
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
