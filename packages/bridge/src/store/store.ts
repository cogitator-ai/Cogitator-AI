import type { A2ATask, TaskStore } from '@cogitator-ai/a2a';
import type {
  AgentRecord,
  AgentStatus,
  DeliveryState,
  JobState,
  JournalEntry,
  Letter,
  LetterKind,
} from '../types.js';

/** The dispatcher that owns the store: the only process that writes to it. */
export interface Lease {
  pid: number;
  /** Tells one start of a dispatcher from another in the same process id */
  nonce: string;
  /** Where the dispatcher listens */
  socket: string;
  version: string;
  /** Ms since the epoch */
  acquiredAt: number;
  /** Ms since the epoch of the last time the dispatcher said it is alive */
  heartbeatAt: number;
}

export interface LeaseCandidate {
  pid: number;
  nonce: string;
  socket: string;
  version: string;
}

export interface AcquireLeaseOptions {
  now: number;
  /** How old a heartbeat may be for the holder to still count as alive */
  ttlMs: number;
  /** Whether a process still runs, `process.kill(pid, 0)` by default */
  isAlive?: (pid: number) => boolean;
}

export type AcquireLeaseResult =
  { acquired: true; lease: Lease } | { acquired: false; holder: Lease };

export interface AgentFilter {
  project?: string;
  harness?: string;
  statuses?: readonly AgentStatus[];
  /** Agents whose last call to the bridge was before this time, ms since the epoch */
  seenBefore?: number;
}

export interface JobTaskFilter {
  states?: readonly JobState[];
  from?: string;
  to?: string;
  /** Jobs the agent handed over or carries out */
  party?: string;
  project?: string;
  /** Jobs whose deadline is at or before this time, ms since the epoch */
  deadlineBy?: number;
  /** Jobs handed over from inside this job */
  parent?: number;
  /** Jobs created at or after this time, ms since the epoch */
  createdSince?: number;
  limit?: number;
}

export interface LetterFilter {
  job?: number;
  from?: string;
  to?: string;
  states?: readonly DeliveryState[];
  kinds?: readonly LetterKind[];
  /** Letters accepted after this one */
  afterSeq?: number;
  /** Letters an adapter tried to deliver fewer times than this */
  attemptsBelow?: number;
  /** Letters whose recipient had to react at or before this time, ms since the epoch */
  replyDueBy?: number;
  /** Letters that wait for the person, or only those that do not */
  needsPerson?: boolean;
  /** Letters that reply to this one */
  inReplyTo?: string;
  limit?: number;
  /** Newest first instead of oldest first */
  newestFirst?: boolean;
}

export interface JournalQuery {
  afterSeq?: number;
  job?: number;
  limit?: number;
  /** The last entries instead of the first ones, still returned oldest first */
  tail?: number;
}

/** What may change on a letter once it is accepted. */
export type LetterPatch = Partial<
  Pick<
    Letter,
    | 'state'
    | 'deliveredAt'
    | 'readAt'
    | 'handledAt'
    | 'attempts'
    | 'lastError'
    | 'nextAttemptAt'
    | 'replyDueAt'
    | 'remindedAt'
    | 'needsPerson'
    | 'personAskedAt'
  >
> & {
  /** Fields to clear */
  clear?: ReadonlyArray<'lastError' | 'nextAttemptAt' | 'replyDueAt' | 'remindedAt'>;
};

/**
 * Everything the bridge keeps: the A2A tasks under its jobs, letters, the address book and the
 * journal. One dispatcher writes to it, the one holding the lease, anyone may read.
 */
export interface BridgeStore {
  /** The A2A task store a `TaskManager` runs the jobs on */
  readonly tasks: TaskStore;
  /** Whether the store was opened to read only */
  readonly readonly: boolean;

  /**
   * Runs `work` so that everything it writes is kept together or not at all. Transactions do
   * not nest and do not overlap: the caller runs one at a time.
   */
  transaction<T>(work: () => Promise<T>): Promise<T>;

  acquireLease(candidate: LeaseCandidate, options: AcquireLeaseOptions): AcquireLeaseResult;
  /** Records a heartbeat. False when the lease is no longer this one */
  renewLease(nonce: string, now: number): boolean;
  /** Gives the lease up, when it is still this one */
  releaseLease(nonce: string): void;
  readLease(): Lease | undefined;

  /** The next job number: 1, 2, 3 and on, never reused */
  nextJobNumber(): number;
  taskOfJob(number: number): A2ATask | undefined;
  /** The tasks of jobs, newest first */
  jobTasks(filter?: JobTaskFilter): A2ATask[];

  putAgent(agent: AgentRecord): void;
  getAgent(name: string): AgentRecord | undefined;
  agentOfSession(harness: string, sessionId: string): AgentRecord | undefined;
  listAgents(filter?: AgentFilter): AgentRecord[];
  /** Removes the agent `from` and gives its jobs and letters to `to` */
  mergeAgent(from: string, to: string): void;

  insertLetter(letter: Omit<Letter, 'seq'>): Letter;
  getLetter(id: string): Letter | undefined;
  updateLetter(id: string, patch: LetterPatch): Letter;
  listLetters(filter?: LetterFilter): Letter[];
  countLetters(filter?: LetterFilter): number;
  /** The agents that have letters in the queue */
  queuedRecipients(): string[];

  appendJournal(entry: Omit<JournalEntry, 'seq'>): JournalEntry;
  readJournal(query?: JournalQuery): JournalEntry[];

  close(): void;
}
