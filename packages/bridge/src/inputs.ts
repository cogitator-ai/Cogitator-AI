import { z } from 'zod';
import {
  DELIVERY_STATES,
  JOB_STATES,
  JobBudgetSchema,
  JobCheckSchema,
  LETTER_KINDS,
  type JobBudget,
  type JobCheck,
  type LetterKind,
  type ReportOutcome,
} from './types.js';

/** An id a sender may give its letter, so sending it again does not deliver it twice. */
export const LetterIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'A letter id takes letters, digits, ".", "_", ":" and "-"');

const JobNumberSchema = z.number().int().positive();

export const CreateJobInputSchema = z.object({
  to: z.string().trim().min(1).max(512),
  body: z.string().refine((body) => body.trim().length > 0, 'The job needs a description'),
  title: z.string().trim().min(1).max(200).optional(),
  cwd: z.string().min(1).max(4096).optional(),
  worktree: z.string().min(1).max(4096).optional(),
  checks: z.array(JobCheckSchema).max(50).optional(),
  budget: JobBudgetSchema.partial().optional(),
  parent: JobNumberSchema.optional(),
  letterId: LetterIdSchema.optional(),
});

/** What an agent says to hand a job over. */
export interface CreateJobInput {
  /** Who gets the job: an agent's name, or a harness word such as `codex` or `claude:reviewer` */
  to: string;
  /** The job itself: what to do, and what done looks like */
  body: string;
  /** A short name of the job, the first line of the body by default */
  title?: string;
  /** The folder the job is done in, the caller's by default. Relative to the caller's folder */
  cwd?: string;
  worktree?: string;
  checks?: JobCheck[];
  budget?: Partial<JobBudget>;
  /** The job this one is part of, when the caller carries out several */
  parent?: number;
  /** The id of the job's first letter: creating a job with the same id again changes nothing */
  letterId?: string;
}

const SENDABLE_KINDS = LETTER_KINDS.filter((kind) => kind !== 'task') as [
  Exclude<LetterKind, 'task'>,
  ...Exclude<LetterKind, 'task'>[],
];

export const SendLetterInputSchema = z
  .object({
    job: JobNumberSchema,
    kind: z.enum(SENDABLE_KINDS),
    body: z.string().refine((body) => body.trim().length > 0, 'The letter is empty'),
    id: LetterIdSchema.optional(),
    inReplyTo: LetterIdSchema.optional(),
    outcome: z.enum(['completed', 'failed']).optional(),
  })
  .refine((input) => input.outcome === undefined || input.kind === 'report', {
    message: 'Only a report has an outcome',
    path: ['outcome'],
  });

/** A letter on a job that exists. The job's own first letter is written by `createJob`. */
export interface SendLetterInput {
  job: number;
  kind: Exclude<LetterKind, 'task'>;
  body: string;
  /** Sending a letter with the same id again changes nothing */
  id?: string;
  /** The letter this one answers. An `answer` finds the open question itself when there is one */
  inReplyTo?: string;
  /** Of a report: `completed` by default */
  outcome?: ReportOutcome;
}

export const InboxInputSchema = z.object({
  job: JobNumberSchema.optional(),
  peek: z.boolean().optional(),
  unhandled: z.boolean().optional(),
});

export interface InboxInput {
  /** Only the letters of one job */
  job?: number;
  /** Look without taking: the letters stay as they are */
  peek?: boolean;
  /** Also the letters taken before and not answered or dismissed since */
  unhandled?: boolean;
}

export const JobsFilterSchema = z.object({
  states: z.array(z.enum(JOB_STATES as [string, ...string[]])).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  party: z.string().optional(),
  project: z.string().optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

export const AgentsFilterSchema = z.object({
  project: z.string().optional(),
  harness: z.string().optional(),
  statuses: z.array(z.enum(['starting', 'active', 'gone'])).optional(),
});

export const LettersFilterSchema = z.object({
  job: JobNumberSchema.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  states: z.array(z.enum(DELIVERY_STATES as [string, ...string[]])).optional(),
  kinds: z.array(z.enum(LETTER_KINDS as [string, ...string[]])).optional(),
  afterSeq: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(1000).optional(),
  newestFirst: z.boolean().optional(),
});

export const JournalQuerySchema = z.object({
  afterSeq: z.number().int().nonnegative().optional(),
  job: JobNumberSchema.optional(),
  limit: z.number().int().positive().max(5000).optional(),
  tail: z.number().int().positive().max(5000).optional(),
});

export const VerificationInputSchema = z.object({
  verified: z.boolean(),
  summary: z.string().max(20_000).optional(),
});
