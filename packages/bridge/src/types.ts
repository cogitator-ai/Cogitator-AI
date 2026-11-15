import { z } from 'zod';

/** Metadata key of an A2A task holding the bridge's record of the job. */
export const BRIDGE_JOB_KEY = 'cogitator:bridge';

/** The sender of letters the bridge writes itself: reminders, and news of a job that ended. */
export const BRIDGE_SENDER = 'bridge';

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
  /** The session lives in the vendor's own window, on the vendor's own subscription */
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
 * the session is known by its id, `gone`: it cannot be reached any more
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
  /** ISO 8601 time of its last call to the bridge */
  lastSeenAt: string;
}

/** Who calls the bridge, as read from the caller's environment. */
export interface CallerIdentity {
  harness: string;
  sessionId: string;
  cwd: string;
  /** The project root, found from `cwd` when absent */
  project?: string;
  sessionName?: string;
  /** The name the bridge gave a session it started, handed to that session in its environment */
  agentName?: string;
}

export const CallerIdentitySchema = z.object({
  harness: z.string().trim().min(1).max(64),
  sessionId: z.string().trim().min(1).max(256),
  cwd: z.string().min(1).max(4096),
  project: z.string().min(1).max(4096).optional(),
  sessionName: z.string().trim().min(1).max(256).optional(),
  agentName: z.string().trim().min(1).max(256).optional(),
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
  worktree?: string;
  checks: JobCheck[];
  budget: JobBudget;
  lettersUsed: number;
  /** 1 for a job from a person's session, one more for every job handed over from inside a job */
  depth: number;
  parent?: number;
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
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 */
  updatedAt: string;
}

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
  | 'letter.reminded';

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
  /** The longest letter body, in characters */
  maxBodyLength: number;
}

export const DEFAULT_LIMITS: BridgeLimits = {
  maxDepth: 3,
  budget: { letters: 60, durationMs: 4 * 3_600_000, replyTimeoutMs: 30 * 60_000 },
  maxBudget: { letters: 500, durationMs: 24 * 3_600_000, replyTimeoutMs: 6 * 3_600_000 },
  deliveryAttempts: 5,
  deliveryBackoffMs: 2_000,
  deliveryBackoffMaxMs: 60_000,
  maxBodyLength: 200_000,
};

/** A letter on its way to a session, as an adapter gets it. */
export interface LetterDelivery {
  agent: AgentRecord;
  letter: RenderedLetter;
  job: BridgeJob;
}

/** What the bridge asks of an adapter that starts a session for a job. */
export interface SessionRequest {
  /** The name the bridge gave the session, to hand to it as `COGITATOR_BRIDGE_AGENT` */
  agentName: string;
  harness: string;
  project: string;
  cwd: string;
  sessionName?: string;
  job: BridgeJob;
  /** The job's first letter, for a harness that takes the first message when it starts a session */
  firstLetter: RenderedLetter;
}

export interface CreatedSession {
  sessionId: string;
  sessionName?: string;
  /** Whether the session got `firstLetter` when it started, so the bridge does not deliver it again */
  deliveredFirstLetter?: boolean;
}

/**
 * How the bridge reaches the sessions of one harness. Without an adapter a session still takes
 * part: it reads its inbox whenever it calls the bridge.
 */
export interface BridgeAdapter {
  readonly harness: string;
  /** The mechanism letters travel by, recorded with every session of the harness */
  readonly delivery: string;
  readonly capabilities: AdapterCapabilities;
  /** Hands the letter to the session. Rejects when it could not, and the bridge tries again */
  deliver(delivery: LetterDelivery): Promise<void>;
  /** Starts a session for a job. Present when `capabilities.createSession` is true */
  createSession?(request: SessionRequest): Promise<CreatedSession>;
}
