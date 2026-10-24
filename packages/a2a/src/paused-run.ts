import type { RunCheckpoint } from '@cogitator-ai/types';
import type { A2ATask } from './types.js';

/** Metadata key holding the paused run a task waits on, never sent to clients. */
export const TASK_PAUSED_RUN_KEY = 'cogitator:pausedRun';

/**
 * The paused run a task waits on, as the task manager keeps it to resume exactly that run. It
 * paused in the thread of the task's context.
 */
export interface TaskPausedRun {
  runId: string;
  /** The run's checkpoint, when the Cogitator returned one */
  checkpoint?: RunCheckpoint;
}

/** The paused run a task waits on, or undefined when it waits on none (or predates the record). */
export function taskPausedRun(task: A2ATask): TaskPausedRun | undefined {
  const record = task.metadata?.[TASK_PAUSED_RUN_KEY];
  if (!isRecord(record) || typeof record.runId !== 'string') return undefined;
  return {
    runId: record.runId,
    ...(isRunCheckpoint(record.checkpoint) && { checkpoint: record.checkpoint }),
  };
}

function isRunCheckpoint(value: unknown): value is RunCheckpoint {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.runId === 'string' &&
    typeof value.threadId === 'string' &&
    Array.isArray(value.messages)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
