import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import type { z } from 'zod';
import { TaskManager, textPart, toMessage, type A2ATask } from '@cogitator-ai/a2a';
import { MAX_RECALL_LIMIT, type BoardFact, type FactBoard, type NewBoardFact } from './board.js';
import { runCheck, skippedCheck, summarizeChecks } from './checks.js';
import { BridgeError } from './errors.js';
import {
  deliveryBackoff,
  exhaustedBudget,
  formatDuration,
  nextDepth,
  resolveBudget,
  resolveLimits,
  type BridgeLimitsInput,
} from './guards.js';
import {
  AgentsFilterSchema,
  CreateJobInputSchema,
  DEFAULT_INBOX_LIMIT,
  DEFAULT_LIST_LIMIT,
  DEFAULT_VERDICT_WAIT_MS,
  DEFAULT_WAIT_MS,
  DeliveredInputSchema,
  EscalateInputSchema,
  InboxInputSchema,
  JobsFilterSchema,
  JournalQuerySchema,
  LettersFilterSchema,
  PersonAnswerInputSchema,
  SendLetterInputSchema,
  StuckInputSchema,
  VerdictInputSchema,
  VerificationInputSchema,
  AcceptInputSchema,
  DiffInputSchema,
  ForgetInputSchema,
  RecallInputSchema,
  RejectInputSchema,
  RememberInputSchema,
  ResultsInputSchema,
  SuggestInputSchema,
  WaitInputSchema,
  WithdrawInputSchema,
  type AcceptInput,
  type AcceptResult,
  type CreateJobInput,
  type DiffInput,
  type ForgetInput,
  type JobDiff,
  type RecallInput,
  type RejectInput,
  type RememberInput,
  type ResultsInput,
  type SuggestInput,
  type CreateJobResult,
  type EscalateInput,
  type InboxInput,
  type PersonAnswerInput,
  type SendLetterInput,
  type SendLetterResult,
  type StuckInput,
  type VerdictInput,
  type VerdictResult,
  type WaitEnd,
  type WaitInput,
  type WaitResult,
  type WithdrawInput,
  type WithdrawResult,
} from './inputs.js';
import { parseFindings, type Finding } from './findings.js';
import { HANDOVER_GAP, buildHandover } from './handover.js';
import { isFinishedJobState, jobOf, jobRecordOf } from './job-record.js';
import {
  expectationOf,
  forHistory,
  newLetterId,
  normalizeBody,
  oneLine,
  quoted,
  renderLetter,
  repeats,
  titleOf,
} from './letters.js';
import { canonicalPath, findCheckoutRoot, findProjectRoot, inCheckout, isInside } from './paths.js';
import {
  DISCARDED_REFS,
  GitError,
  addJobWorktree,
  branchTip,
  busyWith,
  changesOf,
  checkoutOf,
  conflictsOf,
  patchOf,
  pointRef,
  removeJobWorktree,
  shownPath,
  snapshotOf,
  squashInto,
  type WorktreeChanges,
} from './worktree.js';
import {
  AUTO_ADDRESS,
  NEW_SESSION,
  aliasOfHarness,
  allocateAgentName,
  autoAddressOf,
  resolveAddress,
  type AddressResolution,
  type ResolveAddressContext,
} from './registry.js';
import { resultOf, suggestFrom, type JobResult, type Suggestion } from './scoreboard.js';
import type {
  AgentFilter,
  BridgeStore,
  JobTaskFilter,
  JournalQuery,
  LetterFilter,
} from './store/store.js';
import {
  BRIDGE_JOB_KEY,
  BRIDGE_SENDER,
  CallerIdentitySchema,
  DEFAULT_LIMITS,
  HarnessNameSchema,
  INBOX_DELIVERY,
  NO_CAPABILITIES,
  PERSON,
  type AgentRecord,
  type BridgeJob,
  type BridgeJobRecord,
  type BridgeLimits,
  type CallerIdentity,
  type DeliveryState,
  type JobChanges,
  type JobCheckResult,
  type JobFailure,
  type JobRecipe,
  type JobReview,
  type JobState,
  type JobVerification,
  type JobWorktreeEnd,
  type JobWorktreeRecord,
  type JournalEntry,
  type Letter,
  type LetterKind,
  type PermissionAsk,
  type RenderedLetter,
  type Rights,
} from './types.js';
import type { BridgeAdapter, BridgeCalls, CreatedSession } from './adapter.js';
import type {
  PersonCalls,
  PersonLetter,
  PersonNotice,
  PersonRoute,
  RightsJudge,
} from './person.js';

export interface BridgeDispatcherOptions {
  store: BridgeStore;
  /** How the bridge reaches the sessions of each harness. A harness without one reads its inbox */
  adapters?: readonly BridgeAdapter[];
  limits?: BridgeLimitsInput;
  /**
   * What the rules of the agent that handed a job over say of a call the one carrying it out
   * asks leave for. Without it every such call is the person's to decide
   */
  rights?: RightsJudge;
  /**
   * How a letter that waits for the person reaches them. Without it nothing can be passed on to
   * the person, and a call only they could allow is refused
   */
  person?: PersonRoute;
  /**
   * The board of facts agents and the person share, such as `memoryBoard()` of
   * `@cogitator-ai/bridge/memory`. Without it nothing is remembered, and a job is handed over
   * with what its caller named alone
   */
  board?: FactBoard;
  /** Ms since the epoch, `Date.now` by default */
  now?: () => number;
  /** The id of a letter whose sender gave none */
  newLetterId?: () => string;
  /** Hears what went wrong outside a call: a delivery or a session start that threw */
  onError?: (error: Error) => void;
  /**
   * Called inside every transaction before anything is written, to throw when this dispatcher
   * may not write any more: the host checks its lease here, so a dispatcher that was replaced
   * while its process slept writes nothing after it wakes
   */
  assertWritable?: () => void;
}

export type { CreateJobResult, SendLetterResult } from './inputs.js';

export interface SweepResult {
  /** Jobs failed for running out of time or for a letter nobody reacted to */
  failed: number[];
  /** Letters whose recipient was reminded */
  reminded: string[];
}

export interface DispatcherStatus {
  agents: number;
  activeJobs: number;
  queuedLetters: number;
  /** The harnesses the dispatcher has an adapter for */
  adapters: string[];
  /** The harnesses it can start a session of, for a job handed to one that has none */
  startable: string[];
  /** The agents with a waiter armed: a letter for one of them wakes its session at once */
  waiting: string[];
}

export interface BridgeDispatcherEvents {
  /** Every entry of the journal, once what it tells is stored */
  journal: [JournalEntry];
}

const ACTIVE_JOB_STATES: readonly JobState[] = ['submitted', 'working', 'input-required'];
const FINISHED_JOB_STATES: readonly JobState[] = ['completed', 'failed', 'canceled'];

/** How often the worktrees of finished jobs are looked at for those nobody came for, in ms. */
const WORKTREE_SWEEP_MS = 3_600_000;

/** How many changed files the record of a job names. */
const PATHS_KEPT = 50;

const ENDED: Readonly<Record<JobWorktreeEnd['how'], string>> = {
  accepted: 'taken',
  branch: 'left as a branch',
  rejected: 'dropped',
  discarded: 'put away',
};

/** What a job changed, as its record keeps it. */
function summaryOf(changes: WorktreeChanges, at: string): JobChanges {
  return {
    files: changes.files.length,
    insertions: changes.insertions,
    deletions: changes.deletions,
    commits: changes.commits,
    paths: changes.files.slice(0, PATHS_KEPT).map((file) => shownPath(file.path)),
    at,
  };
}

/** The folder a job is done in: the caller's, or the one it names from there. */
function jobFolder(from: Pick<AgentRecord, 'cwd'>, named: string | undefined): string {
  if (!named) return from.cwd;
  return canonicalPath(isAbsolute(named) ? named : resolvePath(from.cwd, named));
}

/** How much of a job's text the board is asked about. */
const ABOUT_CHARS = 4_000;

/** How many notes of earlier jobs the handover of a job looks at. */
const EARLIER_NOTES = 6;

/**
 * What earlier jobs like this one left on the board: the lessons and outcomes that fit its
 * text, and the other lessons of the jobs those belong to, since a job is found by what it was
 * about and its lessons are worded as they are. Lessons come before outcomes.
 */
async function earlierLike(board: FactBoard, project: string, about: string): Promise<BoardFact[]> {
  const fitting = await board.recall({
    project,
    text: about,
    kinds: ['lesson', 'outcome'],
    limit: EARLIER_NOTES,
  });
  const jobs = new Set(fitting.flatMap((note) => note.source.job ?? []));
  const lessons =
    jobs.size === 0
      ? []
      : (await board.recall({ project, kinds: ['lesson'], limit: MAX_RECALL_LIMIT })).filter(
          (note) => note.source.job !== undefined && jobs.has(note.source.job)
        );
  const seen = new Set<string>();
  return [...lessons, ...fitting]
    .filter((note) => !seen.has(note.id) && seen.add(note.id))
    .sort((a, b) => Number(a.kind === 'outcome') - Number(b.kind === 'outcome'))
    .slice(0, EARLIER_NOTES);
}

/** How much of a report the note of a job's outcome repeats. */
const REPORT_NOTED = 300;

/** How a job ended, in one line for the board. */
function outcomeText(job: BridgeJob, reported: string | undefined): string {
  const checked = job.verification
    ? job.verification.verified
      ? ', and its checks confirmed the result'
      : ', but its checks did not confirm the result'
    : '';
  const how =
    job.state === 'completed'
      ? `completed${checked}`
      : `${job.state}${job.reason ? ` (${oneLine(job.reason)})` : ''}`;
  const quote = (text: string): string => oneLine(text).replaceAll('"', "'");
  const said = reported ? quote(reported) : '';
  const report = said
    ? ` Its report began: "${said.length > REPORT_NOTED ? `${said.slice(0, REPORT_NOTED)}...` : said}"`
    : '';
  return `Job #${job.number} "${quote(job.title)}", done by ${job.to} for ${job.from}: ${how}.${report}`;
}

/** What git said when it refused, as an error an agent can act on. */
function gitRefusal(error: unknown, what: string): BridgeError {
  if (error instanceof BridgeError) return error;
  const said = error instanceof GitError ? error.said : asError(error).message;
  return new BridgeError('invalid_input', `${what}: ${oneLine(said)}`);
}
const UNREAD_STATES: readonly DeliveryState[] = ['queued', 'delivered'];
const NEEDS_ANSWER: readonly LetterKind[] = ['question', 'permission'];
const REMINDER_QUOTE_LENGTH = 500;

/**
 * The most characters of letter text one answer carries. A line of the socket holds 16 MiB, and
 * an answer that does not fit would be lost after the call already changed what it returned
 */
const MAX_ANSWER_CHARS = 2_000_000;

/** Why a job that passed its deadline failed, with the time it really had. */
function ranOutOfTime(
  job: Pick<BridgeJob, 'createdAt' | 'deadlineAt' | 'budget' | 'parent'>
): string {
  const had = Date.parse(job.deadlineAt) - Date.parse(job.createdAt);
  return had < job.budget.durationMs && job.parent !== undefined
    ? `it ran longer than the ${formatDuration(had)} that job #${job.parent}, which it is part of, had left`
    : `it ran longer than its ${formatDuration(job.budget.durationMs)} budget`;
}

/**
 * As many of `items`, in order, as fit `budget` characters by `sizeOf`. The first one is taken
 * even when it alone is over the budget, unless `orNone` says an empty answer is fine.
 */
function fitting<T>(
  items: readonly T[],
  sizeOf: (item: T) => number,
  budget: number = MAX_ANSWER_CHARS,
  orNone = false
): T[] {
  const taken: T[] = [];
  let size = 0;
  for (const item of items) {
    size += sizeOf(item);
    if ((taken.length > 0 || orNone) && size > budget) break;
    taken.push(item);
  }
  return taken;
}

const STATE_RANK: Readonly<Record<DeliveryState, number>> = {
  held: -1,
  queued: 0,
  delivered: 1,
  read: 2,
  handled: 3,
};

/** What a call wrote that only counts once it is stored. */
/** Who holds a letter right now, see `BridgeDispatcher.inHand`. */
interface Held {
  agent: string;
  /** Ms since the epoch after which the letter is free again whatever happened to its holder */
  until: number;
  /** An adapter is pushing it, rather than a waiter holding it */
  pushing?: boolean;
}

/** What a harness said of its sessions, check after check. */
interface Presence {
  /** The sessions it listed the last time */
  live: Set<string>;
  /** Every session it ever listed */
  seen: Set<string>;
  /** The sessions that were listed before and were missing the last time */
  missed: Set<string>;
  /** The sessions it listed as in the middle of a turn the last time */
  busy: Set<string>;
}

/** A process of a session waiting for its mail, see `BridgeDispatcher.wait`. */
interface Waiter {
  /** The most letters it takes at once */
  limit: number;
  /** Aborts when the waiter's connection closes */
  signal: AbortSignal | undefined;
  /** When it began to wait, ms since the epoch */
  armedAt: number;
  /** Ends the wait. Ending it again changes nothing */
  end(reason: WaitEnd, letters?: RenderedLetter[]): void;
}

interface Transaction {
  entries: JournalEntry[];
  /** Agents with new mail */
  wake: Set<string>;
  spawns: Array<{ agent: string; job: number; letter: string }>;
  /** Letters the person is to be told of, `again` for a reminder */
  asked: Array<{ letter: string; again: boolean }>;
  /** Letters that waited for the person and wait no more */
  settled: string[];
  /** Permission requests that got their verdict */
  decided: Set<string>;
  /** What the person is to know that takes no answer */
  notices: PersonNotice[];
  /** Jobs whose checks are to run */
  checks: number[];
  /** What is to go on the board once the call is stored */
  notes: NewBoardFact[];
}

/** A call the bridge refuses after writing down why: what it wrote stays, the caller gets the error. */
class Refusal {
  constructor(readonly error: BridgeError) {}
}

function parse<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  what: string
): z.output<Schema> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  throw new BridgeError('invalid_input', `${what}: ${path}${issue.message}`);
}

function userMessage(text: string) {
  return toMessage({ role: 'user', parts: [textPart(text)] });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** The ids the conductor of a recipe gives the letters it writes. */
const RECIPE_LETTER_ID = /^(recipe|relay)-/;

/** How many finished jobs the scoreboard reads, the newest: more than a machine ends in its window. */
const SCORED_JOBS = 5_000;

/** How many reviews of its work the record of a job keeps, the first ones. */
const REVIEWS_KEPT = 20;

/** What `auto` goes by for one job, see `BridgeDispatcher.choiceFor`. */
interface AutoChoice {
  suggestion: Suggestion;
  /** The agents of the caller's project that would not wake for a letter */
  asleep: ReadonlySet<string>;
}

const NO_CONDUCTOR =
  'This bridge carries out no recipes: its host gave it no conductor (recipeAdapter of @cogitator-ai/bridge/recipes)';

/** `work`, or a rejection when it takes longer than `ms`. */
function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(asError(error));
      }
    );
  });
}

/**
 * The bridge itself: it keeps jobs, letters and the address book, decides who a letter is for,
 * applies the limits and hands letters to the adapters of the harnesses. It never calls a model
 * and never waits for an agent: every call answers at once, and whatever comes later arrives as
 * a letter.
 *
 * One dispatcher runs per machine. Calls are handled one at a time, each in a transaction of the
 * store, so a call either leaves everything it did or nothing.
 *
 * @example
 * ```ts
 * const store = await SqliteBridgeStore.open(':memory:');
 * const bridge = new BridgeDispatcher({ store });
 * const claude = await bridge.register({ harness: 'claude-code', sessionId: 'a', cwd: '/work/app' });
 * const codex = await bridge.register({ harness: 'codex', sessionId: 'b', cwd: '/work/app' });
 *
 * const { job } = await bridge.createJob(claude.name, { to: 'codex', body: 'Write the tests' });
 * const [task] = await bridge.inbox(codex.name);
 * await bridge.send(codex.name, { job: job.number, kind: 'report', body: 'Done: 14 tests' });
 * ```
 */
export class BridgeDispatcher
  extends EventEmitter<BridgeDispatcherEvents>
  implements BridgeCalls, PersonCalls
{
  readonly limits: BridgeLimits;
  private readonly store: BridgeStore;
  private readonly tasks: TaskManager;
  private readonly adapters = new Map<string, BridgeAdapter>();
  private readonly now: () => number;
  private readonly letterId: () => string;
  private readonly onError: (error: Error) => void;
  private readonly assertWritable: (() => void) | undefined;
  private readonly rights: RightsJudge | undefined;
  private readonly person: PersonRoute | undefined;
  private readonly board: FactBoard | undefined;
  /** When each agent's other parties were last told it waits at its window, see `stuck` */
  private readonly stuckTold = new Map<string, number>();
  /** The agents a listing of their harness showed waiting at their window, until it shows them not */
  private readonly stuckNow = new Set<string>();
  /** Those waiting for the verdict of a permission request, by its id, see `verdict` */
  private readonly verdictWaiters = new Map<string, Set<() => void>>();
  /** What the person route is told, one thing after another */
  private personNews: Promise<void> = Promise.resolve();
  /** The checks that run or wait their turn, by job, each with what stops it */
  private readonly checkRuns = new Map<number, AbortController>();
  /** The checks of one job after those of another: they build and test, and memory is short */
  private checkQueue: Promise<void> = Promise.resolve();
  /** The last work on each checkout something is being brought into, see `oneAtATimeIn` */
  private readonly checkouts = new Map<string, Promise<void>>();
  /** Jobs whose worktree is being taken, dropped or put away right now */
  private readonly taking = new Set<number>();
  /** Whether what a dispatcher before this one left unfinished was picked up */
  private recovered = false;
  private worktreesSweptAt = Number.NEGATIVE_INFINITY;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly deliveries = new Map<string, Promise<void>>();
  private readonly background = new Set<Promise<void>>();
  /**
   * Agents whose session an adapter is starting right now. Nothing is pushed to them until the
   * adapter reports back, since it may have handed the job's first letter over itself
   */
  private readonly starting = new Set<string>();
  /** The waiter of each agent that has one, see `wait` */
  private readonly waiters = new Map<string, Waiter>();
  /**
   * Letters somebody holds right now: a waiter that has not confirmed them yet, or an adapter in
   * the middle of pushing one. Nobody else is given a letter in hand, so a session reached two
   * ways does not get it twice
   */
  private readonly inHand = new Map<string, Held>();
  /** What each harness with an adapter that lists its sessions said of them, see `checkPresence` */
  private readonly presence = new Map<string, Presence>();
  private readonly listing = new Set<string>();
  private presenceCheckedAt = Number.NEGATIVE_INFINITY;
  /** Set once `close` was called: nothing new is delivered, what runs is waited for */
  private closing = false;
  private closed = false;

  constructor(options: BridgeDispatcherOptions) {
    super();
    this.store = options.store;
    this.tasks = new TaskManager({ taskStore: options.store.tasks });
    this.limits = resolveLimits(DEFAULT_LIMITS, options.limits);
    this.now = options.now ?? Date.now;
    this.letterId = options.newLetterId ?? newLetterId;
    this.onError = options.onError ?? (() => undefined);
    this.assertWritable = options.assertWritable;
    this.rights = options.rights;
    this.person = options.person;
    this.board = options.board;
    for (const adapter of options.adapters ?? []) {
      const harness = parse(HarnessNameSchema, adapter.harness, 'Cannot use the adapter');
      if (this.adapters.has(harness)) {
        throw new BridgeError('invalid_input', `Two adapters for the harness ${harness}`);
      }
      this.adapters.set(harness, adapter);
    }
    for (const adapter of this.adapters.values()) adapter.attach?.(this);
    this.person?.attach?.(this);
  }

  /**
   * Puts the calling session into the address book, or finds it there. A session is known by
   * its harness and the harness's own id, so calling again from the same session returns the
   * same agent.
   */
  async register(identity: CallerIdentity): Promise<AgentRecord> {
    const caller = parse(CallerIdentitySchema, identity, 'Cannot register the session');
    return this.mutate(async (tx) => {
      const now = this.iso();
      const cwd = canonicalPath(caller.cwd);
      const project = canonicalPath(caller.project ?? findProjectRoot(cwd));
      const adapter = this.adapters.get(caller.harness);
      const reach = {
        delivery: adapter?.delivery ?? INBOX_DELIVERY,
        capabilities: adapter?.capabilities ?? NO_CAPABILITIES,
      };

      const known = this.store.agentOfSession(caller.harness, caller.sessionId);
      if (known) {
        const agent: AgentRecord = {
          ...known,
          ...reach,
          cwd,
          project,
          ...(caller.sessionName && { sessionName: caller.sessionName }),
          ...(caller.permissionMode && { permissionMode: caller.permissionMode }),
          status: 'active',
          lastSeenAt: now,
        };
        this.store.putAgent(agent);
        if (known.status !== 'active') {
          this.journal(tx, {
            type: 'agent.registered',
            agent: agent.name,
            data: { harness: agent.harness, returned: true },
          });
          tx.wake.add(agent.name);
        }
        return agent;
      }

      const started = caller.agentName ? this.store.getAgent(caller.agentName) : undefined;
      if (
        started?.harness === caller.harness &&
        started.status === 'starting' &&
        started.project === project
      ) {
        const agent: AgentRecord = {
          ...started,
          ...reach,
          sessionId: caller.sessionId,
          ...(caller.sessionName && { sessionName: caller.sessionName }),
          ...(caller.permissionMode && { permissionMode: caller.permissionMode }),
          status: 'active',
          lastSeenAt: now,
        };
        this.store.putAgent(agent);
        this.journal(tx, {
          type: 'agent.registered',
          agent: agent.name,
          data: { harness: agent.harness, started: true },
        });
        tx.wake.add(agent.name);
        return agent;
      }

      const agent: AgentRecord = {
        name: allocateAgentName(this.store, caller.harness, project),
        harness: caller.harness,
        sessionId: caller.sessionId,
        ...(caller.sessionName && { sessionName: caller.sessionName }),
        ...(caller.permissionMode && { permissionMode: caller.permissionMode }),
        project,
        cwd,
        ...reach,
        status: 'active',
        registeredAt: now,
        lastSeenAt: now,
      };
      this.store.putAgent(agent);
      this.journal(tx, {
        type: 'agent.registered',
        agent: agent.name,
        data: { harness: agent.harness, project },
      });
      return agent;
    });
  }

  /**
   * Hands a job to another agent and returns at once with its number. The one it is for is
   * found by address, and started when no session fits and the harness's adapter can start one.
   *
   * @throws BridgeError `not_registered`, `unknown_agent`, `ambiguous_agent`, `no_session`,
   * `depth_exceeded`, `invalid_input`
   */
  async createJob(caller: string, input: CreateJobInput): Promise<CreateJobResult> {
    const request = parse(CreateJobInputSchema, input, 'Cannot create the job');
    this.checkBody(request.body);
    const auto = autoAddressOf(request.to);
    if (auto && request.recipe) {
      throw new BridgeError(
        'invalid_input',
        `A recipe goes to the conductor of the bridge, not to ${AUTO_ADDRESS}: name ${AUTO_ADDRESS} in the input of the recipe, where it says who does a step`
      );
    }
    const choice = auto ? await this.choiceFor(caller, request) : undefined;
    const handover = request.recipe ? undefined : await this.handoverFor(caller, request);
    const withContext = handover ? `${request.body}${HANDOVER_GAP}${handover}` : request.body;
    const body = withContext.length <= this.limits.maxBodyLength ? withContext : request.body;
    const outcome = await this.asCaller(caller, async (tx): Promise<CreateJobResult | Refusal> => {
      const from = this.requireCaller(caller);
      this.checkOwnId(request.letterId, from);

      if (request.letterId) {
        const sent = this.store.getLetter(request.letterId);
        if (sent) {
          if (
            sent.kind !== 'task' ||
            sent.from !== from.name ||
            this.taskText(sent) !== request.body
          ) {
            throw new BridgeError(
              'invalid_letter',
              `The letter id ${request.letterId} belongs to another letter. Give a new job a new id`,
              { letter: request.letterId }
            );
          }
          const known = this.requireJob(sent.job).job;
          return {
            job: known,
            letter: sent,
            duplicate: true,
            ...(known.routed && { routed: known.routed }),
          };
        }
      }

      if (request.recipe && this.conductors().length === 0) {
        throw new BridgeError('invalid_input', NO_CONDUCTOR, { recipe: request.recipe.name });
      }
      const addressed: ResolveAddressContext = {
        project: from.project,
        caller: from.name,
        now: this.now(),
        canSpawn: (harness) => this.adapters.get(harness)?.createSession !== undefined,
        fresh: request.worktree === true || request.recipe !== undefined || auto?.fresh === true,
      };
      const reviewed =
        request.reviewOf === undefined ? undefined : this.checkReviewAsked(from, request.reviewOf);
      const taken = choice
        ? this.takeChoice(
            choice,
            from,
            addressed,
            reviewed && this.store.getAgent(reviewed.to)?.harness
          )
        : undefined;
      const resolution = taken?.resolution ?? resolveAddress(this.store, request.to, addressed);
      this.checkRecipeAsked(resolution, request.recipe);
      if (this.closing && resolution.kind === 'spawn') {
        throw new BridgeError(
          'not_running',
          'The bridge dispatcher is closing and starts no session now. Hand the job over again when it runs'
        );
      }

      const carriedOut = this.store
        .jobTasks({ to: from.name, states: ACTIVE_JOB_STATES })
        .flatMap((task) => jobOf(task) ?? []);
      let parent: BridgeJob | undefined;
      if (request.parent !== undefined) {
        parent = carriedOut.find((job) => job.number === request.parent);
        if (!parent) {
          throw new BridgeError(
            'invalid_input',
            `Job ${request.parent} is not a job you are carrying out, so it cannot be the parent of a new one`,
            { parent: request.parent }
          );
        }
      } else {
        parent = carriedOut.reduce<BridgeJob | undefined>(
          (deepest, job) => (deepest && deepest.depth >= job.depth ? deepest : job),
          undefined
        );
      }
      let depth: number;
      try {
        depth = nextDepth(parent?.depth, this.limits);
        if (request.recipe) nextDepth(depth, this.limits);
      } catch (error) {
        if (!(error instanceof BridgeError)) throw error;
        this.journal(tx, {
          type: 'letter.rejected',
          agent: from.name,
          data: {
            reason: error.code,
            to: request.to,
            title: request.title ?? titleOf(request.body),
          },
        });
        return new Refusal(error);
      }
      const budget = resolveBudget(request.budget, this.limits);
      const cwd = jobFolder(from, request.cwd);
      if (!isInside(from.project, cwd) && !isInside(findCheckoutRoot(from.cwd), cwd)) {
        throw new BridgeError(
          'invalid_input',
          `A job is done inside the project it is handed over in (${from.project}) or the checkout you work in, and ${cwd} is outside both`,
          { cwd, project: from.project }
        );
      }

      if (request.worktree) this.checkWorktreeAsked(from, resolution, cwd);

      const now = this.now();
      const refusal = this.handOverRefusal(from, resolution, request.body, cwd, now, !!taken);
      if (refusal) {
        this.journal(tx, {
          type: 'letter.rejected',
          agent: from.name,
          data: {
            reason: refusal.code,
            to: request.to,
            title: request.title ?? titleOf(request.body),
          },
        });
        return new Refusal(refusal);
      }

      let to: AgentRecord;
      if (resolution.kind === 'agent') {
        to = resolution.agent;
      } else {
        const adapter = this.adapters.get(resolution.harness);
        to = {
          name: allocateAgentName(this.store, resolution.harness, from.project),
          harness: resolution.harness,
          sessionId: '',
          ...(resolution.sessionName && { sessionName: resolution.sessionName }),
          project: from.project,
          cwd,
          delivery: adapter?.delivery ?? INBOX_DELIVERY,
          capabilities: adapter?.capabilities ?? NO_CAPABILITIES,
          status: 'starting',
          registeredAt: this.iso(now),
          lastSeenAt: this.iso(now),
        };
        this.store.putAgent(to);
      }

      const number = this.store.nextJobNumber();
      const record: BridgeJobRecord = {
        number,
        title: request.title ?? titleOf(request.body),
        from: from.name,
        to: to.name,
        project: from.project,
        cwd,
        ...(body !== request.body && { taskLength: request.body.length }),
        ...(request.type && { type: request.type }),
        ...(request.recipe && { recipe: request.recipe }),
        ...(request.reviewOf !== undefined && { reviewOf: request.reviewOf }),
        ...(taken && { routed: taken.reason }),
        ...(request.worktree && { isolation: 'worktree' as const }),
        checks: request.checks ?? [],
        budget,
        lettersUsed: 1,
        depth,
        ...(parent && { parent: parent.number }),
        createdAt: this.iso(now),
        deadlineAt: this.iso(
          Math.min(now + budget.durationMs, parent ? Date.parse(parent.deadlineAt) : Infinity)
        ),
      };
      const firstLetterId = request.letterId ?? this.letterId();
      const history = userMessage(forHistory(body, firstLetterId));
      const task = await this.tasks.createTask(history, undefined, {
        agentName: to.name,
        metadata: { [BRIDGE_JOB_KEY]: record },
      });
      this.journal(tx, {
        type: 'job.created',
        job: number,
        agent: from.name,
        data: {
          title: record.title,
          from: from.name,
          to: to.name,
          depth,
          cwd,
          ...(record.type && { type: record.type }),
          ...(taken && { routed: taken.reason }),
        },
      });

      const letter = this.acceptLetter(tx, {
        id: firstLetterId,
        job: number,
        kind: 'task',
        from: from.name,
        to: to.name,
        body,
        replyDueAt: this.iso(now + budget.replyTimeoutMs),
      });
      if (resolution.kind === 'spawn') {
        tx.wake.delete(to.name);
        tx.spawns.push({ agent: to.name, job: number, letter: letter.id });
      }
      return {
        job: this.jobFrom(task),
        letter,
        duplicate: false,
        ...(taken && { routed: taken.reason }),
      };
    });
    if (outcome instanceof Refusal) throw outcome.error;
    return outcome;
  }

  /**
   * Sends a letter on a job to its other party: a question, an answer, a report that ends the
   * job, a note. The call returns once the bridge has the letter, the answer comes as a letter.
   *
   * A permission request that names its call (`ask`) is judged first by the rules of the agent
   * that handed the job over: what they forbid is refused at once, what they allow is that
   * agent's to answer, and the rest waits for the person. So the one carrying a job out never
   * gets leave the one who handed it over does not have. The decision comes through `verdict`.
   *
   * @throws BridgeError `not_registered`, `unknown_job`, `not_a_party`, `job_finished`,
   * `invalid_letter`, `loop_detected` (the same letter twice in a row), `budget_exhausted` (the
   * job ran out of letters or time, and has failed), `needs_person` (an agent allowing what only
   * the person can)
   */
  async send(caller: string, input: SendLetterInput): Promise<SendLetterResult> {
    const request = parse(SendLetterInputSchema, input, 'Cannot send the letter');
    this.checkBody(request.body);
    const rights = request.ask ? await this.rightsFor(request.job, request.ask) : undefined;
    const changes = request.kind === 'report' ? await this.changesAtReport(request.job) : undefined;
    const outcome = await this.asCaller(caller, async (tx): Promise<SendLetterResult | Refusal> => {
      const from = this.requireCaller(caller);
      this.checkOwnId(request.id, from);

      if (request.id) {
        const sent = this.store.getLetter(request.id);
        if (sent) {
          if (
            sent.from !== from.name ||
            sent.job !== request.job ||
            sent.kind !== request.kind ||
            sent.body !== request.body
          ) {
            throw new BridgeError(
              'invalid_letter',
              `The letter id ${request.id} belongs to another letter. Give a new letter a new id`,
              { letter: request.id }
            );
          }
          return { letter: sent, job: this.requireJob(sent.job).job, duplicate: true };
        }
      }

      const { job } = this.requireJob(request.job);
      if (from.name !== job.from && from.name !== job.to) {
        throw new BridgeError(
          'not_a_party',
          `Job ${job.number} is between ${job.from} and ${job.to}`,
          {
            job: job.number,
          }
        );
      }
      if (isFinishedJobState(job.state)) {
        throw new BridgeError(
          'job_finished',
          `Job ${job.number} is ${job.state}${job.reason ? ` (${job.reason})` : ''}. Hand over a new job to go on`,
          { job: job.number, state: job.state }
        );
      }
      const to = from.name === job.to ? job.from : job.to;
      const isAssignee = from.name === job.to;
      if (request.kind === 'report' && !isAssignee) {
        throw new BridgeError(
          'invalid_letter',
          `Only ${job.to}, who carries job ${job.number} out, reports on it`
        );
      }

      if (request.ask && !isAssignee) {
        throw new BridgeError(
          'invalid_letter',
          `Only ${job.to}, who carries job ${job.number} out, asks leave for a call`
        );
      }

      const answered = this.answeredLetter(request, job, from.name);
      if (request.kind === 'answer' && answered) {
        if (answered.ask && !request.verdict) {
          throw new BridgeError(
            'invalid_letter',
            `The permission request ${answered.id} takes a decision: allow or deny`,
            { letter: answered.id }
          );
        }
        if (!answered.ask && request.verdict) {
          throw new BridgeError(
            'invalid_letter',
            `The ${answered.kind} ${answered.id} takes an answer in words, not a decision`,
            { letter: answered.id }
          );
        }
        if (answered.ask && answered.needsPerson && request.verdict === 'allow') {
          const error = new BridgeError(
            'needs_person',
            `The permission request ${answered.id} is the person's to allow: your own rules would have you ask them too. They were asked. You can refuse it`,
            { job: job.number, letter: answered.id }
          );
          this.journal(tx, {
            type: 'letter.rejected',
            job: job.number,
            agent: from.name,
            data: { reason: error.code, kind: request.kind, to, inReplyTo: answered.id },
          });
          return new Refusal(error);
        }
      }

      const previous = this.store.listLetters({
        job: job.number,
        from: from.name,
        to,
        newestFirst: true,
        limit: 1,
      })[0];
      if (
        repeats(previous, request.kind, request.body, answered?.id) &&
        !this.wasAllowed(previous)
      ) {
        const error = new BridgeError(
          'loop_detected',
          `This ${request.kind} says what your last letter on job ${job.number} said, so it was not delivered. Say something new, report or cancel the job`,
          { job: job.number, previous: previous.id }
        );
        this.journal(tx, {
          type: 'letter.rejected',
          job: job.number,
          agent: from.name,
          data: { reason: error.code, kind: request.kind, to, previous: previous.id },
        });
        return new Refusal(error);
      }

      const now = this.now();
      const clockHeld = now >= Date.parse(job.deadlineAt) && this.waitsForPerson(job.number);
      const exhausted = exhaustedBudget(job, now, request.kind, clockHeld);
      if (exhausted) {
        const reason =
          exhausted === 'letters'
            ? `the job used all ${job.budget.letters} letters of its budget`
            : ranOutOfTime(job);
        await this.failJob(tx, job.number, reason, exhausted === 'letters' ? 'other' : 'timeout');
        return new Refusal(
          new BridgeError(
            'budget_exhausted',
            `Job ${job.number} has failed: ${reason}. The letter was not delivered`,
            {
              job: job.number,
              exhausted,
            }
          )
        );
      }

      for (const waiting of this.store.listLetters({
        job: job.number,
        to: from.name,
        states: ['delivered'],
      })) {
        this.markRead(tx, waiting);
      }
      if (isAssignee && job.state === 'submitted') await this.pickUp(tx, job);

      const forPerson = rights === 'ask' && this.person !== undefined;
      const refused =
        rights === 'deny'
          ? `The rules of ${this.ruledBy(job)} forbid this, so it is refused`
          : rights === 'ask' && !forPerson
            ? 'Only the person can allow this, and this bridge has no way to reach them, so it is refused'
            : undefined;

      const letter = this.acceptLetter(tx, {
        id: request.id ?? this.letterId(),
        job: job.number,
        kind: request.kind,
        from: from.name,
        to,
        body: request.body,
        ...(answered && { inReplyTo: answered.id }),
        ...(request.kind === 'report' && { outcome: request.outcome ?? 'completed' }),
        ...(request.ask && { ask: request.ask }),
        ...(request.verdict && { verdict: request.verdict }),
        ...(forPerson && { needsPerson: true, personAskedAt: this.iso(now) }),
        ...(expectationOf(request.kind) === 'reply' &&
          !refused &&
          !this.conducts(this.store.getAgent(to)) && {
            replyDueAt: this.iso(
              now + (forPerson ? this.limits.personReplyTimeoutMs : job.budget.replyTimeoutMs)
            ),
          }),
      });
      await this.patchRecord(job.taskId, { lettersUsed: job.lettersUsed + 1 });

      if (refused) {
        const settled = this.refuse(tx, letter, refused);
        return { letter: settled, job: this.requireJob(job.number).job, duplicate: false };
      }
      if (forPerson) {
        tx.asked.push({ letter: letter.id, again: false });
        await this.startWaiting(job.number, now);
        await this.neededPerson(job.number);
      }

      if (answered && request.kind === 'answer') {
        this.markHandled(tx, answered);
        if (answered.ask) this.markHandled(tx, letter);
        if (answered.needsPerson) await this.stopWaiting(job.number, now, false);
      }
      if (request.kind === 'report') {
        const state = letter.outcome === 'failed' ? 'failed' : 'completed';
        await this.transition(tx, job.number, state, forHistory(request.body, letter.id));
        if (state === 'failed')
          await this.patchRecord(job.taskId, {
            reason: `reported as failed by ${from.name}`,
            failure: 'reported',
          });
        if (changes && job.worktree && !job.worktree.end) {
          await this.patchRecord(job.taskId, { changes });
        }
        const findings =
          request.findings ??
          (job.reviewOf !== undefined ? parseFindings(request.body) : undefined);
        if (findings) await this.patchRecord(job.taskId, { findings });
        if (findings && state === 'completed' && job.reviewOf !== undefined) {
          await this.noteReview(job, from.name, findings, now);
        }
        if (state === 'completed' && job.checks.length > 0) {
          this.store.updateLetter(letter.id, { state: 'held' });
          await this.patchRecord(job.taskId, {
            checking: { letter: letter.id, since: this.iso(now) },
          });
          tx.checks.push(job.number);
        }
        this.closeLetters(tx, job.number, letter.id);
        await this.stopWaiting(job.number, now, false);
        await this.cancelChildren(tx, job);
        if (this.board) {
          for (const lesson of request.lessons ?? []) {
            tx.notes.push({
              kind: 'lesson',
              text: lesson,
              project: job.project,
              source: { by: from.name, job: job.number, at: this.iso(now) },
            });
          }
          if (!(state === 'completed' && job.checks.length > 0)) {
            this.noteOutcome(tx, job.number, request.body);
          }
        }
      } else if (isAssignee && NEEDS_ANSWER.includes(request.kind)) {
        await this.transition(
          tx,
          job.number,
          'input-required',
          forHistory(request.body, letter.id)
        );
      } else if (request.kind === 'answer' && !isAssignee) {
        await this.resumeIfAnswered(tx, job, forHistory(request.body, letter.id));
      }
      return {
        letter: this.store.getLetter(letter.id) ?? letter,
        job: this.requireJob(job.number).job,
        duplicate: false,
      };
    });
    if (outcome instanceof Refusal) throw outcome.error;
    return outcome;
  }

  /**
   * Passes a question or a permission request addressed to the caller on to the person: the
   * answer is theirs to give now, and goes to the one who asked. The caller can still answer it
   * itself, except to allow a call its own rules leave to the person. Passing a letter on twice
   * changes nothing.
   *
   * @throws BridgeError `unknown_letter` for a letter that is not addressed to the caller,
   * `invalid_letter` for one that takes no answer or waits no more, `no_person` when the bridge
   * has no way to reach the person
   */
  async escalate(caller: string, input: EscalateInput): Promise<Letter> {
    const request = parse(EscalateInputSchema, input, 'Cannot pass the letter on');
    return this.asCaller(caller, async (tx) => {
      const agent = this.requireCaller(caller);
      const letter =
        request.letter === undefined
          ? this.openLetter(request.job ?? 0, agent.name)
          : this.store.getLetter(request.letter);
      if (letter?.to !== agent.name) {
        throw new BridgeError(
          'unknown_letter',
          `There is no letter ${request.letter} addressed to you`,
          { letter: request.letter }
        );
      }
      const { job } = this.requireJob(letter.job);
      if (
        !NEEDS_ANSWER.includes(letter.kind) ||
        letter.state === 'handled' ||
        isFinishedJobState(job.state)
      ) {
        throw new BridgeError(
          'invalid_letter',
          `The ${letter.kind} ${letter.id} waits for no answer, so there is nothing to pass on`,
          { letter: letter.id }
        );
      }
      if (letter.needsPerson) return letter;
      if (!this.person) {
        throw new BridgeError(
          'no_person',
          'This bridge has no way to reach the person. Ask them yourself, in your own window',
          { letter: letter.id }
        );
      }
      const now = this.now();
      const updated = this.store.updateLetter(letter.id, {
        needsPerson: true,
        personAskedAt: this.iso(now),
        replyDueAt: this.iso(now + this.limits.personReplyTimeoutMs),
        clear: ['remindedAt'],
      });
      this.journal(tx, {
        type: 'letter.escalated',
        job: job.number,
        letter: letter.id,
        agent: agent.name,
      });
      tx.asked.push({ letter: letter.id, again: false });
      await this.startWaiting(job.number, now);
      await this.neededPerson(job.number);
      return updated;
    });
  }

  /**
   * Takes what the person said to a letter that waits for them: `allow` or `deny` for a
   * permission request that names its call, words for anything else. The answer goes to the one
   * who asked, signed `person`. Whoever calls this speaks for the person, so it is not served to
   * agents: a route to the person calls it, see `PersonRoute`.
   *
   * @throws BridgeError `unknown_letter` when no such letter waits for the person,
   * `invalid_letter` when it waits no more or the answer is of the wrong kind
   */
  async personAnswer(input: PersonAnswerInput): Promise<SendLetterResult> {
    const request = parse(PersonAnswerInputSchema, input, "Cannot take the person's answer");
    if (request.body !== undefined) this.checkBody(request.body);
    return this.mutate(async (tx) => {
      const target = this.store.getLetter(request.letter);
      if (!target?.needsPerson || !NEEDS_ANSWER.includes(target.kind)) {
        throw new BridgeError(
          'unknown_letter',
          `No letter ${request.letter} waits for the person`,
          { letter: request.letter }
        );
      }
      const { job } = this.requireJob(target.job);
      if (target.state === 'handled' || isFinishedJobState(job.state)) {
        throw new BridgeError(
          'invalid_letter',
          `The ${target.kind} ${target.id} waits no more: ${isFinishedJobState(job.state) ? `job #${job.number} is ${job.state}` : this.settledBy(target)}`,
          { letter: target.id, job: job.number }
        );
      }
      if (target.ask && !request.verdict) {
        throw new BridgeError(
          'invalid_letter',
          `The permission request ${target.id} takes a decision: allow or deny`,
          { letter: target.id }
        );
      }
      if (!target.ask && (request.verdict || request.body === undefined)) {
        throw new BridgeError(
          'invalid_letter',
          `The ${target.kind} ${target.id} takes an answer in words`,
          { letter: target.id }
        );
      }
      const body =
        request.body ??
        (request.verdict === 'allow' ? 'Allowed by the person' : 'Refused by the person');
      const letter = this.acceptLetter(tx, {
        id: this.letterId(),
        job: job.number,
        kind: 'answer',
        from: PERSON,
        to: target.from,
        body,
        inReplyTo: target.id,
        ...(request.verdict && { verdict: request.verdict }),
      });
      this.markHandled(tx, target);
      const sent = target.ask ? this.markHandled(tx, letter) : letter;
      await this.stopWaiting(job.number, this.now(), true);
      await this.resumeIfAnswered(tx, job, forHistory(body, letter.id));
      return { letter: sent, job: this.requireJob(job.number).job, duplicate: false };
    });
  }

  /**
   * Says the caller's session waits for a person at its own window, such as for the answer to
   * its harness's permission dialog: something only a person there can give. Whoever handed it
   * a job that still runs is told in a note, and the person through their route, so nobody
   * waits for an agent that itself waits. Told once in `limits.windowNoticeMs` for an agent,
   * however often its harness says so. Resolves with the jobs whose other party was told.
   */
  async stuck(caller: string, input: StuckInput): Promise<number[]> {
    const request = parse(StuckInputSchema, input, 'Cannot note that the session waits');
    return this.asCaller(caller, async (tx) =>
      this.noteStuck(tx, this.requireCaller(caller), request.what, 'hook')
    );
  }

  /**
   * Notes that a session waits for a person at its own window. `seen` says how the bridge
   * learned of it: a `hook` runs once for each dialog, a `listing` of the harness shows the same
   * wait again every time it is asked, so only the first sight of it counts as one more time
   * the jobs of the session needed the person. Whoever handed those jobs over is told, and not
   * again within `limits.windowNoticeMs`.
   */
  private async noteStuck(
    tx: Transaction,
    agent: AgentRecord,
    what: string,
    seen: 'hook' | 'listing'
  ): Promise<number[]> {
    const now = this.now();
    const jobs = this.store
      .jobTasks({ to: agent.name, states: ACTIVE_JOB_STATES })
      .flatMap((task) => jobOf(task) ?? [])
      .filter((job) => !this.holdsCall(agent.name, job.number))
      .sort((a, b) => a.number - b.number);
    if (jobs.length === 0) return [];
    const again = seen === 'listing' && this.stuckNow.has(agent.name);
    this.stuckNow.add(agent.name);
    if (!again) for (const job of jobs) await this.neededPerson(job.number);
    const told = this.stuckTold.get(agent.name);
    if (told !== undefined && now - told < this.limits.windowNoticeMs) return [];
    this.stuckTold.set(agent.name, now);
    for (const job of jobs) {
      this.systemNote(
        tx,
        job,
        job.from,
        `${agent.name} waits for a person at its own window, and job #${job.number} stands still until they answer there. It shows:\n${quoted(what)}\nNobody can answer that from here. If the user is with you, tell them in one line.`
      );
    }
    tx.notices.push({
      agent: agent.name,
      jobs,
      text: `${agent.name} waits for you at its own window: ${oneLine(what)}`,
    });
    return jobs.map((job) => job.number);
  }

  /** How a letter that waits no more was settled, for whoever answers it too late. */
  private settledBy(letter: Letter): string {
    const [answer] = this.store.listLetters({
      inReplyTo: letter.id,
      kinds: ['answer'],
      newestFirst: true,
      limit: 1,
    });
    return answer?.from === BRIDGE_SENDER ? answer.body : 'it is answered';
  }

  /**
   * Whether the agent holds a call of the job for a verdict it asked through the bridge. Its
   * harness may say all the while that the session waits for a permission (Claude Code does, a
   * few seconds into the hook that asks leave), but that wait is answered through the bridge,
   * not at a window.
   */
  private holdsCall(agent: string, job: number): boolean {
    return this.store
      .listLetters({
        job,
        from: agent,
        kinds: ['permission'],
        states: ['queued', 'delivered', 'read'],
      })
      .some((letter) => letter.ask !== undefined);
  }

  /** The letters that wait for the person, oldest first, each with its job and the text to show. */
  async forPerson(): Promise<PersonLetter[]> {
    return this.enqueue(async () =>
      this.store
        .listLetters({ needsPerson: true, states: ['queued', 'delivered', 'read'] })
        .map((letter) => {
          const { job } = this.requireJob(letter.job);
          return { letter: renderLetter(letter, job), job };
        })
    );
  }

  /**
   * Whether a permission request the caller sent is decided. Answers at once when it is,
   * otherwise as soon as it is, or with `waiting` when `timeoutMs` passes: the caller asks
   * again. A request whose job ended before anybody answered counts as refused.
   *
   * @throws BridgeError `unknown_letter` for anything but a permission request of the caller
   * that names its call
   */
  async verdict(caller: string, input: VerdictInput, signal?: AbortSignal): Promise<VerdictResult> {
    const request = parse(VerdictInputSchema, input, 'Cannot look the verdict up');
    const timeoutMs = request.timeoutMs ?? DEFAULT_VERDICT_WAIT_MS;
    const first = await this.asCaller(
      caller,
      async (): Promise<VerdictResult | { later: Promise<void> }> => {
        const agent = this.requireCaller(caller);
        const letter = this.store.getLetter(request.letter);
        if (letter?.from !== agent.name || letter.kind !== 'permission' || !letter.ask) {
          throw new BridgeError(
            'unknown_letter',
            `You sent no permission request ${request.letter} that names its call`,
            { letter: request.letter }
          );
        }
        const decision = this.decisionOf(letter);
        if (decision.state === 'decided' || timeoutMs === 0 || signal?.aborted || this.closing) {
          return decision;
        }
        return { later: this.untilDecided(letter.id, timeoutMs, signal) };
      }
    );
    if (!('later' in first)) return first;
    await first.later;
    if (this.closed) return { state: 'waiting' };
    return this.enqueue(async () => {
      const letter = this.store.getLetter(request.letter);
      return letter ? this.decisionOf(letter) : { state: 'waiting' };
    });
  }

  /**
   * Takes back a permission request the caller sent and holds its call for no more, such as when
   * the hook that waited for the verdict gave up and left the call to its harness. The request
   * is done with as refused in the bridge's name: nobody is asked to decide it any more, an
   * answer that comes late is refused instead of looking as if it let the call through, and a
   * job that waited only for it works again. A request that was decided already keeps its
   * decision, and the caller gets it.
   *
   * @throws BridgeError `unknown_letter` for anything but a permission request of the caller
   * that names its call
   */
  async withdraw(caller: string, input: WithdrawInput): Promise<WithdrawResult> {
    const request = parse(WithdrawInputSchema, input, 'Cannot take the request back');
    return this.asCaller(caller, async (tx) => {
      const agent = this.requireCaller(caller);
      const letter = this.store.getLetter(request.letter);
      if (letter?.from !== agent.name || letter.kind !== 'permission' || !letter.ask) {
        throw new BridgeError(
          'unknown_letter',
          `You sent no permission request ${request.letter} that names its call`,
          { letter: request.letter }
        );
      }
      const decision = this.decisionOf(letter);
      if (decision.state === 'decided') return decision;
      const { job } = this.requireJob(letter.job);
      const reason = `${agent.name} waits for this decision no more`;
      this.refuse(tx, letter, reason);
      if (letter.needsPerson) await this.stopWaiting(job.number, this.now(), false);
      await this.resumeIfAnswered(tx, job, forHistory(reason, letter.id));
      return { state: 'withdrawn' };
    });
  }

  private decisionOf(letter: Letter): VerdictResult {
    if (letter.state !== 'handled') return { state: 'waiting' };
    const answer = this.store
      .listLetters({ inReplyTo: letter.id, kinds: ['answer'], newestFirst: true })
      .find((candidate) => candidate.verdict !== undefined);
    if (answer?.verdict) {
      return { state: 'decided', verdict: answer.verdict, reason: answer.body, by: answer.from };
    }
    const { job } = this.requireJob(letter.job);
    return {
      state: 'decided',
      verdict: 'deny',
      reason: `Nobody answered before job #${job.number} was ${job.state}${job.reason ? ` (${job.reason})` : ''}`,
      by: BRIDGE_SENDER,
    };
  }

  /** Resolves when the request gets its verdict, `ms` pass, or `signal` aborts. */
  private untilDecided(
    letterId: string,
    ms: number,
    signal: AbortSignal | undefined
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const waiting = this.verdictWaiters.get(letterId) ?? new Set<() => void>();
      this.verdictWaiters.set(letterId, waiting);
      const look = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', look);
        waiting.delete(look);
        if (waiting.size === 0 && this.verdictWaiters.get(letterId) === waiting) {
          this.verdictWaiters.delete(letterId);
        }
        resolve();
      };
      const timer = setTimeout(look, ms);
      signal?.addEventListener('abort', look, { once: true });
      waiting.add(look);
    });
  }

  /**
   * What the rules of the agent that handed a job over make of a call. A job handed over from
   * inside a job is bound by every agent up the chain: the call is theirs to allow only when it
   * is each one's, and forbidden when any of them may not make it. The conductor of a recipe has
   * no rules of its own: a job it handed out is judged by the rules of whoever started the
   * recipe, and on up. A judge that throws, and a bridge without one, leave the call to the
   * person: nothing is allowed by accident.
   */
  private async rightsFor(number: number, ask: PermissionAsk): Promise<Rights> {
    if (!this.rights) return 'ask';
    let rights: Rights = 'allow';
    try {
      for (let at: number | undefined = number; at !== undefined;) {
        const job = this.jobIfAny(at);
        if (!job) return 'ask';
        const delegator = this.store.getAgent(job.from);
        at = job.parent;
        if (this.conducts(delegator)) {
          if (at === undefined) return 'ask';
          continue;
        }
        const said = await this.rights({ job, delegator, ask });
        if (said === 'deny') return 'deny';
        if (said === 'ask') rights = 'ask';
      }
    } catch (error) {
      this.onError(asError(error));
      return 'ask';
    }
    return rights;
  }

  private jobIfAny(number: number): BridgeJob | undefined {
    const task = this.store.taskOfJob(number);
    return task && jobOf(task) ? this.requireJob(number).job : undefined;
  }

  /** Whether a permission request was answered with `allow`: the same call may be asked for again. */
  private wasAllowed(letter: Letter | undefined): boolean {
    if (letter?.kind !== 'permission' || !letter.ask) return false;
    const decision = this.decisionOf(letter);
    return decision.state === 'decided' && decision.verdict === 'allow';
  }

  /**
   * Refuses a permission request on the spot, in the bridge's own name: the request is done
   * with, and its sender finds the refusal through `verdict`.
   */
  private refuse(tx: Transaction, request: Letter, reason: string): Letter {
    const settled = this.markHandled(tx, request);
    const answer = this.acceptLetter(tx, {
      id: this.letterId(),
      job: request.job,
      kind: 'answer',
      from: BRIDGE_SENDER,
      to: request.from,
      body: reason,
      inReplyTo: request.id,
      verdict: 'deny',
    });
    this.markHandled(tx, answer);
    return settled;
  }

  /**
   * Whether a job waits for the person right now: a letter of it does, or a job handed over
   * from inside it waits for them.
   */
  private waitsForPerson(number: number): boolean {
    if (this.asksPerson(number)) return true;
    const below = this.store
      .jobTasks({ parent: number, states: ACTIVE_JOB_STATES })
      .some((task) => {
        const child = jobOf(task);
        return child !== undefined && this.waitsForPerson(child.number);
      });
    if (below) return true;
    const recipe = this.recipeAbove(number);
    return recipe !== undefined && this.asksPerson(recipe.number);
  }

  /** Whether a letter of the job itself waits for the person. */
  private asksPerson(number: number): boolean {
    return (
      this.store.countLetters({
        job: number,
        needsPerson: true,
        states: ['queued', 'delivered', 'read'],
      }) > 0
    );
  }

  /**
   * The recipe a job is a step of, while it runs. A question of a step reaches the person as a
   * letter of the recipe's job, which the conductor passed on, so a step waits with its recipe.
   */
  private recipeAbove(number: number): BridgeJob | undefined {
    const job = this.jobIfAny(number);
    const parent = job?.parent === undefined ? undefined : this.jobIfAny(job.parent);
    if (!parent || isFinishedJobState(parent.state)) return undefined;
    return this.conducts(this.store.getAgent(parent.to)) ? parent : undefined;
  }

  /**
   * The jobs that wait for the person with a job: those it is part of, and for the job of a
   * recipe its steps that run.
   */
  private waitingWith(number: number): BridgeJob[] {
    const chain = this.chainOf(number);
    const own = chain.find((job) => job.number === number);
    if (!own || !this.conducts(this.store.getAgent(own.to))) return chain;
    const steps = this.store
      .jobTasks({ parent: number, states: ACTIVE_JOB_STATES })
      .flatMap((task) => jobOf(task) ?? []);
    return [...chain, ...steps];
  }

  /** A job and the jobs it was handed over from inside of, the nearest first, while they run. */
  private chainOf(number: number): BridgeJob[] {
    const chain: BridgeJob[] = [];
    for (let at: number | undefined = number; at !== undefined;) {
      const job = this.jobIfAny(at);
      if (!job) break;
      if (!isFinishedJobState(job.state)) chain.push(job);
      at = job.parent;
    }
    return chain;
  }

  /**
   * Notes that a job began to wait for the person, and with it every job it is part of: none
   * of them is failed by its deadline while the wait lasts.
   */
  private async startWaiting(number: number, now: number): Promise<void> {
    for (const job of this.waitingWith(number)) {
      if (!job.personWaitSince) {
        await this.patchRecord(job.taskId, { personWaitSince: this.iso(now) });
      }
    }
  }

  /**
   * Settles the wait of a job and of every job it is part of after a letter that waited for the
   * person was dealt with. Time spent waiting for the person is not time the agents worked:
   * when the person answered (`answered`), the deadline moves by as long as the job waited so
   * far. When an agent dealt with the letter itself, or the job ended, nothing is given back, so
   * agents cannot buy a job time by leaving letters to the person and taking them back. A job
   * that still waits for another letter goes on waiting.
   */
  private async stopWaiting(number: number, now: number, answered: boolean): Promise<void> {
    for (const job of this.waitingWith(number)) {
      if (!job.personWaitSince) continue;
      const waited = Math.max(0, now - Date.parse(job.personWaitSince));
      const still = this.waitsForPerson(job.number);
      await this.patchRecord(job.taskId, {
        ...(answered && { deadlineAt: this.iso(Date.parse(job.deadlineAt) + waited) }),
        personWaitSince: still
          ? this.iso(answered ? now : Date.parse(job.personWaitSince))
          : undefined,
      });
    }
  }

  /** Puts a job that waited for an answer back to work once nothing of it waits for one. */
  private async resumeIfAnswered(tx: Transaction, job: BridgeJob, said: string): Promise<void> {
    const open = this.store.countLetters({
      job: job.number,
      from: job.to,
      kinds: NEEDS_ANSWER,
      states: ['queued', 'delivered', 'read'],
    });
    if (open === 0 && this.requireJob(job.number).job.state === 'input-required') {
      await this.transition(tx, job.number, 'working', said);
    }
  }

  /**
   * The letters waiting for the caller, oldest first, each with the text to show. Taking them
   * marks them read, and taking a job's first letter starts the job. One call returns `limit`
   * letters at most (20 by default) and no more text than fits one answer: only the letters
   * returned are marked, the rest wait for the next call. A session that may have missed an
   * answer asks again with `unhandled`, which adds the newest of the letters it took before and
   * has not answered or put away, in the room the new letters leave: what was not seen yet
   * always comes first. `afterSeq` looks further than one call returns.
   */
  async inbox(caller: string, input: InboxInput = {}): Promise<RenderedLetter[]> {
    const request = parse(InboxInputSchema, input, 'Cannot read the inbox');
    return this.asCaller(caller, async (tx) => {
      const agent = this.requireCaller(caller);
      const limit = request.limit ?? DEFAULT_INBOX_LIMIT;
      const scope = {
        to: agent.name,
        ...(request.job !== undefined && { job: request.job }),
        ...(request.afterSeq !== undefined && { afterSeq: request.afterSeq }),
      };
      const unread = this.store.listLetters({ ...scope, states: UNREAD_STATES, limit });
      const taken =
        request.unhandled && unread.length < limit
          ? this.store.listLetters({
              ...scope,
              states: ['read'],
              limit: limit - unread.length,
              newestFirst: request.afterSeq === undefined,
            })
          : [];
      const size = (letter: Letter) => 2 * letter.body.length;
      const fresh = fitting(unread, size);
      const left = MAX_ANSWER_CHARS - fresh.reduce((sum, letter) => sum + size(letter), 0);
      const again =
        fresh.length === unread.length ? fitting(taken, size, left, fresh.length > 0) : [];
      const letters = [...again, ...fresh].sort((a, b) => a.seq - b.seq);
      const rendered: RenderedLetter[] = [];
      for (const letter of letters) {
        const { job } = this.requireJob(letter.job);
        let current = letter;
        if (!request.peek && UNREAD_STATES.includes(letter.state)) {
          current = this.markRead(tx, letter);
          if (letter.kind === 'task' && job.state === 'submitted') await this.pickUp(tx, job);
        }
        rendered.push(renderLetter(current, job));
      }
      return rendered;
    });
  }

  /**
   * Waits for the caller's mail: answers at once when letters are queued for it, otherwise as
   * soon as one arrives, or with none when `timeoutMs` passes. This is how a session nothing can
   * be pushed into still wakes: a process of its harness waits here and hands what it gets to
   * the session, as `cogitator bridge wait` does in a hook of Claude Code. The letters stay
   * queued until the waiter says it handed them over (`delivered`), so a waiter that dies with
   * them in hand loses nothing. A session has one waiter: a new one ends the one before it.
   * Aborting `signal` ends the wait, as the socket server does when the connection closes.
   */
  async wait(caller: string, input: WaitInput = {}, signal?: AbortSignal): Promise<WaitResult> {
    const request = parse(WaitInputSchema, input, 'Cannot wait for letters');
    const limit = request.limit ?? DEFAULT_INBOX_LIMIT;
    const outcome = await this.asCaller(
      caller,
      async (): Promise<WaitResult | { later: Promise<WaitResult> }> => {
        const agent = this.requireCaller(caller);
        this.waiters.get(agent.name)?.end('replaced');
        this.letGo(agent.name);
        if (signal?.aborted || this.closing) return { letters: [], reason: 'closed' };
        const letters = this.starting.has(agent.name) ? [] : this.queuedFor(agent.name, limit);
        if (letters.length > 0) {
          this.hand(agent.name, letters, signal);
          return { letters, reason: 'letters' };
        }
        return {
          later: this.arm(agent.name, limit, request.timeoutMs ?? DEFAULT_WAIT_MS, signal),
        };
      }
    );
    return 'later' in outcome ? outcome.later : outcome;
  }

  /**
   * Says the caller's waiter handed these letters to its session. A job handed over this way
   * counts as taken, as one an adapter pushed does. A letter that is not queued any more, such
   * as one the session read from its inbox meanwhile, stays as it is.
   *
   * @throws BridgeError `unknown_letter` for a letter that is not addressed to the caller
   */
  async delivered(caller: string, letterIds: readonly string[]): Promise<Letter[]> {
    const { letters: ids } = parse(
      DeliveredInputSchema,
      { letters: [...letterIds] },
      'Cannot mark the letters delivered'
    );
    return this.asCaller(caller, async (tx) => {
      const agent = this.requireCaller(caller);
      const marked: Letter[] = [];
      for (const id of new Set(ids)) {
        if (this.store.getLetter(id)?.to !== agent.name) {
          throw new BridgeError('unknown_letter', `There is no letter ${id} addressed to you`, {
            letter: id,
          });
        }
        await this.markDelivered(tx, id, { via: 'wait' });
        const letter = this.store.getLetter(id);
        if (letter) marked.push(letter);
      }
      tx.wake.add(agent.name);
      return marked;
    });
  }

  private arm(
    name: string,
    limit: number,
    timeoutMs: number,
    signal: AbortSignal | undefined
  ): Promise<WaitResult> {
    return new Promise<WaitResult>((resolve) => {
      const waiter: Waiter = {
        limit,
        signal,
        armedAt: this.now(),
        end: (reason, letters = []) => {
          if (this.waiters.get(name) === waiter) this.waiters.delete(name);
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve({ letters, reason });
        },
      };
      const timer = setTimeout(() => waiter.end('timeout'), timeoutMs);
      const onAbort = () => waiter.end('closed');
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.set(name, waiter);
    });
  }

  /**
   * The letters queued for an agent that nobody holds, oldest first, as many as one answer
   * carries.
   */
  private queuedFor(name: string, limit: number): RenderedLetter[] {
    const queued = this.store
      .listLetters({ to: name, states: ['queued'], limit })
      .filter((letter) => !this.held(letter.id));
    return fitting(queued, (letter) => 2 * letter.body.length).map((letter) =>
      renderLetter(letter, this.requireJob(letter.job).job)
    );
  }

  private held(letterId: string): boolean {
    const holder = this.inHand.get(letterId);
    if (!holder) return false;
    if (holder.until > this.now()) return true;
    this.inHand.delete(letterId);
    return false;
  }

  /**
   * Notes that a waiter was given these letters. They are in its hand until it confirms them,
   * its connection closes, a newer waiter of the session takes over, or `deliveryTimeoutMs`
   * passes, whichever comes first.
   */
  private hand(
    name: string,
    letters: readonly RenderedLetter[],
    signal: AbortSignal | undefined
  ): void {
    const holder: Held = { agent: name, until: this.now() + this.limits.deliveryTimeoutMs };
    for (const letter of letters) this.inHand.set(letter.id, holder);
    signal?.addEventListener(
      'abort',
      () => {
        let dropped = false;
        for (const letter of letters) {
          if (this.inHand.get(letter.id) !== holder) continue;
          this.inHand.delete(letter.id);
          dropped = true;
        }
        if (dropped) this.wakeIfKnown(name);
      },
      { once: true }
    );
  }

  /** Frees what the waiters of an agent hold: a newer waiter is about to take their place. */
  private letGo(name: string): void {
    for (const [letterId, holder] of this.inHand) {
      if (holder.agent === name && !holder.pushing) this.inHand.delete(letterId);
    }
  }

  /**
   * Says the caller is done with a letter that needs no answer. A question, a permission request
   * and a job's first letter are not dismissed this way: they are marked read, and are done with
   * once answered or reported on.
   *
   * @throws BridgeError `unknown_letter` for a letter that is not addressed to the caller
   */
  async acknowledge(caller: string, letterId: string): Promise<Letter> {
    return this.asCaller(caller, async (tx) => {
      const agent = this.requireCaller(caller);
      const letter = this.store.getLetter(letterId);
      if (letter?.to !== agent.name) {
        throw new BridgeError('unknown_letter', `There is no letter ${letterId} addressed to you`, {
          letter: letterId,
        });
      }
      if (expectationOf(letter.kind) !== 'none') {
        const read = this.markRead(tx, letter);
        if (letter.kind === 'task') {
          const { job } = this.requireJob(letter.job);
          if (job.state === 'submitted') await this.pickUp(tx, job);
        }
        return read;
      }
      return this.markHandled(tx, letter);
    });
  }

  /**
   * Cancels a job. Only the agent that handed it over can, the one carrying it out reports it
   * as failed instead.
   *
   * @throws BridgeError `not_a_party`, `job_finished`
   */
  async cancel(caller: string, number: number, reason?: string): Promise<BridgeJob> {
    return this.asCaller(caller, async (tx) => {
      const agent = this.requireCaller(caller);
      const { job } = this.requireJob(number);
      if (agent.name !== job.from) {
        throw new BridgeError(
          'not_a_party',
          `Only ${job.from}, who handed job ${number} over, can cancel it. Report it as failed instead`,
          { job: number }
        );
      }
      if (isFinishedJobState(job.state)) {
        throw new BridgeError('job_finished', `Job ${number} is already ${job.state}`, {
          job: number,
          state: job.state,
        });
      }
      const given = reason ? oneLine(reason) : '';
      await this.cancelJob(
        tx,
        number,
        given ? `canceled by ${agent.name}: ${given}` : `canceled by ${agent.name}`,
        given
          ? `Job #${number} was canceled by ${agent.name}. Stop working on it. Their reason:\n${quoted(given)}`
          : `Job #${number} was canceled by ${agent.name}. Stop working on it.`
      );
      return this.requireJob(number).job;
    });
  }

  /**
   * Records whether the checks of a job confirmed its result. It is a call of the process that
   * hosts the dispatcher and is not served on the socket: the agent that carries a job out
   * must not be the one to say its result holds.
   */
  async recordVerification(
    number: number,
    verification: Pick<JobVerification, 'verified' | 'summary'>
  ): Promise<BridgeJob> {
    const request = parse(VerificationInputSchema, verification, 'Cannot record the verification');
    return this.mutate(async (tx) => {
      const { job } = this.requireJob(number);
      const recorded: JobVerification = {
        verified: request.verified,
        checkedAt: this.iso(),
        ...(request.summary !== undefined && { summary: request.summary }),
      };
      await this.patchRecord(job.taskId, { verification: recorded });
      this.journal(tx, {
        type: 'job.verified',
        job: number,
        data: {
          verified: recorded.verified,
          ...(recorded.summary !== undefined && { summary: recorded.summary }),
        },
      });
      return this.requireJob(number).job;
    });
  }

  /**
   * Refuses a job that asks for a worktree of its own and cannot have one: the folder is in no
   * git repository, the session that would carry it out is open somewhere else already, or the
   * project has as many such jobs in progress as it may.
   */
  private checkWorktreeAsked(from: AgentRecord, resolution: AddressResolution, cwd: string): void {
    if (!inCheckout(cwd)) {
      throw new BridgeError(
        'no_worktree',
        `A worktree is a checkout of a git repository, and ${cwd} is in none`,
        { cwd }
      );
    }
    if (canonicalPath(findProjectRoot(cwd)) !== canonicalPath(from.project)) {
      throw new BridgeError(
        'no_worktree',
        `${cwd} is in a repository of its own inside the project, such as a submodule, and the bridge makes worktrees of the project only`,
        { cwd }
      );
    }
    if (resolution.kind === 'agent') {
      throw new BridgeError(
        'no_worktree',
        `A job in a worktree of its own is done by a session started for it, and ${resolution.agent.name} is open somewhere else already. Hand the job to a harness and it gets a fresh session`,
        { agent: resolution.agent.name }
      );
    }
    const isolated = this.store
      .jobTasks({ states: ACTIVE_JOB_STATES, project: from.project })
      .flatMap((task) => jobOf(task) ?? [])
      .filter((job) => job.isolation === 'worktree');
    if (isolated.length >= this.limits.worktreesPerProject) {
      throw new BridgeError(
        'worktree_limit',
        `${isolated.length} jobs of this project are in progress in worktrees of their own (${isolated.map((job) => `#${job.number}`).join(', ')}), the most there may be: each builds and tests next to the others. Wait for one to report, or hand this job over without a worktree`,
        { jobs: isolated.map((job) => job.number) }
      );
    }
  }

  /**
   * Refuses a letter id of the kind the conductor names its own letters by, from anybody else:
   * a recipe finds the job of a step again by that id, so nobody else may take one.
   */
  private checkOwnId(id: string | undefined, from: AgentRecord): void {
    if (id === undefined || !RECIPE_LETTER_ID.test(id) || this.conducts(from)) return;
    throw new BridgeError(
      'invalid_letter',
      'Letter ids that start with "recipe-" or "relay-" are kept for the recipes of the bridge. Give the letter another id',
      { letter: id }
    );
  }

  /** The harness words of the adapters that carry jobs out by recipes. */
  private conductors(): string[] {
    return [...this.adapters.values()]
      .filter((adapter) => adapter.recipeProblem !== undefined)
      .map((adapter) => adapter.harness);
  }

  /**
   * A review names the job it reviews, and only somebody with a say in that job may: one of its
   * two agents, whoever handed it over, or the conductor of a recipe, which reviews by the word
   * of whoever started it.
   */
  private checkReviewAsked(from: AgentRecord, reviewed: number): BridgeJob {
    const { job } = this.requireJob(reviewed);
    if (job.recipe) {
      throw new BridgeError(
        'invalid_input',
        `Job ${reviewed} is a recipe: review the job of the step that did the work`,
        { job: reviewed }
      );
    }
    const party = from.name === job.from || from.name === job.to;
    if (party || this.conducts(from) || this.handedOver(from.name, job)) return job;
    throw new BridgeError(
      'not_a_party',
      `Job ${reviewed} is between ${job.from} and ${job.to}: only they, or whoever handed it over, have its work reviewed`,
      { job: reviewed }
    );
  }

  /**
   * Counts what a review found on the record of the job it reviewed, once for each review. A
   * review by the agent that did the work, and one that agent had made of its own work, count
   * for nothing: nobody rates itself. The first reviews of a job are the ones kept, so a later
   * one cannot push an earlier one out.
   */
  private async noteReview(
    review: BridgeJob,
    by: string,
    findings: readonly Finding[],
    now: number
  ): Promise<void> {
    if (review.reviewOf === undefined) return;
    const task = this.store.taskOfJob(review.reviewOf);
    const reviewed = task && jobOf(task);
    if (!reviewed || by === reviewed.to || this.ruledBy(review) === reviewed.to) return;
    const known = reviewed.reviews ?? [];
    if (known.length >= REVIEWS_KEPT || known.some((kept) => kept.job === review.number)) return;
    const counted: JobReview = {
      job: review.number,
      by,
      at: this.iso(now),
      blocker: 0,
      major: 0,
      minor: 0,
      nit: 0,
    };
    for (const finding of findings) counted[finding.severity] += 1;
    await this.patchRecord(reviewed.taskId, { reviews: [...known, counted] });
  }

  /** Notes that a job needed the person once more: the scoreboard counts how often it did. */
  private async neededPerson(number: number): Promise<void> {
    const { job } = this.requireJob(number);
    await this.patchRecord(job.taskId, { personNeeded: (job.personNeeded ?? 0) + 1 });
  }

  /** The harnesses a job can be handed to with nobody named, in the order of the adapters. */
  private routable(): string[] {
    return [...this.adapters.values()]
      .filter((adapter) => adapter.createSession !== undefined && !adapter.recipeProblem)
      .map((adapter) => adapter.harness);
  }

  /**
   * What became of the jobs that ended within the window of the scoreboard, newest first. The
   * window is measured from when a job ended, whenever it was handed over, among the newest
   * `SCORED_JOBS` finished jobs.
   */
  private scored(): JobResult[] {
    const harnesses = new Map<string, string | undefined>();
    const harnessOf = (agent: string): string | undefined => {
      if (!harnesses.has(agent)) harnesses.set(agent, this.store.getAgent(agent)?.harness);
      return harnesses.get(agent);
    };
    const since = this.now() - this.limits.scoreWindowMs;
    return this.store
      .jobTasks({ states: ['completed', 'failed'], limit: SCORED_JOBS })
      .flatMap((task) => {
        const job = jobOf(task);
        const harness = job && harnessOf(job.to);
        if (!job || !harness || this.adapters.get(harness)?.recipeProblem) return [];
        const result = resultOf(job, harness);
        return result && Date.parse(result.endedAt) >= since ? [result] : [];
      });
  }

  /**
   * Who a job handed to `auto` goes to, worked out before the job is created: the suggestion of
   * the scoreboard, and the sessions of the caller's project that would not wake for a letter,
   * which `auto` passes over for a fresh session. Undefined for a job that was handed over
   * before under the same letter id: it is with whoever got it then.
   */
  private async choiceFor(
    caller: string,
    request: Pick<CreateJobInput, 'type' | 'letterId'>
  ): Promise<AutoChoice | undefined> {
    const { letterId, type } = request;
    const known = await this.enqueue(async () => ({
      sent: letterId !== undefined && this.store.getLetter(letterId) !== undefined,
      project: this.store.getAgent(caller)?.project,
      harnesses: this.routable(),
    }));
    if (known.sent) return undefined;
    const suggestion = await this.suggest(type === undefined ? {} : { type });
    const { project, harnesses } = known;
    const sessions =
      project === undefined
        ? []
        : await this.enqueue(async () =>
            this.store
              .listAgents({ project, statuses: ['active'] })
              .filter((agent) => agent.name !== caller && harnesses.includes(agent.harness))
          );
    const asleep = new Set<string>();
    for (const agent of sessions) {
      if (!(await this.wakes(agent.name))) asleep.add(agent.name);
    }
    return { suggestion, asleep };
  }

  /** The agents a caller works for: those that handed it its jobs, and those above them. */
  private worksFor(caller: string): Set<string> {
    const above = new Set<string>();
    for (const task of this.store.jobTasks({ to: caller, states: ACTIVE_JOB_STATES })) {
      const job = jobOf(task);
      if (!job) continue;
      for (const link of this.chainOf(job.number)) above.add(link.from);
    }
    return above;
  }

  /**
   * Finds the agent a job handed to `auto` goes to: the best of the suggestion first, then the
   * others a job can go to. Each is tried by its harness word, and by a fresh session where the
   * session that is there would not wake, several fit, or the session is one the caller works
   * for, which would then wait for the caller while the caller waits for it. A harness the
   * bridge cannot start a session of right now is passed over for the next. `avoid` names a
   * harness to take last: the one that did the work a review is of.
   *
   * @throws BridgeError `no_session` when the job can go to none of them
   */
  private takeChoice(
    choice: AutoChoice,
    from: AgentRecord,
    context: ResolveAddressContext,
    avoid: string | undefined
  ): { resolution: AddressResolution; reason: string } {
    const { suggestion, asleep } = choice;
    const open = suggestion.candidates.filter((candidate) => candidate.available);
    const first = open.find((candidate) => candidate.harness === suggestion.best);
    const ranked = first ? [first, ...open.filter((candidate) => candidate !== first)] : open;
    const order = [
      ...ranked.filter((candidate) => candidate.harness !== avoid),
      ...ranked.filter((candidate) => candidate.harness === avoid),
    ];
    const above = this.worksFor(from.name);
    const passed: string[] = [];
    for (const candidate of order) {
      const name = aliasOfHarness(candidate.harness);
      let refused: string | undefined;
      for (const address of [candidate.harness, `${candidate.harness}:${NEW_SESSION}`]) {
        let resolution: AddressResolution;
        try {
          resolution = resolveAddress(this.store, address, context);
        } catch (error) {
          if (
            !(error instanceof BridgeError) ||
            (error.code !== 'ambiguous_agent' && error.code !== 'no_session')
          ) {
            throw error;
          }
          if (error.code === 'no_session') refused = error.message;
          continue;
        }
        if (resolution.kind === 'agent') {
          const { agent } = resolution;
          if (asleep.has(agent.name) || above.has(agent.name)) continue;
        } else {
          const full = this.startingRefusal();
          if (full) {
            refused = full.message;
            continue;
          }
        }
        const reason =
          candidate.harness === suggestion.best
            ? suggestion.reason
            : `${suggestion.reason}. ${
                passed.length > 0
                  ? `The job could not go there (${passed.join('. ')})`
                  : `${aliasOfHarness(avoid ?? '')} did the work this job reviews`
              }, so ${name} took it`;
        return { resolution, reason };
      }
      passed.push(`${name}: ${refused ?? 'its session would not wake for the job'}`);
    }
    throw new BridgeError(
      'no_session',
      `${AUTO_ADDRESS} found no agent the job can go to. ${passed.length > 0 ? passed.join('. ') : suggestion.reason}`,
      { harnesses: order.map((candidate) => candidate.harness) }
    );
  }

  /** Why the bridge starts no session right now, when too many are being started already. */
  private startingRefusal(): BridgeError | undefined {
    const starting = this.store.listAgents({ statuses: ['starting'] }).length;
    if (starting < this.limits.maxStartingSessions) return undefined;
    return new BridgeError(
      'no_session',
      `The bridge is already starting ${starting} sessions, the most at once. Hand the job over again when they are up`,
      { starting, max: this.limits.maxStartingSessions }
    );
  }

  /**
   * Refuses a recipe the conductor cannot start, and a job for the conductor that names none.
   * Every recipe gets a conductor of its own, so a recipe is addressed by the harness word of
   * the conductor, never by the name of one that runs.
   */
  private checkRecipeAsked(resolution: AddressResolution, recipe: JobRecipe | undefined): void {
    const harness = resolution.kind === 'agent' ? resolution.agent.harness : resolution.harness;
    const adapter = this.adapters.get(harness);
    if (!recipe) {
      if (!adapter?.recipeProblem) return;
      throw new BridgeError(
        'invalid_input',
        `${harness} carries out recipes only: name the recipe to start`,
        { harness }
      );
    }
    if (!adapter?.recipeProblem || resolution.kind === 'agent') {
      const conductors = this.conductors();
      throw new BridgeError(
        'invalid_input',
        conductors.length > 0
          ? `A recipe is started by handing its job to the conductor of the bridge: address it to ${conductors.join(' or ')}`
          : NO_CONDUCTOR,
        { recipe: recipe.name }
      );
    }
    const problem = adapter.recipeProblem(recipe);
    if (problem) throw new BridgeError('invalid_input', problem, { recipe: recipe.name });
  }

  /**
   * Where a session that is about to be started for a job works: the worktree of the job, made
   * now, when the job asked for one. Resolves with the job as it is once it has its worktree and
   * with its first letter, which says so, and with nothing for a job that works where it was
   * handed over.
   *
   * @throws when git cannot make the worktree: the job then fails with what git said
   */
  private async placeOf(
    agentName: string,
    job: BridgeJob,
    letterId: string
  ): Promise<{ job: BridgeJob; letter: RenderedLetter } | undefined> {
    if (job.isolation !== 'worktree' || job.worktree) return undefined;
    let made;
    try {
      made = await addJobWorktree({
        project: job.project,
        from: job.cwd,
        number: job.number,
        title: job.title,
      });
    } catch (error) {
      throw new Error(`the worktree of the job could not be made: ${asError(error).message}`, {
        cause: error,
      });
    }
    const record = async (tx: Transaction) => {
      await this.patchRecord(job.taskId, {
        worktree: { path: made.path, branch: made.branch, base: made.base },
        cwd: made.cwd,
      });
      const agent = this.store.getAgent(agentName);
      if (agent) this.store.putAgent({ ...agent, cwd: made.cwd });
      this.journal(tx, {
        type: 'job.worktree',
        job: job.number,
        agent: agentName,
        data: { path: made.path, branch: made.branch, base: made.base },
      });
      const fresh = this.requireJob(job.number).job;
      const letter = this.store.getLetter(letterId);
      if (!letter)
        throw new BridgeError('storage', `The first letter of job ${job.number} is lost`);
      return { job: fresh, letter: renderLetter(letter, fresh) };
    };
    try {
      return await this.mutate(record);
    } catch (error) {
      await removeJobWorktree(job.project, made.path, made.branch).catch(() => undefined);
      throw error;
    }
  }

  /** The worktree of a job while its work is still in it. */
  private liveWorktree(job: BridgeJob): JobWorktreeRecord | undefined {
    return job.worktree && !job.worktree.end ? job.worktree : undefined;
  }

  /**
   * What a job changed in its worktree, counted as its report comes in, for the report to say.
   * Nothing for a job without a worktree, and nothing when git cannot tell: the report goes
   * through all the same.
   */
  private async changesAtReport(number: number): Promise<JobChanges | undefined> {
    const job = await this.enqueue(async () => this.jobIfAny(number));
    const worktree = job && this.liveWorktree(job);
    if (!worktree) return undefined;
    try {
      return summaryOf(await changesOf(worktree.path, worktree.base), this.iso());
    } catch (error) {
      this.onError(asError(error));
      return undefined;
    }
  }

  private startChecks(number: number): void {
    if (this.checkRuns.has(number)) return;
    const stop = new AbortController();
    this.checkRuns.set(number, stop);
    const run = this.checkQueue
      .then(() => this.runChecks(number, stop.signal))
      .finally(() => this.checkRuns.delete(number));
    this.checkQueue = run.catch(() => undefined);
    this.track(run);
  }

  /**
   * Runs the checks of a job that was reported on, where the job was done, and hands its report
   * over with what they showed. The bridge runs a command itself, outside any sandbox, so it
   * runs only what the rules of whoever handed the job over allow without asking: the rest is
   * left out, and the result then does not count as verified. A dispatcher that closes in the
   * middle leaves the job as it is, and the next one runs its checks again.
   */
  private async runChecks(number: number, signal: AbortSignal): Promise<void> {
    const job = await this.enqueue(async () => this.jobIfAny(number));
    if (!job?.checking) return;
    const places = [job.project, findCheckoutRoot(job.cwd), this.liveWorktree(job)?.path];
    const results: JobCheckResult[] = [];
    for (const check of job.checks) {
      try {
        const cwd = check.cwd ? canonicalPath(resolvePath(job.cwd, check.cwd)) : job.cwd;
        if (!places.some((place) => place !== undefined && isInside(place, cwd))) {
          results.push(skippedCheck(check, `it would run in ${cwd}, outside the project`));
          continue;
        }
        const rights = await this.rightsFor(number, {
          tool: 'Bash',
          access: 'command',
          command: check.command,
          cwd,
        });
        if (rights !== 'allow') {
          results.push(
            skippedCheck(
              check,
              !this.rights
                ? 'this bridge has no rules to judge a command by, and runs none without them'
                : rights === 'deny'
                  ? `the rules of ${this.ruledBy(job)} forbid the command`
                  : `the rules of ${this.ruledBy(job)} do not allow the command without asking. Allow it in the settings of the project, or run it yourself`
            )
          );
          continue;
        }
        results.push(
          await runCheck(check, {
            cwd,
            timeoutMs: check.timeoutMs ?? this.limits.checkTimeoutMs,
            signal,
          })
        );
      } catch (error) {
        this.onError(asError(error));
        results.push(skippedCheck(check, `the bridge failed to run it: ${asError(error).message}`));
      }
      if (signal.aborted) return;
    }
    if (this.closing) return;
    const { verified, summary } = summarizeChecks(results);
    await this.mutate(async (tx) => {
      const { job: fresh } = this.requireJob(number);
      if (!fresh.checking) return;
      await this.patchRecord(fresh.taskId, {
        verification: { verified, checkedAt: this.iso(), summary, checks: results },
        checking: undefined,
      });
      this.journal(tx, { type: 'job.verified', job: number, data: { verified, summary } });
      const report = this.store.getLetter(fresh.checking.letter);
      this.noteOutcome(tx, number, report?.body);
      if (report?.state === 'held') {
        this.store.updateLetter(report.id, { state: 'queued' });
        tx.wake.add(report.to);
      }
    });
  }

  /**
   * Picks up what a dispatcher before this one left in the middle: the checks of jobs that were
   * reported on and never got their verdict.
   */
  private recover(tx: Transaction): void {
    if (this.recovered) return;
    this.recovered = true;
    for (const task of this.store.jobTasks({ states: ['completed'] })) {
      const job = jobOf(task);
      if (job?.checking) tx.checks.push(job.number);
    }
  }

  /**
   * What a job changed in its worktree so far: the files, how much, and the patch. For the two
   * agents of the job, and for whoever started the recipe it is a step of, while it runs and
   * after, as long as its worktree is there.
   *
   * @throws BridgeError `unknown_job`, `not_a_party`, `no_worktree` for a job without a worktree
   * of its own or whose work was taken or dropped already
   */
  async diff(caller: string, input: DiffInput): Promise<JobDiff> {
    const request = parse(DiffInputSchema, input, 'Cannot show the changes');
    const { job, worktree } = await this.asCaller(caller, async () => {
      const agent = this.requireCaller(caller);
      const found = this.requireJob(request.job).job;
      if (agent.name !== found.to && !this.handedOver(agent.name, found)) {
        throw new BridgeError(
          'not_a_party',
          `Job ${found.number} is between ${found.from} and ${found.to}`,
          { job: found.number }
        );
      }
      return { job: found, worktree: this.requireWorktree(found) };
    });
    const changes = await this.readChanges(job, worktree);
    const { patch, truncated } =
      request.maxChars === 0
        ? { patch: '', truncated: changes.files.length > 0 }
        : await patchOf(worktree.path, worktree.base, changes.tree, {
            ...(request.paths && { paths: request.paths }),
            ...(request.maxChars !== undefined && { maxChars: request.maxChars }),
          });
    return {
      job: job.number,
      worktree: worktree.path,
      branch: worktree.branch,
      base: worktree.base,
      files: changes.files.map((file) => ({ ...file, path: shownPath(file.path) })),
      insertions: changes.insertions,
      deletions: changes.deletions,
      commits: changes.commits,
      patch,
      truncated,
    };
  }

  /**
   * Takes the work of a finished job out of its worktree, as the agent that handed the job over,
   * or that started the recipe the job is a step of, once the recipe has reported. The changes, committed there or not, come into the checkout the caller works in as one
   * change that is staged and not committed: the commit is the caller's to make. With
   * `asBranch` they are left as a branch instead, for work that goes on as a pull request. The
   * worktree is removed either way. When the changes would leave files in conflict nothing is
   * touched, the answer names the files, and the worktree stays for another try. The bridge
   * never merges into a branch nobody is working on.
   *
   * @throws BridgeError `unknown_job`, `not_a_party` (only who handed the job over takes its
   * work), `invalid_input` (the job still runs, its checks do, the recipe it is a step of does,
   * the caller is in another repository, or git refused), `no_worktree`
   */
  async accept(caller: string, input: AcceptInput): Promise<AcceptResult> {
    const request = parse(AcceptInputSchema, input, 'Cannot take the work');
    const { job, worktree, agent } = await this.asCaller(caller, async () =>
      this.requireTaker(caller, request.job, 'take')
    );
    return this.whileTaking(job.number, async () => {
      const changes = await this.readChanges(job, worktree);
      if (changes.files.length === 0 && changes.commits === 0) {
        await removeJobWorktree(job.project, worktree.path, worktree.branch);
        const ended = await this.endWorktree(job.number, { how: 'accepted' }, 'job.accepted', {});
        return { state: 'nothing', job: ended };
      }
      const commit = await snapshotOf(worktree.path, changes, `job #${job.number}: ${job.title}`);

      if (request.asBranch) {
        const branch = request.asBranch === true ? worktree.branch : request.asBranch;
        await this.leaveBranch(job, worktree, branch, commit);
        const ended = await this.endWorktree(
          job.number,
          { how: 'branch', commit, ref: branch },
          'job.accepted',
          { branch, commit }
        );
        return { state: 'branch', job: ended, branch, commit };
      }

      const into = await checkoutOf(agent.cwd);
      if (!into || canonicalPath(findProjectRoot(into)) !== canonicalPath(job.project)) {
        throw new BridgeError(
          'invalid_input',
          `The work of job ${job.number} belongs to ${job.project}, and you work in ${agent.cwd}, which is not a checkout of it. Take it as a branch instead`,
          { job: job.number, cwd: agent.cwd }
        );
      }
      const conflicts = await this.oneAtATimeIn(into, async () => {
        const busy = await busyWith(into).catch((error: unknown) => {
          throw gitRefusal(error, `Git could not look at ${into}`);
        });
        if (busy) {
          throw new BridgeError(
            'invalid_input',
            `Nothing can be brought into ${into} right now: ${busy}. Taking the work of a job stages it, so commit or stash what is there first, then take the work again`,
            { job: job.number, into }
          );
        }
        const inConflict = await conflictsOf(into, commit).catch((error: unknown) => {
          throw gitRefusal(
            error,
            `Git could not tell whether job ${job.number} merges into ${into}`
          );
        });
        if (inConflict.length > 0) return inConflict;
        await squashInto(into, commit).catch((error: unknown) => {
          throw gitRefusal(
            error,
            `Git refused to bring the changes of job ${job.number} into ${into}, which is as it was. Commit or stash what is in the way there, then take the work again`
          );
        });
        return [];
      });
      if (conflicts.length > 0) {
        return { state: 'conflict', job, into, files: conflicts.map(shownPath) };
      }
      await removeJobWorktree(job.project, worktree.path, worktree.branch).catch((error: unknown) =>
        this.onError(asError(error))
      );
      const ended = await this.endWorktree(
        job.number,
        { how: 'accepted', commit, into },
        'job.accepted',
        { into, commit, files: changes.files.length }
      );
      return {
        state: 'accepted',
        job: ended,
        into,
        files: changes.files.length,
        insertions: changes.insertions,
        deletions: changes.deletions,
      };
    });
  }

  /**
   * Drops the work of a finished job, as the agent that handed the job over, or that started the
   * recipe the job is a step of: its worktree and the branch of it are removed with everything
   * in them.
   *
   * @throws BridgeError `unknown_job`, `not_a_party`, `invalid_input` (the job still runs, its
   * checks do, or the recipe it is a step of does), `no_worktree`
   */
  async reject(caller: string, input: RejectInput): Promise<BridgeJob> {
    const request = parse(RejectInputSchema, input, 'Cannot drop the work');
    const { job, worktree } = await this.asCaller(caller, async () =>
      this.requireTaker(caller, request.job, 'drop')
    );
    return this.whileTaking(job.number, async () => {
      await removeJobWorktree(job.project, worktree.path, worktree.branch);
      return this.endWorktree(job.number, { how: 'rejected' }, 'job.rejected', {
        ...(request.reason && { reason: request.reason }),
      });
    });
  }

  /**
   * Work on one checkout after the other work on it: looking whether it is free, merging into
   * it and taking a failed merge back are one step, and two jobs taken into the same checkout
   * at once would each undo what the other staged.
   */
  private oneAtATimeIn<T>(checkout: string, work: () => Promise<T>): Promise<T> {
    const run = (this.checkouts.get(checkout) ?? Promise.resolve()).then(work, work);
    const settled: Promise<void> = run
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        if (this.checkouts.get(checkout) === settled) this.checkouts.delete(checkout);
      });
    this.checkouts.set(checkout, settled);
    return run;
  }

  /** The worktree of a job whose work is still in it, or why there is none. */
  private requireWorktree(job: BridgeJob): JobWorktreeRecord {
    const worktree = this.liveWorktree(job);
    if (worktree) return worktree;
    const end = job.worktree?.end;
    throw new BridgeError(
      'no_worktree',
      end
        ? `The work of job ${job.number} was ${ENDED[end.how]}${end.ref ? ` (${end.ref})` : ''}${end.into ? ` into ${end.into}` : ''}, and its worktree is gone`
        : job.isolation === 'worktree'
          ? `Job ${job.number} has no worktree yet: its session has not started`
          : `Job ${job.number} was done in ${job.cwd}, not in a worktree of its own: what it changed is there`,
      { job: job.number }
    );
  }

  /** The job, its worktree and the caller, for the one who may take or drop its work. */
  private requireTaker(
    caller: string,
    number: number,
    what: 'take' | 'drop'
  ): { job: BridgeJob; worktree: JobWorktreeRecord; agent: AgentRecord } {
    const agent = this.requireCaller(caller);
    const { job } = this.requireJob(number);
    if (!this.handedOver(agent.name, job)) {
      throw new BridgeError(
        'not_a_party',
        `Only ${job.from}, who handed job ${job.number} over, or whoever handed over a job it is part of, can ${what} its work`,
        { job: job.number }
      );
    }
    if (!isFinishedJobState(job.state)) {
      throw new BridgeError(
        'invalid_input',
        `Job ${job.number} is still ${job.state}. Wait for its report, or cancel it first`,
        { job: job.number, state: job.state }
      );
    }
    if (job.checking) {
      throw new BridgeError(
        'invalid_input',
        `The checks of job ${job.number} still run. Its report comes with what they show`,
        { job: job.number }
      );
    }
    const recipe =
      job.parent !== undefined && this.conducts(this.store.getAgent(job.from))
        ? this.jobIfAny(job.parent)
        : undefined;
    if (recipe && !isFinishedJobState(recipe.state)) {
      throw new BridgeError(
        'invalid_input',
        `Job ${job.number} is a step of the recipe of job ${recipe.number}, which still runs: later steps may work in the same worktree. Wait for the report of job ${recipe.number}, or cancel it first`,
        { job: job.number, recipe: recipe.number }
      );
    }
    const user = this.workingOn(job);
    if (user) {
      throw new BridgeError(
        'invalid_input',
        `Job ${user.number} still works on what job ${job.number} left in its worktree. Wait for its report, or cancel it first`,
        { job: job.number, by: user.number }
      );
    }
    return { job, worktree: this.requireWorktree(job), agent };
  }

  /**
   * A job in progress that works on what another job left in its worktree: one that is done in
   * that worktree, such as the review of the work or its fixes, and a recipe whose input names
   * the job as the one it works on. The worktree stays while there is one.
   */
  private workingOn(job: BridgeJob): BridgeJob | undefined {
    const worktree = this.liveWorktree(job);
    return this.store
      .jobTasks({ states: ACTIVE_JOB_STATES, project: job.project })
      .flatMap((task) => jobOf(task) ?? [])
      .find((other) => {
        if (other.number === job.number) return false;
        if (worktree && isInside(worktree.path, other.cwd)) return true;
        const input: unknown = other.recipe?.input;
        return (
          typeof input === 'object' &&
          input !== null &&
          (input as { job?: unknown }).job === job.number
        );
      });
  }

  /**
   * Whether an agent handed a job over, or started the recipe the job is a step of: a job the
   * conductor hands out for an agent is that agent's to look at and take, as the recipe is its
   * own. A job another agent handed over from inside a job is that agent's alone.
   */
  private handedOver(agent: string, job: BridgeJob): boolean {
    for (let at: BridgeJob | undefined = job; at;) {
      if (at.from === agent) return true;
      if (at.parent === undefined || !this.conducts(this.store.getAgent(at.from))) return false;
      at = this.jobIfAny(at.parent);
    }
    return false;
  }

  /**
   * The agent whose rules bind a job: whoever handed it over, and for a step of a recipe
   * whoever started the recipe, since the conductor has no rules of its own.
   */
  private ruledBy(job: BridgeJob): string {
    for (let at: BridgeJob | undefined = job; at;) {
      if (at.parent === undefined || !this.conducts(this.store.getAgent(at.from))) return at.from;
      at = this.jobIfAny(at.parent);
    }
    return job.from;
  }

  /** One taking, dropping or putting away of a job's worktree at a time. */
  private async whileTaking<T>(number: number, work: () => Promise<T>): Promise<T> {
    if (this.taking.has(number)) {
      throw new BridgeError(
        'invalid_input',
        `The work of job ${number} is being taken or dropped right now`,
        { job: number }
      );
    }
    this.taking.add(number);
    try {
      return await work();
    } finally {
      this.taking.delete(number);
    }
  }

  private async readChanges(job: BridgeJob, worktree: JobWorktreeRecord): Promise<WorktreeChanges> {
    try {
      return await changesOf(worktree.path, worktree.base);
    } catch (error) {
      throw gitRefusal(
        error,
        `Git could not read the worktree of job ${job.number}, ${worktree.path}`
      );
    }
  }

  /**
   * Leaves the work of a worktree as the branch `branch`, at `commit`, and removes the worktree.
   * The branch is set first: whatever goes wrong after that, the work is on it.
   */
  private async leaveBranch(
    job: BridgeJob,
    worktree: JobWorktreeRecord,
    branch: string,
    commit: string
  ): Promise<void> {
    try {
      const own = branch === worktree.branch;
      await pointRef(job.project, `refs/heads/${branch}`, commit, { fresh: !own });
      await removeJobWorktree(job.project, worktree.path, own ? undefined : worktree.branch);
    } catch (error) {
      throw gitRefusal(error, `Git could not leave the work of job ${job.number} as ${branch}`);
    }
  }

  /** Records how the work in a job's worktree ended. */
  private async endWorktree(
    number: number,
    end: Omit<JobWorktreeEnd, 'at'>,
    type: 'job.accepted' | 'job.rejected' | 'job.discarded',
    data: Record<string, unknown>
  ): Promise<BridgeJob> {
    return this.mutate(async (tx) => {
      const { job } = this.requireJob(number);
      if (job.worktree) {
        await this.patchRecord(job.taskId, {
          worktree: { ...job.worktree, end: { ...end, at: this.iso() } },
        });
        this.retireFrom(tx, job, job.worktree.path);
      }
      this.journal(tx, { type, job: number, data: { how: end.how, ...data } });
      return this.requireJob(number).job;
    });
  }

  /**
   * Takes the session that was started in a worktree for gone once the worktree is: the folder
   * it works in is not there any more, so it is no session to hand another job to.
   */
  private retireFrom(tx: Transaction, job: BridgeJob, worktree: string): void {
    const agent = this.store.getAgent(job.to);
    if (!agent || agent.status === 'gone' || !isInside(worktree, agent.cwd)) return;
    this.store.putAgent({ ...agent, status: 'gone' });
    this.journal(tx, {
      type: 'agent.gone',
      agent: agent.name,
      data: { error: `the worktree of job #${job.number}, where it worked, was removed` },
    });
  }

  /**
   * Puts away the worktrees nobody came for: those of jobs that finished longer ago than
   * `limits.worktreeKeepMs`. What such a worktree holds is kept as a commit under a ref of its
   * own, the worktree and its branch are removed, and whoever handed the job over is told
   * where the work is. Looked at once an hour.
   */
  private sweepWorktrees(now: number): void {
    if (now - this.worktreesSweptAt < WORKTREE_SWEEP_MS) return;
    this.worktreesSweptAt = now;
    const left = this.store
      .jobTasks({ states: FINISHED_JOB_STATES })
      .flatMap((task) => jobOf(task) ?? [])
      .filter(
        (job) =>
          this.liveWorktree(job) !== undefined &&
          !job.checking &&
          now - Date.parse(job.endedAt ?? job.updatedAt) >= this.limits.worktreeKeepMs &&
          this.workingOn(job) === undefined
      );
    for (const job of left) {
      if (this.taking.has(job.number)) continue;
      this.track(this.whileTaking(job.number, () => this.putAway(job)));
    }
  }

  /**
   * Puts the worktree of a job away. Nothing is removed before its work is kept: when git
   * cannot read the worktree because its folder is gone, the commits on its branch are kept,
   * and when it cannot for another reason, the worktree stays and the next look tries again.
   */
  private async putAway(job: BridgeJob): Promise<void> {
    const worktree = this.liveWorktree(job);
    if (!worktree) return;
    const ref = `${DISCARDED_REFS}/job-${job.number}`;
    let kept: { commit: string; ref: string } | undefined;
    try {
      if (existsSync(worktree.path)) {
        const changes = await changesOf(worktree.path, worktree.base);
        if (changes.files.length > 0 || changes.commits > 0) {
          const commit = await snapshotOf(
            worktree.path,
            changes,
            `job #${job.number}: ${job.title}`
          );
          await pointRef(job.project, ref, commit);
          kept = { commit, ref };
        }
      } else {
        const tip = await branchTip(job.project, worktree.branch);
        if (tip && tip !== worktree.base) {
          await pointRef(job.project, ref, tip);
          kept = { commit: tip, ref };
        }
      }
      await removeJobWorktree(job.project, worktree.path, worktree.branch);
    } catch (error) {
      this.onError(
        new Error(
          `The worktree of job ${job.number}, ${worktree.path}, could not be put away and stays: ${asError(error).message}`,
          { cause: error }
        )
      );
      return;
    }
    await this.mutate(async (tx) => {
      const { job: fresh } = this.requireJob(job.number);
      if (!fresh.worktree) return;
      await this.patchRecord(fresh.taskId, {
        worktree: { ...fresh.worktree, end: { how: 'discarded', at: this.iso(), ...kept } },
      });
      this.retireFrom(tx, fresh, fresh.worktree.path);
      this.journal(tx, {
        type: 'job.discarded',
        job: job.number,
        data: { how: 'discarded', ...kept },
      });
      if (kept) {
        this.systemNote(
          tx,
          fresh,
          fresh.from,
          `Nobody took or dropped the work of job #${job.number} for ${formatDuration(this.limits.worktreeKeepMs)}, so its worktree was removed. What it held is kept as commit ${kept.commit.slice(0, 10)} under ${kept.ref}: look at it with git show ${kept.ref}.`
        );
      }
    });
  }

  /** The board of this bridge, or the refusal of a bridge that was given none. */
  private requireBoard(): FactBoard {
    if (this.board) return this.board;
    throw new BridgeError(
      'no_board',
      'This bridge keeps no notes: whoever runs it gave it no board to keep them on'
    );
  }

  /** The project a call about the board is for: the caller's own, or the one the person names. */
  private boardProject(agent: AgentRecord | undefined, named: string | undefined): string {
    if (agent) return agent.project;
    if (named) return canonicalPath(findProjectRoot(named));
    throw new BridgeError('invalid_input', 'Say which project the note is for');
  }

  /** The jobs whose own notes a caller may see: an agent's are those it is a party of. */
  private jobsSeenBy(agent: AgentRecord | undefined, project: string): number[] {
    return this.store
      .jobTasks(agent ? { party: agent.name } : { project })
      .flatMap((task) => jobOf(task) ?? [])
      .filter((job) => job.project === project)
      .map((job) => job.number);
  }

  /**
   * Puts a note on the board of a project, for the agents that work there to find: a fact, or
   * what a job taught. The note carries who said it, on which job and when. `caller` is the
   * agent that says it, or `null` for the person, who names the project. A note kept to a job
   * (`jobOnly`) is seen by the two agents of that job only.
   *
   * @throws BridgeError `no_board`, `not_registered`, `unknown_job`, `not_a_party` (the job named
   * is not the caller's), `invalid_input`
   */
  async remember(caller: string | null, input: RememberInput): Promise<BoardFact> {
    const request = parse(RememberInputSchema, input, 'Cannot remember that');
    const board = this.requireBoard();
    const fact = await this.enqueue(async (): Promise<NewBoardFact> => {
      const agent = caller === null ? undefined : this.requireCaller(caller);
      let project = this.boardProject(agent, request.project);
      let job = request.job;
      if (job !== undefined) {
        const found = this.requireJob(job).job;
        const party = agent ? agent.name === found.from || agent.name === found.to : undefined;
        if (party) project = found.project;
        if (found.project !== project || party === false) {
          throw new BridgeError(
            'not_a_party',
            `Job ${found.number} is between ${found.from} and ${found.to}, so a note cannot be said on it from here`,
            { job: found.number }
          );
        }
      } else if (agent) {
        const carried = this.store
          .jobTasks({ to: agent.name, states: ACTIVE_JOB_STATES })
          .flatMap((task) => jobOf(task) ?? []);
        if (carried.length === 1) job = carried[0].number;
      }
      return {
        kind: request.kind ?? 'fact',
        text: request.text,
        project,
        ...(request.jobOnly && job !== undefined && { job }),
        source: {
          by: agent?.name ?? PERSON,
          ...(job !== undefined && { job }),
          at: this.iso(),
        },
      };
    });
    const kept = await board.remember(fact);
    await this.journalNote(kept, fact.source.by);
    return kept;
  }

  /**
   * Writes down that a note went on the board, and who said it this time. Everybody can read
   * the journal, so the text of a note kept to one job is left out of it.
   */
  private async journalNote(kept: BoardFact, by: string): Promise<void> {
    await this.mutate(async (tx) => {
      this.journal(tx, {
        type: 'fact.remembered',
        agent: by,
        ...(kept.source.job !== undefined && { job: kept.source.job }),
        data: {
          id: kept.id,
          kind: kept.kind,
          project: kept.project,
          ...(kept.job === undefined && { text: kept.text }),
          ...(kept.source.by !== by && { saidBefore: kept.source.by }),
        },
      });
    });
  }

  /**
   * Looks at the board of a project: the notes that fit `text` best, or the newest. An agent
   * sees the notes of its project and those kept to the jobs it is a party of, the person
   * (`caller` is `null`) every note of the project they name.
   *
   * @throws BridgeError `no_board`, `not_registered`, `invalid_input`
   */
  async recall(caller: string | null, input: RecallInput = {}): Promise<BoardFact[]> {
    const request = parse(RecallInputSchema, input, 'Cannot look at the board');
    const board = this.requireBoard();
    const query = await this.enqueue(async () => {
      const agent = caller === null ? undefined : this.requireCaller(caller);
      const project = this.boardProject(agent, request.project);
      return { project, jobs: this.jobsSeenBy(agent, project) };
    });
    return board.recall({
      ...query,
      ...(request.text && { text: request.text }),
      ...(request.kinds && { kinds: request.kinds }),
      ...(request.limit !== undefined && { limit: request.limit }),
    });
  }

  /**
   * Lets a note of the board go: it is found no more, and is not deleted. An agent lets go what
   * it said itself, the person (`caller` is `null`) any note of the project they name.
   *
   * @throws BridgeError `no_board`, `not_registered`, `invalid_input` (no such note there),
   * `not_a_party` (the note is another's)
   */
  async forget(caller: string | null, input: ForgetInput): Promise<BoardFact> {
    const request = parse(ForgetInputSchema, input, 'Cannot forget that');
    const board = this.requireBoard();
    const { agent, project, jobs } = await this.enqueue(async () => {
      const found = caller === null ? undefined : this.requireCaller(caller);
      const where = this.boardProject(found, request.project);
      return { agent: found, project: where, jobs: this.jobsSeenBy(found, where) };
    });
    const fact = await board.find(request.id);
    const seen = fact?.project === project && (fact.job === undefined || jobs.includes(fact.job));
    if (!fact || !seen) {
      throw new BridgeError(
        'invalid_input',
        `There is no note ${request.id} on the board of ${project}`,
        {
          id: request.id,
        }
      );
    }
    if (agent && fact.source.by !== agent.name) {
      throw new BridgeError(
        'not_a_party',
        `The note ${fact.id} is what ${fact.source.by === PERSON ? 'the person' : fact.source.by} said: only they, or the person, let it go`,
        { id: fact.id }
      );
    }
    await board.forget(fact.id);
    await this.mutate(async (tx) => {
      this.journal(tx, {
        type: 'fact.forgotten',
        agent: agent?.name ?? PERSON,
        data: { id: fact.id, kind: fact.kind, project: fact.project, by: fact.source.by },
      });
    });
    return fact;
  }

  /** The text of a job as its caller wrote it: its first letter without what the bridge added. */
  private taskText(first: Pick<Letter, 'job' | 'body'>, job?: BridgeJob): string {
    const length = (job ?? this.jobIfAny(first.job))?.taskLength;
    return length === undefined ? first.body : first.body.slice(0, length);
  }

  /**
   * Whether the rules of an agent let it read a file without asking: its own, and those of every
   * agent up the chain of the jobs it carries out. The conductor of a recipe reads what whoever
   * started the recipe may. True on a bridge that was given no judge: what an agent names in its
   * own project it could read itself.
   */
  private async mayRead(from: AgentRecord, cwd: string, path: string): Promise<boolean> {
    if (!this.rights) return true;
    const ask: PermissionAsk = { tool: 'Read', access: 'read', paths: [path], cwd };
    try {
      const now = this.iso();
      const own = this.conducts(from)
        ? 'allow'
        : await this.rights({
            job: {
              number: 0,
              taskId: '',
              title: '',
              from: from.name,
              to: from.name,
              project: from.project,
              cwd,
              checks: [],
              budget: this.limits.budget,
              lettersUsed: 0,
              depth: 1,
              createdAt: now,
              deadlineAt: now,
              state: 'submitted',
              updatedAt: now,
            },
            delegator: from,
            ask,
          });
      if (own !== 'allow') return false;
      const carried = await this.enqueue(async () =>
        this.store
          .jobTasks({ to: from.name, states: ACTIVE_JOB_STATES })
          .flatMap((task) => jobOf(task) ?? [])
      );
      if (this.conducts(from) && carried.length === 0) return false;
      for (const job of carried) {
        if ((await this.rightsFor(job.number, ask)) !== 'allow') return false;
      }
      return true;
    } catch (error) {
      this.onError(asError(error));
      return false;
    }
  }

  /**
   * The block the bridge puts under the text of a job, see `buildHandover`: what the caller
   * named, the lines of the files it pointed at, and the notes of the board that fit the job.
   * Undefined when there is nothing to add. It never fails the hand-over and never holds it up
   * for long: what cannot be read or found in time is left out, and the block is kept small
   * enough for the letter to take it.
   */
  private async handoverFor(
    caller: string,
    request: Pick<CreateJobInput, 'body' | 'title' | 'context' | 'contextTokens'>
  ): Promise<string | undefined> {
    const from = await this.enqueue(async () => this.store.getAgent(caller));
    if (!from) return undefined;
    const room = Math.floor(
      (this.limits.maxBodyLength - request.body.length - HANDOVER_GAP.length) / 4
    );
    const budget = Math.min(request.contextTokens ?? this.limits.contextTokens, room);
    if (budget <= 0) return undefined;
    const build = async (): Promise<string | undefined> => {
      const about = `${request.title ?? ''}\n${request.body}`.slice(0, ABOUT_CHARS);
      const board = this.board;
      const [facts, earlier] = board
        ? await Promise.all([
            board.recall({ project: from.project, text: about, kinds: ['fact'], limit: 8 }),
            earlierLike(board, from.project, about),
          ])
        : [[], []];
      return buildHandover(
        request.context,
        {
          from: from.name,
          cwd: from.cwd,
          roots: [from.project, findCheckoutRoot(from.cwd)],
          top: findCheckoutRoot(from.cwd),
          mayRead: (path) => this.mayRead(from, from.cwd, path),
          facts,
          earlier,
        },
        budget
      );
    };
    try {
      return await within(
        build(),
        this.limits.contextTimeoutMs,
        'Putting the context of the job together'
      );
    } catch (error) {
      this.onError(asError(error));
      return undefined;
    }
  }

  /**
   * Notes how a job ended on the board of its project, in the bridge's own name: who did it for
   * whom, how it ended, what its checks showed and the start of what was reported. A later job
   * like it finds the note in its handover.
   */
  private noteOutcome(tx: Transaction, number: number, reported?: string): void {
    if (!this.board) return;
    const { job } = this.requireJob(number);
    tx.notes.push({
      kind: 'outcome',
      text: outcomeText(job, reported),
      project: job.project,
      source: { by: BRIDGE_SENDER, job: job.number, at: this.iso() },
    });
  }

  /** Puts on the board what a call left for it, after the call is stored. */
  private keepNotes(notes: readonly NewBoardFact[]): void {
    const board = this.board;
    if (!board || notes.length === 0) return;
    this.track(
      (async () => {
        for (const note of notes) {
          try {
            const kept = await board.remember(note);
            if (kept.kind !== 'outcome') await this.journalNote(kept, note.source.by);
          } catch (error) {
            this.onError(asError(error));
          }
        }
      })()
    );
  }

  /** @throws BridgeError `unknown_job` */
  async job(number: number): Promise<BridgeJob> {
    return this.enqueue(async () => this.requireJob(number).job);
  }

  /** Jobs, newest first, 200 at most unless `limit` says otherwise */
  async jobs(filter: JobTaskFilter = {}): Promise<BridgeJob[]> {
    const request = parse(JobsFilterSchema, filter, 'Cannot list jobs') as JobTaskFilter;
    return this.enqueue(async () =>
      this.store
        .jobTasks({ ...request, limit: request.limit ?? DEFAULT_LIST_LIMIT })
        .flatMap((task) => jobOf(task) ?? [])
    );
  }

  async agents(filter: AgentFilter = {}): Promise<AgentRecord[]> {
    const request = parse(AgentsFilterSchema, filter, 'Cannot list agents') as AgentFilter;
    return this.enqueue(async () => this.store.listAgents(request));
  }

  /**
   * Letters, oldest first, 200 at most unless `limit` says otherwise and no more text than fits
   * one answer. Go on from the last one with `afterSeq`
   */
  async letters(filter: LetterFilter = {}): Promise<Letter[]> {
    const request = parse(LettersFilterSchema, filter, 'Cannot list letters') as LetterFilter;
    return this.enqueue(async () =>
      fitting(
        this.store.listLetters({ ...request, limit: request.limit ?? DEFAULT_LIST_LIMIT }),
        (letter) => letter.body.length
      )
    );
  }

  /**
   * Entries of the journal, oldest first: the first 200 unless `limit` says otherwise, or the
   * last `tail`, and no more text than fits one answer. Go on from the last one with `afterSeq`
   */
  async readJournal(query: JournalQuery = {}): Promise<JournalEntry[]> {
    const request = parse(JournalQuerySchema, query, 'Cannot read the journal');
    const size = (entry: JournalEntry) =>
      typeof entry.data?.body === 'string' ? entry.data.body.length : 0;
    return this.enqueue(async () => {
      if (request.tail !== undefined) {
        const newestFirst = this.store.readJournal(request).reverse();
        return fitting(newestFirst, size).reverse();
      }
      return fitting(
        this.store.readJournal({ ...request, limit: request.limit ?? DEFAULT_LIST_LIMIT }),
        size
      );
    });
  }

  /**
   * What became of the jobs that ended within the window of the scoreboard
   * (`limits.scoreWindowMs`), newest first: who carried each out, its type, whether anything
   * confirmed its result, what its reviews found, how long it took, how many letters, and how
   * many times it needed the person. Canceled jobs and recipes are not among them.
   */
  async results(input: ResultsInput = {}): Promise<JobResult[]> {
    const request = parse(ResultsInputSchema, input, 'Cannot list the results');
    return this.enqueue(async () =>
      this.scored()
        .filter(
          (result) =>
            (request.type === undefined || result.type === request.type) &&
            (request.harness === undefined || result.harness === request.harness) &&
            (request.agent === undefined || result.agent === request.agent)
        )
        .slice(0, request.limit ?? DEFAULT_LIST_LIMIT)
    );
  }

  /**
   * Who a job should go to, by how earlier jobs went: every harness the bridge can start a
   * session of with its rate of jobs that held and the interval of that rate, the one `auto`
   * would take now, and why. With too few checked jobs it says so, and goes by the order of the
   * adapters instead of a rating it does not have.
   */
  async suggest(input: SuggestInput = {}): Promise<Suggestion> {
    const request = parse(SuggestInputSchema, input, 'Cannot suggest an agent');
    const { results, harnesses } = await this.enqueue(async () => ({
      results: this.scored(),
      harnesses: this.routable(),
    }));
    return suggestFrom(results, {
      ...(request.type !== undefined && { type: request.type }),
      minJobs: this.limits.scoreMinJobs,
      windowMs: this.limits.scoreWindowMs,
      harnesses,
      unavailable: () => undefined,
    });
  }

  /**
   * The harnesses the bridge can start a session of for a job. The conductor of recipes is none
   * of them: it takes a recipe, not a job.
   */
  async startable(): Promise<string[]> {
    return [...this.adapters.values()]
      .filter((adapter) => adapter.createSession !== undefined && !adapter.recipeProblem)
      .map((adapter) => adapter.harness);
  }

  /**
   * Whether an agent takes a letter by itself right now: it waits for its mail, or its harness
   * hands the letter over and wakes the session for it.
   */
  async wakes(name: string): Promise<boolean> {
    const agent = await this.enqueue(async () => this.store.getAgent(name));
    if (agent?.status !== 'active') return false;
    if (this.waiters.has(agent.name)) return true;
    const adapter = this.adapters.get(agent.harness);
    if (!adapter?.deliver || !adapter.capabilities.push) return false;
    if (!adapter.wakesFor) return true;
    try {
      return await within(
        adapter.wakesFor(agent),
        this.limits.deliveryTimeoutMs,
        `Asking whether ${agent.name} wakes for a letter`
      );
    } catch (error) {
      this.onError(asError(error));
      return false;
    }
  }

  /**
   * Whether an agent is a conductor: a session of an adapter that carries jobs out by recipes.
   * It has no rules of its own, and the jobs it hands out are bound by those of whoever started
   * its recipe.
   */
  private conducts(agent: AgentRecord | undefined): boolean {
    return agent !== undefined && this.adapters.get(agent.harness)?.recipeProblem !== undefined;
  }

  async status(): Promise<DispatcherStatus> {
    return this.enqueue(async () => ({
      agents: this.store.listAgents({ statuses: ['active', 'starting'] }).length,
      activeJobs: this.store.jobTasks({ states: ACTIVE_JOB_STATES }).length,
      queuedLetters: this.store.countLetters({ states: ['queued'] }),
      adapters: [...this.adapters.keys()],
      startable: [...this.adapters.values()]
        .filter((adapter) => adapter.createSession !== undefined && !adapter.recipeProblem)
        .map((adapter) => adapter.harness),
      waiting: [...this.waiters.keys()].sort(),
    }));
  }

  /**
   * What time does to jobs: fails those that ran past their budget, reminds the recipient of a
   * letter that got no reaction and fails the job when the reminder got none either, and tries
   * the deliveries that are due again. The host calls it on a timer.
   */
  async sweep(): Promise<SweepResult> {
    const result = await this.mutate(async (tx): Promise<SweepResult> => {
      const now = this.now();
      const failed: number[] = [];
      const reminded: string[] = [];
      this.recover(tx);
      this.sweepWorktrees(now);

      const overdue = this.store
        .jobTasks({ states: ACTIVE_JOB_STATES, deadlineBy: now })
        .flatMap((task) => jobOf(task) ?? [])
        .sort((a, b) => a.number - b.number);
      for (const late of overdue) {
        if (isFinishedJobState(this.requireJob(late.number).job.state)) continue;
        if (this.waitsForPerson(late.number)) continue;
        await this.failJob(tx, late.number, ranOutOfTime(late), 'timeout');
        failed.push(late.number);
      }

      for (const letter of this.store.listLetters({ replyDueBy: now })) {
        const fresh = this.store.getLetter(letter.id);
        if (!fresh?.replyDueAt) continue;
        const { job } = this.requireJob(letter.job);
        if (isFinishedJobState(job.state) || fresh.state === 'handled') {
          this.store.updateLetter(letter.id, { clear: ['replyDueAt'] });
          continue;
        }
        if (fresh.needsPerson) {
          const patience = this.limits.personReplyTimeoutMs;
          if (!fresh.remindedAt) {
            this.store.updateLetter(letter.id, {
              remindedAt: this.iso(now),
              replyDueAt: this.iso(now + patience),
            });
            tx.asked.push({ letter: letter.id, again: true });
            this.journal(tx, {
              type: 'letter.reminded',
              job: job.number,
              letter: letter.id,
              agent: PERSON,
            });
            reminded.push(letter.id);
            continue;
          }
          await this.failJob(
            tx,
            job.number,
            `the person did not answer the ${letter.kind} ${letter.id} in ${formatDuration(2 * patience)}`
          );
          failed.push(job.number);
          continue;
        }
        const pickup = expectationOf(letter.kind) === 'pickup';
        if (!fresh.remindedAt) {
          this.store.updateLetter(letter.id, {
            remindedAt: this.iso(now),
            replyDueAt: this.iso(now + job.budget.replyTimeoutMs),
          });
          const quote =
            letter.body.length > REMINDER_QUOTE_LENGTH
              ? `${letter.body.slice(0, REMINDER_QUOTE_LENGTH)}...`
              : letter.body;
          this.systemNote(
            tx,
            job,
            letter.to,
            `Reminder: the ${letter.kind} ${letter.id} from ${letter.from} still waits for ${pickup ? 'you to take it' : 'your answer'}. ` +
              `Without it job #${job.number} fails in ${formatDuration(job.budget.replyTimeoutMs)}. It says:\n${quoted(quote)}`
          );
          this.journal(tx, {
            type: 'letter.reminded',
            job: job.number,
            letter: letter.id,
            agent: letter.to,
          });
          reminded.push(letter.id);
          continue;
        }
        await this.failJob(
          tx,
          job.number,
          `${letter.to} did not ${pickup ? 'take' : 'answer'} the ${letter.kind} ${letter.id} in ${formatDuration(2 * job.budget.replyTimeoutMs)}`,
          letter.to === job.to ? 'silent' : 'other'
        );
        failed.push(job.number);
      }

      failed.push(...(await this.remindOfReports(tx, now)));
      failed.push(...(await this.retireAgents(tx, now)));
      for (const agent of this.store.queuedRecipients()) tx.wake.add(agent);
      return { failed: [...new Set(failed)], reminded };
    });
    this.checkPresence();
    return result;
  }

  /**
   * Reminds a session to report on a job it carries out and went quiet on. A session whose
   * waiter has been armed for `limits.reportReminderMs` has ended its turn, and when a job of it
   * is still in progress with nothing owed to it, its answer was most likely said only in its
   * own window, where whoever waits for the job does not read. The reminder is a letter, so it
   * wakes the session. One that does not react to it within the reply timeout of the job fails
   * the job, rather than leaving it open until its deadline, whether or not it waits for mail by
   * then: the hook of a session waits a shorter while than that. A session that reacts with
   * anything but a report is reminded again no sooner than that timeout.
   *
   * A session is left alone while its harness lists it in the middle of a turn, while it waits
   * for jobs it handed over from inside the job or for the person, and while mail for it is on
   * its way. Returns the jobs it failed.
   */
  private async remindOfReports(tx: Transaction, now: number): Promise<number[]> {
    const failed: number[] = [];
    const reminded = this.store
      .jobTasks({ states: ['working'] })
      .flatMap((task) => jobOf(task) ?? [])
      .filter((job) => job.reportAskedAt !== undefined);
    for (const job of reminded) {
      const asked = Date.parse(job.reportAskedAt ?? '');
      const patience = job.budget.replyTimeoutMs;
      if (now - asked < patience || this.wroteSince(job, asked) || !this.owesReport(job)) continue;
      if (this.inTurn(this.store.getAgent(job.to))) continue;
      await this.failJob(
        tx,
        job.number,
        `${job.to} ended its turn without a report and did not react to the reminder in ${formatDuration(patience)}`,
        'silent'
      );
      failed.push(job.number);
    }

    for (const [name, waiter] of this.waiters) {
      if (now - waiter.armedAt < this.limits.reportReminderMs) continue;
      const agent = this.store.getAgent(name);
      if (agent?.status !== 'active' || this.conducts(agent) || this.inTurn(agent)) continue;
      const carried = this.store
        .jobTasks({ to: name, states: ['working'] })
        .flatMap((task) => jobOf(task) ?? []);
      for (const job of carried) {
        if (!this.owesReport(job)) continue;
        if (job.reportAskedAt && now - Date.parse(job.reportAskedAt) < job.budget.replyTimeoutMs) {
          continue;
        }
        this.systemNote(
          tx,
          job,
          name,
          `You ended your turn, and job #${job.number} is still in progress: ${job.from} has no report from you. What you said in your own window nobody else reads. Report on the job with the report tool: when your answer is written there already, send that answer itself, whole, not a word about it. If you are not done, ask what you need, or say in a note what you wait for.`
        );
        await this.patchRecord(job.taskId, { reportAskedAt: this.iso(now) });
      }
    }
    return failed;
  }

  /**
   * Whether a job waits for nothing but the word of the agent that carries it out: its checks
   * do not run, it waits for no job handed over from inside it and for no answer of the person,
   * and no letter for the agent is on its way.
   */
  private owesReport(job: BridgeJob): boolean {
    if (job.checking || this.waitsForPerson(job.number)) return false;
    const parts = this.store.jobTasks({
      parent: job.number,
      states: ACTIVE_JOB_STATES,
      limit: 1,
    });
    if (parts.length > 0) return false;
    return this.store.countLetters({ to: job.to, states: ['queued'] }) === 0;
  }

  /** Whether the agent that carries a job out wrote a letter on it at or after a time. */
  private wroteSince(job: BridgeJob, since: number): boolean {
    const [last] = this.store.listLetters({
      job: job.number,
      from: job.to,
      newestFirst: true,
      limit: 1,
    });
    return last !== undefined && Date.parse(last.createdAt) >= since;
  }

  /** Whether the harness of a session listed it in the middle of a turn the last time. */
  private inTurn(agent: AgentRecord | undefined): boolean {
    return (
      agent !== undefined && this.presence.get(agent.harness)?.busy.has(agent.sessionId) === true
    );
  }

  /**
   * Asks the adapters that can list their sessions which of them still run, once in
   * `limits.presenceCheckMs`. A session that was listed and then is not, two times in a row, is
   * gone, and its jobs fail with that reason rather than after the reply timeout: one miss may
   * be a session between two states of its harness. A session with a waiter armed is there
   * whatever the list says. One that was never listed (its harness shows it nowhere) is left to
   * the idle rule, unless the adapter runs every session of its harness itself (`ownsSessions`):
   * then what it does not list is gone at once. A session heard from after the list was asked
   * for is not judged by it: it may have started meanwhile.
   */
  private checkPresence(): void {
    if (this.closing) return;
    const now = this.now();
    if (now - this.presenceCheckedAt < this.limits.presenceCheckMs) return;
    this.presenceCheckedAt = now;
    for (const [harness, adapter] of this.adapters) {
      if (!adapter.liveSessions || this.listing.has(harness)) continue;
      this.listing.add(harness);
      const asked = now;
      this.track(
        within(
          adapter.liveSessions(),
          this.limits.deliveryTimeoutMs,
          `Listing the ${harness} sessions`
        )
          .then((sessions) =>
            this.mutate(async (tx) => {
              await this.applyPresence(
                tx,
                harness,
                new Set(sessions.map((session) => session.sessionId)),
                adapter.ownsSessions === true,
                asked,
                new Set(sessions.flatMap((session) => (session.busy ? [session.sessionId] : [])))
              );
              for (const session of sessions) {
                const agent = this.store.agentOfSession(harness, session.sessionId);
                if (!session.waitingFor) {
                  if (agent) this.stuckNow.delete(agent.name);
                  continue;
                }
                if (agent?.status !== 'active') continue;
                await this.noteStuck(tx, agent, `It waits for: ${session.waitingFor}`, 'listing');
              }
            })
          )
          .finally(() => this.listing.delete(harness))
      );
    }
  }

  private async applyPresence(
    tx: Transaction,
    harness: string,
    live: Set<string>,
    certain: boolean,
    asked: number,
    busy = new Set<string>()
  ): Promise<void> {
    const known = this.presence.get(harness) ?? {
      live,
      seen: new Set(),
      missed: new Set(),
      busy: new Set(),
    };
    const missed = new Set<string>();
    for (const sessionId of live) known.seen.add(sessionId);
    for (const agent of this.store.listAgents({ harness, statuses: ['active'] })) {
      const id = agent.sessionId;
      if (live.has(id) || this.waiters.has(agent.name) || this.starting.has(agent.name)) continue;
      if (Date.parse(agent.lastSeenAt) >= asked) continue;
      if (!certain && !known.seen.has(id)) continue;
      if (!certain && !known.missed.has(id)) {
        missed.add(id);
        continue;
      }
      known.seen.delete(id);
      await this.agentGone(tx, agent, `the session of ${agent.name} is not running any more`);
    }
    this.presence.set(harness, { live, seen: known.seen, missed, busy });
  }

  /**
   * Takes sessions that are not there out of the address book, so a harness word keeps reaching
   * the session that is: one whose start never finished (the dispatcher that started it is
   * gone) fails its jobs, one that has been silent for `limits.agentIdleMs` and has no job in
   * progress just leaves. Returns the jobs it failed.
   */
  private async retireAgents(tx: Transaction, now: number): Promise<number[]> {
    const failed: number[] = [];
    for (const agent of this.store.listAgents({ statuses: ['starting'] })) {
      if (this.starting.has(agent.name)) continue;
      failed.push(
        ...(await this.agentGone(
          tx,
          agent,
          `the session of ${agent.name} never started: the dispatcher stopped while starting it`
        ))
      );
    }
    const silent = this.store.listAgents({
      statuses: ['active'],
      seenBefore: now - this.limits.agentIdleMs,
    });
    for (const agent of silent) {
      if (this.waiters.has(agent.name)) continue;
      if (this.presence.get(agent.harness)?.live.has(agent.sessionId)) continue;
      const busy = this.store.jobTasks({ party: agent.name, states: ACTIVE_JOB_STATES, limit: 1 });
      if (busy.length > 0) continue;
      this.store.putAgent({ ...agent, status: 'gone' });
      this.journal(tx, {
        type: 'agent.gone',
        agent: agent.name,
        data: { reason: 'idle', lastSeenAt: agent.lastSeenAt },
      });
    }
    return failed;
  }

  /** Marks an agent gone and fails every job it was to carry out. Returns those jobs. */
  private async agentGone(tx: Transaction, agent: AgentRecord, reason: string): Promise<number[]> {
    this.store.putAgent({ ...agent, status: 'gone' });
    this.journal(tx, { type: 'agent.gone', agent: agent.name, data: { error: reason } });
    const failed: number[] = [];
    for (const task of this.store.jobTasks({ to: agent.name, states: ACTIVE_JOB_STATES })) {
      const job = jobOf(task);
      if (!job) continue;
      await this.failJob(tx, job.number, reason);
      failed.push(job.number);
    }
    return failed;
  }

  /** Resolves once every call made so far is handled and every delivery it started has ended. */
  async idle(): Promise<void> {
    for (;;) {
      await this.queue;
      const running = [...this.deliveries.values(), ...this.background];
      if (running.length === 0) return;
      await Promise.allSettled(running);
    }
  }

  /**
   * Ends the waits, waits for the calls being handled, the deliveries and the session starts they
   * began, closes the adapters, then takes no more. A session a call asks for after this began
   * is not started: the next dispatcher finds it never started and fails its job. A delivery that hangs is given up on after `limits.deliveryTimeoutMs` and a
   * session start after `limits.sessionStartTimeoutMs`, so this always ends.
   */
  async close(): Promise<void> {
    this.closing = true;
    for (const run of this.checkRuns.values()) run.abort();
    for (const waiter of [...this.waiters.values()]) waiter.end('closed');
    for (const letter of [...this.verdictWaiters.keys()]) this.announce(letter);
    await this.idle();
    await Promise.all(
      [...this.adapters.values()].map(async (adapter) => {
        try {
          await adapter.close?.();
        } catch (error) {
          this.onError(asError(error));
        }
      })
    );
    this.closed = true;
  }

  private iso(ms: number = this.now()): string {
    return new Date(ms).toISOString();
  }

  private checkBody(body: string): void {
    if (body.length > this.limits.maxBodyLength) {
      throw new BridgeError(
        'invalid_input',
        `The letter is ${body.length} characters long, the limit is ${this.limits.maxBodyLength}. Put the details in a file and name it`
      );
    }
  }

  private async enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) throw new BridgeError('not_running', 'The bridge dispatcher is closed');
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private mutate<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.enqueue(() => this.transact(work));
  }

  /**
   * A call made as an agent, as one entry of the queue: first the sign of life is stored, on its
   * own, so a call the bridge then refuses still counts, then the call itself.
   */
  private asCaller<T>(caller: string, work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      await this.transact(async (tx) => this.heardFrom(tx, caller));
      return this.transact(work);
    });
  }

  private async transact<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const tx: Transaction = {
      entries: [],
      wake: new Set(),
      spawns: [],
      asked: [],
      settled: [],
      decided: new Set(),
      notices: [],
      checks: [],
      notes: [],
    };
    const result = await this.store.transaction(() => {
      this.assertWritable?.();
      return work(tx);
    });
    for (const entry of tx.entries) {
      try {
        this.emit('journal', entry);
      } catch (error) {
        this.onError(asError(error));
      }
    }
    if (!this.closing) {
      for (const spawn of tx.spawns) this.startSession(spawn.agent, spawn.job, spawn.letter);
    }
    for (const agent of tx.wake) this.wake(agent);
    for (const letter of tx.decided) this.announce(letter);
    if (!this.closing) for (const number of tx.checks) this.startChecks(number);
    this.keepNotes(tx.notes);
    this.tellPerson(tx);
    return result;
  }

  /** Lets those who wait for the verdict of a permission request look again. */
  private announce(letterId: string): void {
    const waiting = this.verdictWaiters.get(letterId);
    if (!waiting) return;
    this.verdictWaiters.delete(letterId);
    for (const look of waiting) look();
  }

  /**
   * Hands the person route what a call changed for it, after the call is stored and in the
   * order it happened. A route that throws, or takes longer than a delivery may, stops nothing:
   * the letter still waits in the bridge, and what comes after it is still told.
   */
  private tellPerson(tx: Pick<Transaction, 'asked' | 'settled' | 'notices'>): void {
    const route = this.person;
    if (!route || this.closing) return;
    if (tx.asked.length + tx.settled.length + tx.notices.length === 0) return;
    const rendered = (id: string) => {
      const letter = this.store.getLetter(id);
      if (!letter) return undefined;
      const { job } = this.requireJob(letter.job);
      return { letter: renderLetter(letter, job), job };
    };
    const news: Array<() => void | Promise<void>> = [];
    const settled = new Set(tx.settled);
    for (const { letter: id, again } of tx.asked) {
      if (settled.has(id)) continue;
      const found = rendered(id);
      if (found) news.push(() => route.ask({ ...found, again }));
    }
    for (const id of settled) {
      const found = rendered(id);
      if (found) news.push(() => route.settle(found));
    }
    for (const notice of tx.notices) news.push(() => route.tell?.(notice));
    for (const tell of news) {
      this.personNews = this.personNews
        .then(() =>
          within(
            Promise.resolve().then(tell),
            this.limits.deliveryTimeoutMs,
            'Telling the person of a letter'
          )
        )
        .catch((error: unknown) => {
          this.onError(asError(error));
        });
    }
    this.track(this.personNews);
  }

  private journal(tx: Transaction, entry: Omit<JournalEntry, 'seq' | 'at'>): void {
    tx.entries.push(this.store.appendJournal({ at: this.iso(), ...entry }));
  }

  /**
   * Notes that a session called: the time, and that a session the bridge took for gone is
   * there again.
   */
  private heardFrom(tx: Transaction, name: string): void {
    const known = this.store.getAgent(name);
    if (!known || known.status === 'starting' || known.sessionId === '') return;
    this.store.putAgent({ ...known, status: 'active', lastSeenAt: this.iso() });
    if (known.status !== 'gone') return;
    this.journal(tx, {
      type: 'agent.registered',
      agent: name,
      data: { harness: known.harness, returned: true },
    });
    tx.wake.add(name);
  }

  private requireCaller(name: string): AgentRecord {
    const agent = this.store.getAgent(name);
    if (agent?.status !== 'active') {
      throw new BridgeError(
        'not_registered',
        `${name} is not a session the bridge knows. Register the session first`,
        { agent: name }
      );
    }
    return agent;
  }

  private requireJob(number: number): { task: A2ATask; job: BridgeJob } {
    const task = this.store.taskOfJob(number);
    const job = task && jobOf(task);
    if (!task || !job)
      throw new BridgeError('unknown_job', `There is no job ${number}`, { job: number });
    return { task, job };
  }

  private jobFrom(task: A2ATask): BridgeJob {
    const job = jobOf(task);
    if (!job) throw new BridgeError('storage', `Task ${task.id} lost its job record`);
    return job;
  }

  private async patchRecord(taskId: string, patch: Partial<BridgeJobRecord>): Promise<void> {
    const task = await this.store.tasks.get(taskId);
    const record = task && jobRecordOf(task);
    if (!task || !record) throw new BridgeError('storage', `Task ${taskId} lost its job record`);
    await this.store.tasks.update(taskId, {
      metadata: { ...task.metadata, [BRIDGE_JOB_KEY]: { ...record, ...patch } },
    });
  }

  private async transition(
    tx: Transaction,
    number: number,
    to: JobState,
    message?: string
  ): Promise<void> {
    const { job } = this.requireJob(number);
    if (job.state === to && to !== 'input-required') return;
    if (to === 'canceled') {
      await this.tasks.cancelTask(job.taskId);
    } else if (to === 'working' && job.state === 'input-required') {
      await this.tasks.continueTask(job.taskId, userMessage(message ?? ''));
    } else if (to === 'submitted') {
      throw new BridgeError('storage', `Job ${number} cannot go back to submitted`);
    } else {
      await this.tasks.advanceTask(job.taskId, {
        state: to,
        ...(message !== undefined && to !== 'working' && { message }),
      });
    }
    if (job.state !== to) {
      this.journal(tx, { type: 'job.state', job: number, data: { from: job.state, to } });
      if (isFinishedJobState(to)) await this.patchRecord(job.taskId, { endedAt: this.iso() });
    }
  }

  private async pickUp(tx: Transaction, job: BridgeJob): Promise<void> {
    await this.transition(tx, job.number, 'working');
    for (const task of this.store.listLetters({ job: job.number, to: job.to, kinds: ['task'] })) {
      if (UNREAD_STATES.includes(task.state)) this.markRead(tx, task);
      else if (task.replyDueAt) this.store.updateLetter(task.id, { clear: ['replyDueAt'] });
    }
  }

  /**
   * Fails a job. `failure` says whose doing it was: the scoreboard holds only what its agent did
   * against the agent.
   */
  private async failJob(
    tx: Transaction,
    number: number,
    reason: string,
    failure: JobFailure = 'other'
  ): Promise<void> {
    const { job } = this.requireJob(number);
    if (isFinishedJobState(job.state)) return;
    await this.transition(tx, number, 'failed', reason);
    await this.patchRecord(job.taskId, { reason, failure });
    this.closeLetters(tx, number);
    await this.stopWaiting(number, this.now(), false);
    this.noteOutcome(tx, number);
    const text = `Job #${number} has failed: ${reason}.`;
    this.systemNote(tx, job, job.from, text);
    this.systemNote(tx, job, job.to, `${text} Stop working on it.`);
    await this.cancelChildren(tx, job);
  }

  private async cancelJob(
    tx: Transaction,
    number: number,
    reason: string,
    note: string
  ): Promise<void> {
    const { job } = this.requireJob(number);
    if (isFinishedJobState(job.state)) return;
    await this.transition(tx, number, 'canceled', reason);
    await this.patchRecord(job.taskId, { reason });
    this.closeLetters(tx, number);
    await this.stopWaiting(number, this.now(), false);
    this.noteOutcome(tx, number);
    this.systemNote(tx, job, job.to, note);
    await this.cancelChildren(tx, job);
  }

  /** A job that is over takes the jobs handed over from inside it with it: nobody waits for them. */
  private async cancelChildren(tx: Transaction, parent: BridgeJob): Promise<void> {
    const children = this.store.jobTasks({ parent: parent.number, states: ACTIVE_JOB_STATES });
    for (const task of children) {
      const child = jobOf(task);
      if (!child) continue;
      const reason = `job #${parent.number}, which it was part of, is over`;
      await this.cancelJob(
        tx,
        child.number,
        reason,
        `Job #${child.number} was canceled: ${reason}. Stop working on it.`
      );
      this.systemNote(tx, child, child.from, `Job #${child.number} was canceled: ${reason}.`);
    }
  }

  /**
   * Why an agent may not hand this job over right now, if it may not: it is the job it already
   * handed to the same agent and that is still in progress (for a job left to `auto`: one it
   * left to `auto` before, whoever got it), it has too many jobs out, it hands jobs over too
   * fast, or too many sessions are being started.
   */
  private handOverRefusal(
    from: AgentRecord,
    resolution: ReturnType<typeof resolveAddress>,
    body: string,
    cwd: string,
    now: number,
    routed = false
  ): BridgeError | undefined {
    const open = this.store
      .jobTasks({ from: from.name, states: ACTIVE_JOB_STATES })
      .flatMap((task) => jobOf(task) ?? []);
    const wanted = normalizeBody(body);
    const sameAgent = (job: BridgeJob): boolean =>
      routed
        ? job.routed !== undefined
        : resolution.kind === 'agent'
          ? job.to === resolution.agent.name
          : this.store.getAgent(job.to)?.harness === resolution.harness;
    const same = open.find((job) => {
      if (job.cwd !== cwd || !sameAgent(job)) return false;
      const first = this.store.listLetters({ job: job.number, kinds: ['task'], limit: 1 })[0];
      return first !== undefined && normalizeBody(this.taskText(first, job)) === wanted;
    });
    if (same) {
      return new BridgeError(
        'loop_detected',
        `You already handed this job to ${same.to} as job #${same.number}, and it is still ${same.state}. Wait for its report, or cancel it first`,
        { job: same.number }
      );
    }
    if (open.length >= this.limits.maxOpenJobs) {
      return new BridgeError(
        'budget_exhausted',
        `You have ${open.length} jobs out that are still in progress, the most there may be. Wait for their reports or cancel some`,
        { open: open.length, max: this.limits.maxOpenJobs }
      );
    }
    const recent = this.store.jobTasks({ from: from.name, createdSince: now - 3_600_000 }).length;
    if (recent >= this.limits.jobsPerHour) {
      return new BridgeError(
        'budget_exhausted',
        `You handed over ${recent} jobs in the last hour, the most there may be. This looks like a loop: stop and tell the person what is going on`,
        { recent, max: this.limits.jobsPerHour }
      );
    }
    return resolution.kind === 'spawn' ? this.startingRefusal() : undefined;
  }

  /**
   * A finished job waits for nothing: its own letter and the questions nobody answered are done
   * with, and no letter of it is due any more.
   */
  private closeLetters(tx: Transaction, number: number, except?: string): void {
    for (const letter of this.store.listLetters({ job: number })) {
      if (letter.id === except) continue;
      if (expectationOf(letter.kind) !== 'none' && letter.state !== 'handled') {
        this.markHandled(tx, letter);
      } else if (letter.replyDueAt) {
        this.store.updateLetter(letter.id, { clear: ['replyDueAt'] });
      }
    }
  }

  private acceptLetter(
    tx: Transaction,
    fields: Pick<Letter, 'id' | 'job' | 'kind' | 'from' | 'to' | 'body'> &
      Partial<
        Pick<
          Letter,
          | 'inReplyTo'
          | 'outcome'
          | 'replyDueAt'
          | 'ask'
          | 'verdict'
          | 'needsPerson'
          | 'personAskedAt'
        >
      >
  ): Letter {
    const letter = this.store.insertLetter({
      ...fields,
      state: 'queued',
      createdAt: this.iso(),
      attempts: 0,
    });
    this.journal(tx, {
      type: 'letter.queued',
      job: letter.job,
      letter: letter.id,
      agent: letter.from,
      data: {
        kind: letter.kind,
        from: letter.from,
        to: letter.to,
        body: letter.body,
        ...(letter.inReplyTo && { inReplyTo: letter.inReplyTo }),
        ...(letter.outcome && { outcome: letter.outcome }),
        ...(letter.ask && { ask: letter.ask }),
        ...(letter.verdict && { verdict: letter.verdict }),
        ...(letter.needsPerson && { needsPerson: true }),
      },
    });
    tx.wake.add(letter.to);
    return letter;
  }

  /** A letter the bridge writes itself. It costs the job nothing and is never held back as a repeat. */
  private systemNote(tx: Transaction, job: BridgeJob, to: string, body: string): Letter {
    return this.acceptLetter(tx, {
      id: this.letterId(),
      job: job.number,
      kind: 'note',
      from: BRIDGE_SENDER,
      to,
      body,
    });
  }

  private answeredLetter(
    request: z.output<typeof SendLetterInputSchema>,
    job: BridgeJob,
    caller: string
  ): Letter | undefined {
    if (request.inReplyTo) {
      const target = this.store.getLetter(request.inReplyTo);
      if (target?.job !== job.number) {
        throw new BridgeError(
          'invalid_letter',
          `Job ${job.number} has no letter ${request.inReplyTo} to reply to`,
          {
            letter: request.inReplyTo,
          }
        );
      }
      if (request.kind !== 'answer') return target;
      if (target.to !== caller || !NEEDS_ANSWER.includes(target.kind)) {
        throw new BridgeError(
          'invalid_letter',
          `The letter ${target.id} is not a question to you, so it takes no answer`,
          {
            letter: target.id,
          }
        );
      }
      if (target.state === 'handled') {
        throw new BridgeError(
          'invalid_letter',
          `The ${target.kind} ${target.id} is already answered`,
          {
            letter: target.id,
          }
        );
      }
      return target;
    }
    if (request.kind !== 'answer') return undefined;
    return this.openLetter(job.number, caller);
  }

  /**
   * The one letter of a job that waits for the caller's answer.
   *
   * @throws BridgeError `invalid_letter` when none does, or several do
   */
  private openLetter(number: number, caller: string): Letter {
    const open = this.store.listLetters({
      job: number,
      to: caller,
      kinds: NEEDS_ANSWER,
      states: ['queued', 'delivered', 'read'],
    });
    if (open.length === 1) return open[0];
    if (open.length === 0) {
      throw new BridgeError(
        'invalid_letter',
        `Nothing on job ${number} waits for your answer. Send a note instead`,
        {
          job: number,
        }
      );
    }
    throw new BridgeError(
      'invalid_letter',
      `Several letters on job ${number} wait for your answer: ${open.map((letter) => letter.id).join(', ')}. Say which one with inReplyTo`,
      { job: number, letters: open.map((letter) => letter.id) }
    );
  }

  private markRead(tx: Transaction, letter: Letter): Letter {
    if (STATE_RANK[letter.state] >= STATE_RANK.read) return letter;
    const updated = this.store.updateLetter(letter.id, {
      state: 'read',
      readAt: this.iso(),
      clear:
        expectationOf(letter.kind) === 'pickup'
          ? ['nextAttemptAt', 'replyDueAt']
          : ['nextAttemptAt'],
    });
    this.journal(tx, { type: 'letter.read', job: letter.job, letter: letter.id, agent: letter.to });
    return updated;
  }

  private markHandled(tx: Transaction, letter: Letter): Letter {
    if (letter.state === 'handled') return letter;
    const now = this.iso();
    const updated = this.store.updateLetter(letter.id, {
      state: 'handled',
      handledAt: now,
      ...(letter.readAt === undefined && { readAt: now }),
      clear: ['nextAttemptAt', 'replyDueAt'],
    });
    this.journal(tx, {
      type: 'letter.handled',
      job: letter.job,
      letter: letter.id,
      agent: letter.to,
    });
    if (letter.needsPerson) tx.settled.push(letter.id);
    if (letter.kind === 'permission' && letter.ask) tx.decided.add(letter.id);
    return updated;
  }

  /**
   * Records that an adapter handed a letter to its session. A job handed over this way counts as
   * taken: the harness has it and woke the session, which may work without calling the bridge
   * until it reports. The letter is read only once the session calls about the job.
   */
  private async markDelivered(
    tx: Transaction,
    letterId: string,
    data?: Record<string, unknown>
  ): Promise<void> {
    this.inHand.delete(letterId);
    const letter = this.store.getLetter(letterId);
    if (letter?.state !== 'queued') return;
    const taken = expectationOf(letter.kind) === 'pickup';
    this.store.updateLetter(letterId, {
      state: 'delivered',
      deliveredAt: this.iso(),
      clear: taken ? ['nextAttemptAt', 'lastError', 'replyDueAt'] : ['nextAttemptAt', 'lastError'],
    });
    this.journal(tx, {
      type: 'letter.delivered',
      job: letter.job,
      letter: letter.id,
      agent: letter.to,
      ...(data && { data }),
    });
    if (taken && this.requireJob(letter.job).job.state === 'submitted') {
      await this.transition(tx, letter.job, 'working');
    }
  }

  private track(work: Promise<void>): void {
    const tracked = work
      .catch((error: unknown) => this.onError(asError(error)))
      .finally(() => this.background.delete(tracked));
    this.background.add(tracked);
  }

  /** Delivers what waits for an agent, one letter after another, in the order they were accepted. */
  private wake(agent: string): void {
    const previous = this.deliveries.get(agent) ?? Promise.resolve();
    const next: Promise<void> = previous
      .then(() => this.deliverTo(agent))
      .catch((error: unknown) => this.onError(asError(error)))
      .finally(() => {
        if (this.deliveries.get(agent) === next) this.deliveries.delete(agent);
      });
    this.deliveries.set(agent, next);
  }

  private async deliverTo(name: string): Promise<void> {
    for (;;) {
      if (this.closing) return;
      const next = await this.enqueue(async () => {
        if (this.starting.has(name)) return undefined;
        const agent = this.store.getAgent(name);
        if (agent?.status !== 'active') return undefined;
        const waiter = this.waiters.get(name);
        if (waiter) {
          const letters = this.queuedFor(name, waiter.limit);
          if (letters.length > 0) {
            this.hand(name, letters, waiter.signal);
            waiter.end('letters', letters);
          }
          return undefined;
        }
        const adapter = this.adapters.get(agent.harness);
        const deliver = adapter?.capabilities.push ? adapter.deliver?.bind(adapter) : undefined;
        if (!deliver) return undefined;
        const letter = this.store.listLetters({
          to: name,
          states: ['queued'],
          attemptsBelow: this.limits.deliveryAttempts,
          limit: 1,
        })[0];
        if (!letter || this.held(letter.id)) return undefined;
        if (letter.nextAttemptAt && Date.parse(letter.nextAttemptAt) > this.now()) return undefined;
        const { job } = this.requireJob(letter.job);
        this.inHand.set(letter.id, {
          agent: name,
          until: this.now() + this.limits.deliveryTimeoutMs,
          pushing: true,
        });
        return { agent, deliver, job, letter: renderLetter(letter, job) };
      });
      if (!next) return;

      let note: string | undefined;
      try {
        const receipt = await within(
          next.deliver({ agent: next.agent, letter: next.letter, job: next.job }),
          this.limits.deliveryTimeoutMs,
          `Delivering the letter ${next.letter.id} to ${name}`
        );
        note = receipt?.note;
      } catch (error) {
        this.inHand.delete(next.letter.id);
        await this.mutate(async (tx) => this.deliveryFailed(tx, next.letter.id, asError(error)));
        return;
      }
      this.inHand.delete(next.letter.id);
      await this.mutate((tx) =>
        this.markDelivered(tx, next.letter.id, note ? { note } : undefined)
      );
    }
  }

  private deliveryFailed(tx: Transaction, letterId: string, error: Error): void {
    const letter = this.store.getLetter(letterId);
    if (letter?.state !== 'queued') return;
    const attempts = letter.attempts + 1;
    if (attempts >= this.limits.deliveryAttempts) {
      this.store.updateLetter(letterId, {
        attempts,
        lastError: error.message,
        clear: ['nextAttemptAt'],
      });
      this.journal(tx, {
        type: 'letter.undelivered',
        job: letter.job,
        letter: letter.id,
        agent: letter.to,
        data: { attempts, error: error.message },
      });
      return;
    }
    this.store.updateLetter(letterId, {
      attempts,
      lastError: error.message,
      nextAttemptAt: this.iso(this.now() + deliveryBackoff(attempts, this.limits)),
    });
  }

  private startSession(agentName: string, jobNumber: number, letterId: string): void {
    this.starting.add(agentName);
    this.track(
      this.runSessionStart(agentName, jobNumber, letterId).finally(() => {
        if (this.starting.delete(agentName)) this.wakeIfKnown(agentName);
      })
    );
  }

  private wakeIfKnown(agentName: string): void {
    if (this.closing) return;
    this.track(
      this.enqueue(async () => {
        if (this.store.getAgent(agentName)?.status === 'active') this.wake(agentName);
      })
    );
  }

  private async runSessionStart(
    agentName: string,
    jobNumber: number,
    letterId: string
  ): Promise<void> {
    const request = await this.enqueue(async () => {
      const agent = this.store.getAgent(agentName);
      const letter = this.store.getLetter(letterId);
      if (!agent || !letter) return undefined;
      const { job } = this.requireJob(jobNumber);
      return { agent, job, letter: renderLetter(letter, job) };
    });
    const adapter = request && this.adapters.get(request.agent.harness);
    if (!request || !adapter?.createSession) return;

    let created: CreatedSession;
    try {
      const place = await this.placeOf(agentName, request.job, letterId);
      created = await within(
        adapter.createSession({
          agentName,
          harness: request.agent.harness,
          project: request.agent.project,
          cwd: place?.job.cwd ?? request.agent.cwd,
          ...(request.agent.sessionName && { sessionName: request.agent.sessionName }),
          job: place?.job ?? request.job,
          firstLetter: place?.letter ?? request.letter,
        }),
        this.limits.sessionStartTimeoutMs,
        `Starting a ${request.agent.harness} session`
      );
      if (!created.sessionId.trim()) throw new Error('the adapter returned no session id');
    } catch (error) {
      const message = asError(error).message;
      await this.mutate(async (tx) => {
        const agent = this.store.getAgent(agentName);
        if (agent?.status !== 'starting') return;
        await this.agentGone(
          tx,
          agent,
          `the bridge could not start a ${request.agent.harness} session: ${message}`
        );
      });
      return;
    }

    await this.mutate(async (tx) => {
      const agent = this.store.getAgent(agentName);
      if (!agent) return;
      const other = this.store.agentOfSession(agent.harness, created.sessionId);
      let name = agentName;
      if (other && other.name !== agentName) {
        this.store.mergeAgent(agentName, other.name);
        name = other.name;
      } else {
        this.store.putAgent({
          ...agent,
          sessionId: created.sessionId,
          ...(created.sessionName && { sessionName: created.sessionName }),
          status: 'active',
          lastSeenAt: this.iso(),
        });
        if (agent.status === 'starting') {
          this.journal(tx, {
            type: 'agent.registered',
            agent: name,
            data: { harness: agent.harness, started: true },
          });
        }
      }
      if (created.deliveredFirstLetter) await this.markDelivered(tx, letterId);
      if (name !== agentName) tx.wake.add(name);
    });
  }
}
