import { z } from 'zod';
import { harnessOfAlias } from './registry.js';
import {
  DELIVERY_STATES,
  JOB_STATES,
  JobBudgetSchema,
  JobCheckSchema,
  LETTER_KINDS,
  PermissionAskSchema,
  type BridgeJob,
  type JobBudget,
  type JobCheck,
  type Letter,
  type LetterKind,
  type PermissionAsk,
  type RenderedLetter,
  type ReportOutcome,
  type Verdict,
} from './types.js';

/** An id a sender may give its letter, so sending it again does not deliver it twice. */
export const LetterIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'A letter id takes letters, digits, ".", "_", ":" and "-"');

const JobNumberSchema = z.number().int().positive();

const NO_CONTROL = /^[^\p{Cc}]*$/u;

/**
 * A NUL character cannot be handed to a harness: no command line argument holds one, so a
 * letter with it would never leave the queue.
 */
const withoutNul = (text: string): boolean => !text.includes('\0');
const NUL_REFUSED = 'The text has a NUL character, which no harness takes';

export const CreateJobInputSchema = z.strictObject({
  to: z.string().trim().min(1).max(512).regex(NO_CONTROL, 'An address is one line'),
  body: z
    .string()
    .refine((body) => body.trim().length > 0, 'The job needs a description')
    .refine(withoutNul, NUL_REFUSED),
  title: z.string().trim().min(1).max(200).regex(NO_CONTROL, 'A title is one line').optional(),
  cwd: z.string().min(1).max(4096).optional(),
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
  /**
   * The folder the job is done in, the caller's by default. Relative to the caller's folder,
   * and always inside the caller's project
   */
  cwd?: string;
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
  .strictObject({
    job: JobNumberSchema,
    kind: z.enum(SENDABLE_KINDS),
    body: z
      .string()
      .refine((body) => body.trim().length > 0, 'The letter is empty')
      .refine(withoutNul, NUL_REFUSED),
    id: LetterIdSchema.optional(),
    inReplyTo: LetterIdSchema.optional(),
    outcome: z.enum(['completed', 'failed']).optional(),
    ask: PermissionAskSchema.optional(),
    verdict: z.enum(['allow', 'deny']).optional(),
  })
  .refine((input) => input.outcome === undefined || input.kind === 'report', {
    message: 'Only a report has an outcome',
    path: ['outcome'],
  })
  .refine((input) => input.ask === undefined || input.kind === 'permission', {
    message: 'Only a permission request names a call',
    path: ['ask'],
  })
  .refine((input) => input.verdict === undefined || input.kind === 'answer', {
    message: 'Only an answer carries a verdict',
    path: ['verdict'],
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
  /**
   * Of a permission request: the call leave is asked for. With it the bridge decides who may
   * answer, and the answer comes through `verdict` rather than as mail
   */
  ask?: PermissionAsk;
  /** Of an answer to a permission request that names its call: whether it may go ahead */
  verdict?: Verdict;
}

export interface CreateJobResult {
  job: BridgeJob;
  letter: Letter;
  /** True when the job was created before with the same `letterId`, and nothing changed now */
  duplicate: boolean;
}

export interface SendLetterResult {
  letter: Letter;
  job: BridgeJob;
  /** True when the letter was sent before with the same id, and nothing changed now */
  duplicate: boolean;
}

export const EscalateInputSchema = z
  .strictObject({ letter: LetterIdSchema.optional(), job: JobNumberSchema.optional() })
  .refine((input) => input.letter !== undefined || input.job !== undefined, {
    message: 'Name the letter, or the job it belongs to',
  });

/** A question or a permission request the caller passes on to the person. */
export interface EscalateInput {
  letter?: string;
  /** Instead of the letter: the job, when one letter of it waits for the caller's answer */
  job?: number;
}

export const PersonAnswerInputSchema = z.strictObject({
  letter: LetterIdSchema,
  verdict: z.enum(['allow', 'deny']).optional(),
  body: z
    .string()
    .refine((body) => body.trim().length > 0, 'The answer is empty')
    .refine(withoutNul, NUL_REFUSED)
    .optional(),
});

/** What the person says to a letter that waits for them. */
export interface PersonAnswerInput {
  letter: string;
  /** For a permission request that names its call */
  verdict?: Verdict;
  /** The answer to a question, or the reason of a verdict */
  body?: string;
}

export const StuckInputSchema = z.strictObject({
  what: z.string().trim().min(1).max(2000).refine(withoutNul, NUL_REFUSED),
});

/** A session that waits for a person at its own window, and what it shows them. */
export interface StuckInput {
  /** What the session waits for, in the words of its harness */
  what: string;
}

export const VerdictInputSchema = z.strictObject({
  letter: LetterIdSchema,
  timeoutMs: z.number().int().min(0).max(86_400_000).optional(),
});

export interface VerdictInput {
  /** The permission request the caller sent */
  letter: string;
  /** How long to wait for the decision, 30 s by default, `0` to only look */
  timeoutMs?: number;
}

/** How long `verdict` waits when the call names no time, in ms. */
export const DEFAULT_VERDICT_WAIT_MS = 30_000;

/** Whether a permission request is decided, and how. */
export type VerdictResult =
  | { state: 'waiting' }
  | {
      state: 'decided';
      verdict: Verdict;
      /** What the one who decided said, or why the bridge decided itself */
      reason: string;
      /** The agent that decided, `person`, or `bridge` */
      by: string;
    };

export const WithdrawInputSchema = z.strictObject({ letter: LetterIdSchema });

export interface WithdrawInput {
  /** The permission request the caller sent and waits on no more */
  letter: string;
}

/**
 * How taking a permission request back ended: `withdrawn`, or the decision that was there
 * before the caller gave up, which still holds.
 */
export type WithdrawResult = { state: 'withdrawn' } | Extract<VerdictResult, { state: 'decided' }>;

/** How many letters one call to the inbox returns when it names no limit. */
export const DEFAULT_INBOX_LIMIT = 20;

/** How many jobs, letters or journal entries one call returns when it names no limit. */
export const DEFAULT_LIST_LIMIT = 200;

export const InboxInputSchema = z.strictObject({
  job: JobNumberSchema.optional(),
  peek: z.boolean().optional(),
  unhandled: z.boolean().optional(),
  limit: z.number().int().positive().max(100).optional(),
  afterSeq: z.number().int().nonnegative().optional(),
});

export interface InboxInput {
  /** Only the letters of one job */
  job?: number;
  /** Look without taking: the letters stay as they are */
  peek?: boolean;
  /** Also the letters taken before and not answered or dismissed since */
  unhandled?: boolean;
  /** The most letters to return, 20 by default and 100 at most. The rest wait for the next call */
  limit?: number;
  /** Only letters accepted after this one, to look further than one call returns */
  afterSeq?: number;
}

/** How long a call waits for mail when it names no time. */
export const DEFAULT_WAIT_MS = 10 * 60_000;

/** The longest one call waits for mail. */
export const MAX_WAIT_MS = 24 * 3_600_000;

export const WaitInputSchema = z.strictObject({
  timeoutMs: z.number().int().positive().max(MAX_WAIT_MS).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

export interface WaitInput {
  /** How long to wait for a letter, 10 minutes by default and a day at most */
  timeoutMs?: number;
  /** The most letters to return, 20 by default and 100 at most */
  limit?: number;
}

/**
 * Why a wait ended: `letters` came, the time ran out (`timeout`), another waiter of the same
 * session took its place (`replaced`), or the dispatcher or the connection closed (`closed`)
 */
export type WaitEnd = 'letters' | 'timeout' | 'replaced' | 'closed';

export interface WaitResult {
  /** The letters queued for the session, oldest first. Empty unless `reason` is `letters` */
  letters: RenderedLetter[];
  reason: WaitEnd;
}

export const DeliveredInputSchema = z.strictObject({
  letters: z.array(LetterIdSchema).min(1).max(100),
});

export const JobsFilterSchema = z.strictObject({
  states: z.array(z.enum(JOB_STATES as [string, ...string[]])).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  party: z.string().optional(),
  project: z.string().optional(),
  parent: JobNumberSchema.optional(),
  deadlineBy: z.number().int().nonnegative().optional(),
  createdSince: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

export const AgentsFilterSchema = z.strictObject({
  project: z.string().optional(),
  harness: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .transform((harness) => harnessOfAlias(harness))
    .optional(),
  statuses: z.array(z.enum(['starting', 'active', 'gone'])).optional(),
  seenBefore: z.number().int().nonnegative().optional(),
});

export const LettersFilterSchema = z.strictObject({
  job: JobNumberSchema.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  states: z.array(z.enum(DELIVERY_STATES as [string, ...string[]])).optional(),
  kinds: z.array(z.enum(LETTER_KINDS as [string, ...string[]])).optional(),
  afterSeq: z.number().int().nonnegative().optional(),
  replyDueBy: z.number().int().nonnegative().optional(),
  attemptsBelow: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(1000).optional(),
  newestFirst: z.boolean().optional(),
});

export const JournalQuerySchema = z.strictObject({
  afterSeq: z.number().int().nonnegative().optional(),
  job: JobNumberSchema.optional(),
  limit: z.number().int().positive().max(5000).optional(),
  tail: z.number().int().positive().max(5000).optional(),
});

export const VerificationInputSchema = z.strictObject({
  verified: z.boolean(),
  summary: z.string().max(20_000).optional(),
});
