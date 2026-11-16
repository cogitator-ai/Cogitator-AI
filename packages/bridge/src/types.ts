import { isAbsolute } from 'node:path';
import { z } from 'zod';

/** Metadata key of an A2A task holding the bridge's record of the job. */
export const BRIDGE_JOB_KEY = 'cogitator:bridge';

/** The sender of letters the bridge writes itself: reminders, and news of a job that ended. */
export const BRIDGE_SENDER = 'bridge';

/**
 * The person at the machine, as the sender of an answer they gave. No agent carries this name:
 * a session cannot sign a letter with it
 */
export const PERSON = 'person';

/** Harnesses the bridge knows by name. Any other string names a harness an adapter brings. */
export const HARNESSES = {
  claudeCode: 'claude-code',
  codex: 'codex',
  acp: 'acp',
  cogitator: 'cogitator',
} as const;

/** What an adapter can do with the sessions of its harness. */
export interface AdapterCapabilities {
  /** Starts a session of the harness for a job */
  createSession: boolean;
  /** Wakes an idle session with a letter, without the agent asking for its mail */
  push: boolean;
  /** Reaches a session in the middle of its turn */
  steer: boolean;
  /** The session lives in the harness's own app, where the person sees it and can step in */
  nativeWindow: boolean;
}

export const AdapterCapabilitiesSchema = z.object({
  createSession: z.boolean(),
  push: z.boolean(),
  steer: z.boolean(),
  nativeWindow: z.boolean(),
});

/** What a session without an adapter can do: it reads its mail when it asks for it. */
export const NO_CAPABILITIES: AdapterCapabilities = {
  createSession: false,
  push: false,
  steer: false,
  nativeWindow: false,
};

/** How letters reach a session that has no adapter: it takes them from its inbox itself. */
export const INBOX_DELIVERY = 'inbox';

/**
 * `starting`: the bridge asked an adapter to start the session and waits for its id, `active`:
 * the session is known by its id, `gone`: it is not reached any more, because it could not be
 * started or has not called the bridge for `limits.agentIdleMs`. A session that is gone and calls
 * again is active again, under the same name
 */
export type AgentStatus = 'starting' | 'active' | 'gone';

/** A session of a harness as the bridge's address book keeps it. */
export interface AgentRecord {
  /** The address other agents use, unique in the book: `codex@my-project` */
  name: string;
  harness: string;
  /** The harness's own id of the session, empty while the session is `starting` */
  sessionId: string;
  /** What the person called the session, when the harness tells */
  sessionName?: string;
  /** The root of the project the session works in, an absolute path */
  project: string;
  /** The folder the session runs in, an absolute path */
  cwd: string;
  /** How letters reach it: the adapter's mechanism, or `inbox` when it fetches them itself */
  delivery: string;
  capabilities: AdapterCapabilities;
  status: AgentStatus;
  /** ISO 8601 */
  registeredAt: string;
  /** ISO 8601 time of the last call it made as an agent: a job, a letter, its inbox */
  lastSeenAt: string;
  /**
   * The permission mode the session said it runs in the last time it told: `default`,
   * `acceptEdits`, `plan` and so on, in the words of its harness. Absent for a harness that does
   * not tell
   */
  permissionMode?: string;
}

/** Who calls the bridge, as read from the caller's environment. */
export interface CallerIdentity {
  /** The harness, compared without regard to case: letters, digits, `.`, `_` and `-` */
  harness: string;
  sessionId: string;
  /** The folder the session runs in, an absolute path */
  cwd: string;
  /** The project root, an absolute path, found from `cwd` when absent */
  project?: string;
  sessionName?: string;
  /** The name the bridge gave a session it started, handed to that session in its environment */
  agentName?: string;
  /** The permission mode the session runs in right now, when its harness tells */
  permissionMode?: string;
}

/**
 * The name of a harness: letters, digits, `.`, `_` and `-`, compared without regard to case and
 * kept in lower case. It becomes part of agent names, so it takes nothing else.
 */
export const HarnessNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'A harness name takes letters, digits, ".", "_" and "-"')
  .transform((name) => name.toLowerCase());

const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => isAbsolute(path), 'The path must be absolute');

/** Text a person typed that ends up on one line: no line breaks or other control characters. */
const OneLineSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[^\p{Cc}]*$/u, 'No line breaks or control characters');

export const CallerIdentitySchema = z.strictObject({
  harness: HarnessNameSchema,
  sessionId: OneLineSchema,
  cwd: AbsolutePathSchema,
  project: AbsolutePathSchema.optional(),
  sessionName: OneLineSchema.optional(),
  agentName: OneLineSchema.optional(),
  permissionMode: OneLineSchema.optional(),
});

/**
 * The lifecycle of a job, the states of the A2A task under it: `submitted` (handed over, not
 * picked up yet), `working`, `input-required` (the one doing it asked and waits), and the
 * terminal `completed`, `failed`, `canceled`
 */
export type JobState =
  'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled';

export const JOB_STATES: readonly JobState[] = [
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'canceled',
];

/** A command that shows whether the job's result holds. */
export interface JobCheck {
  name?: string;
  command: string;
  /** Where it runs, the job's folder by default */
  cwd?: string;
  timeoutMs?: number;
}

export const JobCheckSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  command: z.string().trim().min(1).max(4000),
  cwd: z.string().min(1).max(4096).optional(),
  timeoutMs: z.number().int().positive().max(86_400_000).optional(),
});

/** What a job may spend before the bridge fails it. */
export interface JobBudget {
  /** Letters the agents may exchange on the job */
  letters: number;
  /** How long the job may run, in ms from its creation */
  durationMs: number;
  /** How long a letter that needs an answer waits before a reminder, and after it before the job fails */
  replyTimeoutMs: number;
}

export const JobBudgetSchema = z.object({
  letters: z.number().int().positive().max(10_000),
  durationMs: z
    .number()
    .int()
    .positive()
    .max(30 * 86_400_000),
  replyTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(7 * 86_400_000),
});

/** Whether the checks of a job confirmed its result. Absent on a job nobody checked yet. */
export interface JobVerification {
  verified: boolean;
  /** ISO 8601 */
  checkedAt: string;
  /** What the checks showed, in a few lines */
  summary?: string;
}

/** What the bridge keeps about a job in the metadata of its A2A task. */
export interface BridgeJobRecord {
  number: number;
  title: string;
  /** The agent that handed the job over */
  from: string;
  /** The agent that carries it out */
  to: string;
  project: string;
  cwd: string;
  /** The git worktree the job is done in, when the bridge gave it one */
  worktree?: string;
  checks: JobCheck[];
  budget: JobBudget;
  lettersUsed: number;
  /** 1 for a job from a person's session, one more for every job handed over from inside a job */
  depth: number;
  parent?: number;
  /** ISO 8601 time the job was handed over */
  createdAt: string;
  /** ISO 8601 time the job fails at when it is still running */
  deadlineAt: string;
  /** Why the job failed or was canceled */
  reason?: string;
  verification?: JobVerification;
}

/** A job as the bridge reports it: its record and the state of the A2A task under it. */
export interface BridgeJob extends BridgeJobRecord {
  taskId: string;
  state: JobState;
  /** ISO 8601 time of its last change of state */
  updatedAt: string;
}

/** What a call needs leave for, in the terms permission rules are written in. */
export type PermissionAccess = 'command' | 'read' | 'edit' | 'fetch' | 'other';

export const PERMISSION_ACCESSES: readonly PermissionAccess[] = [
  'command',
  'read',
  'edit',
  'fetch',
  'other',
];

/**
 * A call an agent asks leave for, in a form the rules of any harness can judge. What a reader
 * sees is the body of the letter that carries it
 */
export interface PermissionAsk {
  /** The tool as the agent's harness names it: `Bash`, `Edit`, `mcp__github__create_issue` */
  tool: string;
  access: PermissionAccess;
  /** Of a `command`: the command line */
  command?: string;
  /** Of a `command`: the folder it runs in */
  cwd?: string;
  /** Of a `read` or an `edit`: the files, absolute */
  paths?: string[];
  /** Of a `fetch`: the address */
  url?: string;
}

export const PermissionAskSchema = z.strictObject({
  tool: OneLineSchema,
  access: z.enum(['command', 'read', 'edit', 'fetch', 'other']),
  command: z.string().min(1).max(100_000).optional(),
  cwd: AbsolutePathSchema.optional(),
  paths: z.array(AbsolutePathSchema).max(1000).optional(),
  url: z.string().min(1).max(8192).optional(),
});

/** The answer to a permission request. */
export type Verdict = 'allow' | 'deny';

export const VERDICTS: readonly Verdict[] = ['allow', 'deny'];

/**
 * What the rules of the agent that handed a job over say of a call the one carrying it out asks
 * leave for: `allow`, it may do this itself, so the answer is its own to give, `deny`, its rules
 * forbid it, `ask`, it would have to ask the person, so only the person can allow it
 */
export type Rights = 'allow' | 'ask' | 'deny';

/**
 * `task`: the job itself, `question` and `permission`: need an `answer`, `report`: the result
 * that ends the job, `note`: something to know that needs no answer
 */
export type LetterKind = 'task' | 'question' | 'answer' | 'report' | 'note' | 'permission';

export const LETTER_KINDS: readonly LetterKind[] = [
  'task',
  'question',
  'answer',
  'report',
  'note',
  'permission',
];

/**
 * `queued`: the bridge has it, `delivered`: handed to the recipient's harness, `read`: the
 * recipient took it, `handled`: the recipient answered it or said it is done with it. A letter
 * only moves forward
 */
export type DeliveryState = 'queued' | 'delivered' | 'read' | 'handled';

export const DELIVERY_STATES: readonly DeliveryState[] = ['queued', 'delivered', 'read', 'handled'];

/** How a report ends its job. */
export type ReportOutcome = 'completed' | 'failed';

export interface Letter {
  id: string;
  /** Its place in the order letters were accepted in */
  seq: number;
  job: number;
  kind: LetterKind;
  /** The agent that wrote it, or `bridge` */
  from: string;
  to: string;
  body: string;
  /** The letter it answers */
  inReplyTo?: string;
  /** Of a `report`: how it ends the job */
  outcome?: ReportOutcome;
  /** Of a `permission`: the call leave is asked for, when the request names one */
  ask?: PermissionAsk;
  /** Of an `answer` to a `permission` that names its call: whether it may go ahead */
  verdict?: Verdict;
  /** The answer is the person's to give, not the recipient's */
  needsPerson?: boolean;
  /** ISO 8601 time the letter began to wait for the person */
  personAskedAt?: string;
  state: DeliveryState;
  /** ISO 8601 */
  createdAt: string;
  deliveredAt?: string;
  readAt?: string;
  handledAt?: string;
  /** How many times an adapter tried to deliver it */
  attempts: number;
  /** Why the last attempt failed */
  lastError?: string;
  /** ISO 8601 time of the next attempt, absent when none is planned */
  nextAttemptAt?: string;
  /** ISO 8601 time the recipient must have reacted by, absent when nothing is expected */
  replyDueAt?: string;
  /** ISO 8601 time the recipient was reminded of it */
  remindedAt?: string;
}

/** A letter with the text its recipient sees: the signature line, then the body. */
export interface RenderedLetter extends Letter {
  text: string;
}

export type JournalEntryType =
  | 'agent.registered'
  | 'agent.gone'
  | 'job.created'
  | 'job.state'
  | 'job.verified'
  | 'letter.queued'
  | 'letter.delivered'
  | 'letter.read'
  | 'letter.handled'
  | 'letter.rejected'
  | 'letter.undelivered'
  | 'letter.reminded'
  | 'letter.escalated';

/** One line of the bridge's append-only journal. */
export interface JournalEntry {
  seq: number;
  /** ISO 8601 */
  at: string;
  type: JournalEntryType;
  job?: number;
  letter?: string;
  agent?: string;
  data?: Record<string, unknown>;
}

/** The limits the bridge applies to every job, each overridable per dispatcher. */
export interface BridgeLimits {
  /** How deep jobs may nest: a job, a job handed over from it, and so on */
  maxDepth: number;
  /** The budget of a job that names none */
  budget: JobBudget;
  /** The most a job may ask for */
  maxBudget: JobBudget;
  /** How many times an adapter tries a letter before the bridge leaves it for the inbox */
  deliveryAttempts: number;
  /** The wait before the second attempt, doubled for each one after, in ms */
  deliveryBackoffMs: number;
  /** The longest wait between attempts, in ms */
  deliveryBackoffMaxMs: number;
  /** How long an adapter may take to hand one letter over before the attempt counts as failed, in ms */
  deliveryTimeoutMs: number;
  /** How long an adapter may take to start a session, in ms */
  sessionStartTimeoutMs: number;
  /** The longest letter body, in characters */
  maxBodyLength: number;
  /**
   * How long a session may stay silent before the bridge takes it for gone, in ms. A session
   * with a job in progress is never taken for gone
   */
  agentIdleMs: number;
  /** How many jobs an agent may have handed over that are still in progress */
  maxOpenJobs: number;
  /** How many jobs an agent may hand over in an hour */
  jobsPerHour: number;
  /** How many sessions adapters may be starting at once */
  maxStartingSessions: number;
  /** How often adapters that can list their sessions are asked which of them still run */
  presenceCheckMs: number;
  /**
   * How long a letter waits for the person before they are reminded, and after that before the
   * job fails, in ms. A person is slower than an agent, so it is longer than the job's own
   * `replyTimeoutMs`
   */
  personReplyTimeoutMs: number;
}

export const BridgeLimitsSchema = z.strictObject({
  maxDepth: z.number().int().min(1).max(100),
  budget: JobBudgetSchema,
  maxBudget: JobBudgetSchema,
  deliveryAttempts: z.number().int().min(1).max(1000),
  deliveryBackoffMs: z.number().int().min(0).max(86_400_000),
  deliveryBackoffMaxMs: z.number().int().min(0).max(86_400_000),
  deliveryTimeoutMs: z.number().int().positive().max(3_600_000),
  sessionStartTimeoutMs: z.number().int().positive().max(3_600_000),
  maxBodyLength: z.number().int().positive().max(1_000_000),
  agentIdleMs: z
    .number()
    .int()
    .positive()
    .max(365 * 86_400_000),
  maxOpenJobs: z.number().int().positive().max(10_000),
  jobsPerHour: z.number().int().positive().max(100_000),
  maxStartingSessions: z.number().int().positive().max(100),
  presenceCheckMs: z.number().int().positive().max(86_400_000),
  personReplyTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(7 * 86_400_000),
});

export const DEFAULT_LIMITS: BridgeLimits = {
  maxDepth: 3,
  budget: { letters: 60, durationMs: 4 * 3_600_000, replyTimeoutMs: 30 * 60_000 },
  maxBudget: { letters: 500, durationMs: 24 * 3_600_000, replyTimeoutMs: 6 * 3_600_000 },
  deliveryAttempts: 5,
  deliveryBackoffMs: 2_000,
  deliveryBackoffMaxMs: 60_000,
  deliveryTimeoutMs: 60_000,
  sessionStartTimeoutMs: 180_000,
  maxBodyLength: 200_000,
  agentIdleMs: 12 * 3_600_000,
  maxOpenJobs: 20,
  jobsPerHour: 60,
  maxStartingSessions: 2,
  presenceCheckMs: 60_000,
  personReplyTimeoutMs: 4 * 3_600_000,
};
