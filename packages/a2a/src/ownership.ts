import type { A2ATask } from './types.js';

/** Metadata key holding the user a task belongs to; never sent to clients. */
export const TASK_OWNER_KEY = 'cogitator:owner';

/** The user a task belongs to, or undefined for a task without an owner. */
export function taskOwner(task: A2ATask): string | undefined {
  const owner = task.metadata?.[TASK_OWNER_KEY];
  return typeof owner === 'string' ? owner : undefined;
}

/**
 * Whether a caller may see a task: its own, and any task without an owner.
 * `userId` null or undefined stands for a caller without a user.
 */
export function isTaskVisibleTo(task: A2ATask, userId: string | null | undefined): boolean {
  const owner = taskOwner(task);
  return owner === undefined || owner === userId;
}

/** The task as a client receives it: without the internal owner key. */
export function publicTask(task: A2ATask): A2ATask {
  if (!task.metadata || !(TASK_OWNER_KEY in task.metadata)) return task;
  const { [TASK_OWNER_KEY]: _owner, ...metadata } = task.metadata;
  return Object.keys(metadata).length > 0 ? { ...task, metadata } : withoutMetadata(task);
}

function withoutMetadata(task: A2ATask): A2ATask {
  const { metadata: _metadata, ...rest } = task;
  return rest;
}
