import type { MemoryAdapter, Thread } from '@cogitator-ai/types';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';

/** The user a thread belongs to: the `userId` of the run that created it. */
export function threadOwner(thread: Thread): string | undefined {
  const owner = thread.metadata?.userId;
  return typeof owner === 'string' ? owner : undefined;
}

/**
 * Checks that `userId` may use thread `threadId`, for code that takes thread
 * ids from clients: a thread is open only to its owner, and one without an
 * owner only to callers without a user.
 *
 * Returns the thread, or `null` when it does not exist yet. Throws
 * `THREAD_ACCESS_DENIED` for another user's thread, and `MEMORY_READ_FAILED`
 * when the thread cannot be read, since its owner is then unknown.
 */
export async function assertThreadAccess(
  memory: MemoryAdapter,
  threadId: string,
  userId: string | undefined
): Promise<Thread | null> {
  const result = await memory.getThread(threadId);
  if (!result.success) {
    throw new CogitatorError({
      message: `Thread ${threadId} could not be read: ${result.error}`,
      code: ErrorCode.MEMORY_READ_FAILED,
    });
  }
  const thread = result.data;
  if (thread && threadOwner(thread) !== userId) {
    throw new CogitatorError({
      message: `Thread ${threadId} belongs to another user`,
      code: ErrorCode.THREAD_ACCESS_DENIED,
    });
  }
  return thread;
}

/**
 * Thread `threadId` for `userId`, checked as in `assertThreadAccess`, and
 * created for them when it does not exist yet.
 */
export async function ensureThreadAccess(
  memory: MemoryAdapter,
  threadId: string,
  owner: { agentId: string; userId?: string }
): Promise<Thread> {
  const existing = await assertThreadAccess(memory, threadId, owner.userId);
  if (existing) return existing;
  const created = await memory.createThread(owner.agentId, threadMetadata(owner), threadId);
  if (!created.success) {
    throw new CogitatorError({
      message: `Thread ${threadId} could not be created: ${created.error}`,
      code: ErrorCode.MEMORY_WRITE_FAILED,
    });
  }
  return created.data;
}

/** Metadata of a new thread: the agent it is for and the user who owns it. */
export function threadMetadata(owner: {
  agentId: string;
  userId?: string;
}): Record<string, unknown> {
  return { agentId: owner.agentId, ...(owner.userId !== undefined && { userId: owner.userId }) };
}
