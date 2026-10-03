import type { MemoryAdapter, RunCheckpoint, RunCheckpointStore } from '@cogitator-ai/types';

/** Paused runs in process memory; they are lost when the process exits. */
export class InMemoryRunCheckpointStore implements RunCheckpointStore {
  private readonly checkpoints = new Map<string, RunCheckpoint>();

  async save(checkpoint: RunCheckpoint): Promise<void> {
    this.checkpoints.set(checkpoint.threadId, structuredClone(checkpoint));
  }

  async load(threadId: string): Promise<RunCheckpoint | null> {
    const checkpoint = this.checkpoints.get(threadId);
    return checkpoint ? structuredClone(checkpoint) : null;
  }

  async delete(threadId: string): Promise<void> {
    this.checkpoints.delete(threadId);
  }
}

const PAUSED_RUN_KEY = 'pausedRun';

/**
 * Paused runs kept in their thread's metadata, so they last as long as the
 * memory adapter's threads do (Redis, Postgres, SQLite, MongoDB).
 */
export class ThreadRunCheckpointStore implements RunCheckpointStore {
  constructor(private readonly memory: MemoryAdapter) {}

  async save(checkpoint: RunCheckpoint): Promise<void> {
    const existing = await this.memory.getThread(checkpoint.threadId);
    if (!existing.success) throw new Error(existing.error);
    if (!existing.data) {
      const created = await this.memory.createThread(
        checkpoint.agentId,
        {
          agentId: checkpoint.agentId,
          ...(checkpoint.userId !== undefined && { userId: checkpoint.userId }),
        },
        checkpoint.threadId
      );
      if (!created.success) throw new Error(created.error);
    }
    const updated = await this.memory.updateThread(checkpoint.threadId, {
      [PAUSED_RUN_KEY]: checkpoint,
    });
    if (!updated.success) throw new Error(updated.error);
  }

  async load(threadId: string): Promise<RunCheckpoint | null> {
    const thread = await this.memory.getThread(threadId);
    if (!thread.success) throw new Error(thread.error);
    const stored = thread.data?.metadata[PAUSED_RUN_KEY];
    return isCheckpoint(stored) ? stored : null;
  }

  async delete(threadId: string): Promise<void> {
    const thread = await this.memory.getThread(threadId);
    if (!thread.success) throw new Error(thread.error);
    if (thread.data?.metadata[PAUSED_RUN_KEY] == null) return;
    const updated = await this.memory.updateThread(threadId, { [PAUSED_RUN_KEY]: null });
    if (!updated.success) throw new Error(updated.error);
  }
}

function isCheckpoint(value: unknown): value is RunCheckpoint {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    typeof (value as { threadId?: unknown }).threadId === 'string'
  );
}
