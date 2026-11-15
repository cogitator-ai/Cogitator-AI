import { z } from 'zod';
import type { A2ATask } from '@cogitator-ai/a2a';
import { taskTime } from '@cogitator-ai/a2a';
import {
  BRIDGE_JOB_KEY,
  JOB_STATES,
  JobBudgetSchema,
  JobCheckSchema,
  type BridgeJob,
  type BridgeJobRecord,
  type JobState,
} from './types.js';

const JobVerificationSchema = z.object({
  verified: z.boolean(),
  checkedAt: z.string(),
  summary: z.string().optional(),
});

/** The record of a job as it lies in the metadata of its A2A task. */
export const BridgeJobRecordSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  from: z.string(),
  to: z.string(),
  project: z.string(),
  cwd: z.string(),
  worktree: z.string().optional(),
  checks: z.array(JobCheckSchema),
  budget: JobBudgetSchema,
  lettersUsed: z.number().int().nonnegative(),
  depth: z.number().int().positive(),
  parent: z.number().int().positive().optional(),
  createdAt: z.string(),
  deadlineAt: z.string(),
  reason: z.string().optional(),
  verification: JobVerificationSchema.optional(),
});

/** The bridge's record of the job a task is, or undefined for a task that is not a job. */
export function jobRecordOf(task: Pick<A2ATask, 'metadata'>): BridgeJobRecord | undefined {
  const raw = task.metadata?.[BRIDGE_JOB_KEY];
  if (raw === undefined) return undefined;
  const parsed = BridgeJobRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function isJobState(state: string): state is JobState {
  return (JOB_STATES as readonly string[]).includes(state);
}

/**
 * The state of a job from the state of its task. A task of the bridge only takes the states of
 * {@link JobState}: `rejected` and anything else a foreign writer left read as `failed`, and a
 * task waiting for credentials (`auth-required`) as waiting for input.
 */
export function jobStateOf(task: Pick<A2ATask, 'status'>): JobState {
  const state = task.status.state;
  if (isJobState(state)) return state;
  return state === 'auth-required' ? 'input-required' : 'failed';
}

/** The job a task is, or undefined for a task that is not a job. */
export function jobOf(task: A2ATask): BridgeJob | undefined {
  const record = jobRecordOf(task);
  if (!record) return undefined;
  return {
    ...record,
    taskId: task.id,
    state: jobStateOf(task),
    updatedAt: new Date(taskTime(task)).toISOString(),
  };
}

export function isFinishedJobState(state: JobState): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled';
}
