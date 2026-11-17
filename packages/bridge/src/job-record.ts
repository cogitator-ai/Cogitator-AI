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

const JobCheckResultSchema = z.object({
  name: z.string(),
  command: z.string(),
  ok: z.boolean(),
  skipped: z.string().optional(),
  code: z.number().int().nullable().optional(),
  timedOut: z.boolean().optional(),
  durationMs: z.number().nonnegative().optional(),
  output: z.string().optional(),
});

const JobVerificationSchema = z.object({
  verified: z.boolean(),
  checkedAt: z.string(),
  summary: z.string().optional(),
  checks: z.array(JobCheckResultSchema).optional(),
});

const JobChangesSchema = z.object({
  files: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  commits: z.number().int().nonnegative(),
  paths: z.array(z.string()),
  at: z.string(),
});

const JobWorktreeRecordSchema = z.object({
  path: z.string(),
  branch: z.string(),
  base: z.string(),
  end: z
    .object({
      how: z.enum(['accepted', 'branch', 'rejected', 'discarded']),
      at: z.string(),
      commit: z.string().optional(),
      into: z.string().optional(),
      ref: z.string().optional(),
    })
    .optional(),
});

/** The record of a job as it lies in the metadata of its A2A task. */
export const BridgeJobRecordSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  from: z.string(),
  to: z.string(),
  project: z.string(),
  cwd: z.string(),
  isolation: z.literal('worktree').optional(),
  worktree: JobWorktreeRecordSchema.optional(),
  changes: JobChangesSchema.optional(),
  checking: z.object({ letter: z.string(), since: z.string() }).optional(),
  checks: z.array(JobCheckSchema),
  budget: JobBudgetSchema,
  lettersUsed: z.number().int().nonnegative(),
  depth: z.number().int().positive(),
  parent: z.number().int().positive().optional(),
  createdAt: z.string(),
  deadlineAt: z.string(),
  endedAt: z.string().optional(),
  personWaitSince: z.string().optional(),
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
