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
  constructor(private readonly adapter: MemoryAdapter) {}

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
    const updatedMeta: SessionMetadata = {
      ...currentMeta,
      ...(data.status !== undefined && { status: data.status }),
      ...(data.config !== undefined && { config: data.config }),
      ...(data.metadata !== undefined && { ...data.metadata }),
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

  async list(filter?: SessionFilter): Promise<Session[]> {
    const allThreads: Thread[] = [];

    const testIds = filter?.userId
      ? [
          `session_telegram_${filter.userId}`,
          `session_discord_${filter.userId}`,
          `session_slack_${filter.userId}`,
          `session_whatsapp_${filter.userId}`,
          `session_webchat_${filter.userId}`,
        ]
      : [];

    if (testIds.length > 0) {
      for (const id of testIds) {
        const result = await this.adapter.getThread(id);
        if (result.success && result.data && isSessionThread(result.data)) {
          allThreads.push(result.data);
        }
      }
    }

    let sessions = allThreads.map(threadToSession);

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

    if (filter?.offset) {
      sessions = sessions.splice(filter.offset);
    }
    if (filter?.limit) {
      sessions = sessions.slice(0, filter.limit);
    }

    return sessions;
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

  async compact(_sessionId: string, _config: CompactionConfig): Promise<CompactionResult> {
    throw new Error(
      'Compaction requires LLM backend - use CompactionService from @cogitator-ai/memory'
    );
  }
}
