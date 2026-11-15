import { EventEmitter } from 'node:events';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import type { z } from 'zod';
import { TaskManager, textPart, toMessage, type A2ATask } from '@cogitator-ai/a2a';
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
  InboxInputSchema,
  JobsFilterSchema,
  JournalQuerySchema,
  LettersFilterSchema,
  SendLetterInputSchema,
  VerificationInputSchema,
  type CreateJobInput,
  type InboxInput,
  type SendLetterInput,
} from './inputs.js';
import { isFinishedJobState, jobOf, jobRecordOf } from './job-record.js';
import { expectationOf, newLetterId, renderLetter, repeats, titleOf } from './letters.js';
import { findProjectRoot } from './paths.js';
import { allocateAgentName, resolveAddress } from './registry.js';
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
  INBOX_DELIVERY,
  NO_CAPABILITIES,
  type AgentRecord,
  type BridgeAdapter,
  type BridgeJob,
  type BridgeJobRecord,
  type BridgeLimits,
  type CallerIdentity,
  type CreatedSession,
  type DeliveryState,
  type JobState,
  type JobVerification,
  type JournalEntry,
  type Letter,
  type LetterKind,
  type RenderedLetter,
} from './types.js';

export interface BridgeDispatcherOptions {
  store: BridgeStore;
  /** How the bridge reaches the sessions of each harness. A harness without one reads its inbox */
  adapters?: readonly BridgeAdapter[];
  limits?: BridgeLimitsInput;
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
}

export interface BridgeDispatcherEvents {
  /** Every entry of the journal, once what it tells is stored */
  journal: [JournalEntry];
}

const ACTIVE_JOB_STATES: readonly JobState[] = ['submitted', 'working', 'input-required'];
const UNREAD_STATES: readonly DeliveryState[] = ['queued', 'delivered'];
const NEEDS_ANSWER: readonly LetterKind[] = ['question', 'permission'];
const REMINDER_QUOTE_LENGTH = 500;

const STATE_RANK: Readonly<Record<DeliveryState, number>> = {
  queued: 0,
  delivered: 1,
  read: 2,
  handled: 3,
};

/** What a call wrote that only counts once it is stored. */
interface Transaction {
  entries: JournalEntry[];
  /** Agents with new mail */
  wake: Set<string>;
  spawns: Array<{ agent: string; job: number; letter: string }>;
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

/** How many queued letters of one agent a delivery pass looks at to find the next one to try. */
const DELIVERY_WINDOW = 100;

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
export class BridgeDispatcher extends EventEmitter<BridgeDispatcherEvents> {
  readonly limits: BridgeLimits;
  private readonly store: BridgeStore;
  private readonly tasks: TaskManager;
  private readonly adapters = new Map<string, BridgeAdapter>();
  private readonly now: () => number;
  private readonly letterId: () => string;
  private readonly onError: (error: Error) => void;
  private readonly assertWritable: (() => void) | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly deliveries = new Map<string, Promise<void>>();
  private readonly background = new Set<Promise<void>>();
  /**
   * Agents whose session an adapter is starting right now. Nothing is pushed to them until the
   * adapter reports back, since it may have handed the job's first letter over itself
   */
  private readonly starting = new Set<string>();
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
    for (const adapter of options.adapters ?? []) {
      if (this.adapters.has(adapter.harness)) {
        throw new BridgeError('invalid_input', `Two adapters for the harness ${adapter.harness}`);
      }
      this.adapters.set(adapter.harness, adapter);
    }
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
      const cwd = resolvePath(caller.cwd);
      const project = caller.project ? resolvePath(caller.project) : findProjectRoot(cwd);
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
          status: 'active',
          lastSeenAt: now,
        };
        this.store.putAgent(agent);
        if (known.status !== 'active') tx.wake.add(agent.name);
        return agent;
      }

      const started = caller.agentName ? this.store.getAgent(caller.agentName) : undefined;
      if (started?.harness === caller.harness && started.status === 'starting') {
        const agent: AgentRecord = {
          ...started,
          ...reach,
          sessionId: caller.sessionId,
          ...(caller.sessionName && { sessionName: caller.sessionName }),
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
    const outcome = await this.mutate(async (tx): Promise<CreateJobResult | Refusal> => {
      const from = this.requireCaller(caller);

      if (request.letterId) {
        const sent = this.store.getLetter(request.letterId);
        if (sent) {
          if (sent.kind !== 'task' || sent.from !== from.name) {
            throw new BridgeError('invalid_letter', `The letter id ${request.letterId} is taken`, {
              letter: request.letterId,
            });
          }
          return { job: this.requireJob(sent.job).job, letter: sent, duplicate: true };
        }
      }

      const resolution = resolveAddress(this.store, request.to, {
        project: from.project,
        caller: from.name,
        canSpawn: (harness) => this.adapters.get(harness)?.createSession !== undefined,
      });

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
        parent = carriedOut[0];
      }
      let depth: number;
      try {
        depth = nextDepth(
          carriedOut.map((job) => job.depth),
          this.limits
        );
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
      const cwd = request.cwd
        ? isAbsolute(request.cwd)
          ? resolvePath(request.cwd)
          : resolvePath(from.cwd, request.cwd)
        : from.cwd;

      const now = this.now();
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
        ...(request.worktree && { worktree: resolvePath(cwd, request.worktree) }),
        checks: request.checks ?? [],
        budget,
        lettersUsed: 1,
        depth,
        ...(parent && { parent: parent.number }),
        deadlineAt: this.iso(now + budget.durationMs),
      };
      const task = await this.tasks.createTask(userMessage(request.body), undefined, {
        agentName: to.name,
        metadata: { [BRIDGE_JOB_KEY]: record },
      });
      this.journal(tx, {
        type: 'job.created',
        job: number,
        agent: from.name,
        data: { title: record.title, from: from.name, to: to.name, depth, cwd },
      });

      const letter = this.accept(tx, {
        id: request.letterId ?? this.letterId(),
        job: number,
        kind: 'task',
        from: from.name,
        to: to.name,
        body: request.body,
        replyDueAt: this.iso(now + budget.replyTimeoutMs),
      });
      if (resolution.kind === 'spawn') {
        tx.wake.delete(to.name);
        tx.spawns.push({ agent: to.name, job: number, letter: letter.id });
      }
      return { job: this.jobFrom(task), letter, duplicate: false };
    });
    if (outcome instanceof Refusal) throw outcome.error;
    return outcome;
  }

  /**
   * Sends a letter on a job to its other party: a question, an answer, a report that ends the
   * job, a note. The call returns once the bridge has the letter, the answer comes as a letter.
   *
   * @throws BridgeError `not_registered`, `unknown_job`, `not_a_party`, `job_finished`,
   * `invalid_letter`, `loop_detected` (the same letter twice in a row), `budget_exhausted` (the
   * job ran out of letters or time, and has failed)
   */
  async send(caller: string, input: SendLetterInput): Promise<SendLetterResult> {
    const request = parse(SendLetterInputSchema, input, 'Cannot send the letter');
    this.checkBody(request.body);
    const outcome = await this.mutate(async (tx): Promise<SendLetterResult | Refusal> => {
      const from = this.requireCaller(caller);

      if (request.id) {
        const sent = this.store.getLetter(request.id);
        if (sent) {
          if (sent.from !== from.name || sent.job !== request.job || sent.kind !== request.kind) {
            throw new BridgeError('invalid_letter', `The letter id ${request.id} is taken`, {
              letter: request.id,
            });
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

      const answered = this.answeredLetter(request, job, from.name);

      const previous = this.store.listLetters({
        job: job.number,
        from: from.name,
        to,
        newestFirst: true,
        limit: 1,
      })[0];
      if (repeats(previous, request.kind, request.body)) {
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
      const exhausted = exhaustedBudget(job, now);
      if (exhausted) {
        const reason =
          exhausted === 'letters'
            ? `the job used all ${job.budget.letters} letters of its budget`
            : `the job ran longer than its ${formatDuration(job.budget.durationMs)} budget`;
        await this.failJob(tx, job.number, reason);
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

      const letter = this.accept(tx, {
        id: request.id ?? this.letterId(),
        job: job.number,
        kind: request.kind,
        from: from.name,
        to,
        body: request.body,
        ...(answered && { inReplyTo: answered.id }),
        ...(request.kind === 'report' && { outcome: request.outcome ?? 'completed' }),
        ...(expectationOf(request.kind) === 'reply' && {
          replyDueAt: this.iso(now + job.budget.replyTimeoutMs),
        }),
      });
      await this.patchRecord(job.taskId, { lettersUsed: job.lettersUsed + 1 });

      if (answered && request.kind === 'answer') this.markHandled(tx, answered);
      if (request.kind === 'report') {
        const state = letter.outcome === 'failed' ? 'failed' : 'completed';
        await this.transition(tx, job.number, state, request.body);
        if (state === 'failed')
          await this.patchRecord(job.taskId, { reason: `reported as failed by ${from.name}` });
        this.closeLetters(tx, job.number, letter.id);
      } else if (isAssignee && NEEDS_ANSWER.includes(request.kind)) {
        await this.transition(tx, job.number, 'input-required', request.body);
      } else if (request.kind === 'answer' && !isAssignee) {
        const open = this.store.countLetters({
          job: job.number,
          from: job.to,
          kinds: NEEDS_ANSWER,
          states: ['queued', 'delivered', 'read'],
        });
        if (open === 0 && this.requireJob(job.number).job.state === 'input-required') {
          await this.transition(tx, job.number, 'working', request.body);
        }
      }
      return { letter, job: this.requireJob(job.number).job, duplicate: false };
    });
    if (outcome instanceof Refusal) throw outcome.error;
    return outcome;
  }

  /**
   * The letters waiting for the caller, oldest first, each with the text to show. Taking them
   * marks them read, and taking a job's first letter starts the job.
   */
  async inbox(caller: string, input: InboxInput = {}): Promise<RenderedLetter[]> {
    const request = parse(InboxInputSchema, input, 'Cannot read the inbox');
    return this.mutate(async (tx) => {
      const agent = this.requireCaller(caller);
      const letters = this.store.listLetters({
        to: agent.name,
        states: request.unhandled ? ['queued', 'delivered', 'read'] : UNREAD_STATES,
        ...(request.job !== undefined && { job: request.job }),
      });
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
   * Says the caller is done with a letter that needs no answer. A question, a permission request
   * and a job's first letter are not dismissed this way: they are marked read, and are done with
   * once answered or reported on.
   *
   * @throws BridgeError `unknown_letter` for a letter that is not addressed to the caller
   */
  async acknowledge(caller: string, letterId: string): Promise<Letter> {
    return this.mutate(async (tx) => {
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
    return this.mutate(async (tx) => {
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
      const why = reason?.trim() || `canceled by ${agent.name}`;
      await this.transition(tx, number, 'canceled', why);
      await this.patchRecord(job.taskId, { reason: why });
      this.closeLetters(tx, number);
      this.systemNote(
        tx,
        job,
        job.to,
        `Job #${number} was canceled by ${agent.name}: ${why}. Stop working on it.`
      );
      return this.requireJob(number).job;
    });
  }

  /** Records whether the checks of a job confirmed its result. */
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

  /** @throws BridgeError `unknown_job` */
  async job(number: number): Promise<BridgeJob> {
    return this.enqueue(async () => this.requireJob(number).job);
  }

  /** Jobs, newest first */
  async jobs(filter: JobTaskFilter = {}): Promise<BridgeJob[]> {
    const request = parse(JobsFilterSchema, filter, 'Cannot list jobs') as JobTaskFilter;
    return this.enqueue(async () =>
      this.store.jobTasks(request).flatMap((task) => jobOf(task) ?? [])
    );
  }

  async agents(filter: AgentFilter = {}): Promise<AgentRecord[]> {
    const request = parse(AgentsFilterSchema, filter, 'Cannot list agents') as AgentFilter;
    return this.enqueue(async () => this.store.listAgents(request));
  }

  async letters(filter: LetterFilter = {}): Promise<Letter[]> {
    const request = parse(LettersFilterSchema, filter, 'Cannot list letters') as LetterFilter;
    return this.enqueue(async () => this.store.listLetters(request));
  }

  async readJournal(query: JournalQuery = {}): Promise<JournalEntry[]> {
    const request = parse(JournalQuerySchema, query, 'Cannot read the journal');
    return this.enqueue(async () => this.store.readJournal(request));
  }

  async status(): Promise<DispatcherStatus> {
    return this.enqueue(async () => ({
      agents: this.store.listAgents({ statuses: ['active', 'starting'] }).length,
      activeJobs: this.store.jobTasks({ states: ACTIVE_JOB_STATES }).length,
      queuedLetters: this.store.countLetters({ states: ['queued'] }),
      adapters: [...this.adapters.keys()],
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

      for (const task of this.store.jobTasks({ states: ACTIVE_JOB_STATES })) {
        const job = jobOf(task);
        if (!job || now < Date.parse(job.deadlineAt)) continue;
        await this.failJob(
          tx,
          job.number,
          `it ran longer than its ${formatDuration(job.budget.durationMs)} budget`
        );
        failed.push(job.number);
      }

      for (const letter of this.store.listLetters({ replyDueBy: now })) {
        const fresh = this.store.getLetter(letter.id);
        if (!fresh?.replyDueAt) continue;
        const { job } = this.requireJob(letter.job);
        if (isFinishedJobState(job.state) || fresh.state === 'handled') {
          this.store.updateLetter(letter.id, { clear: ['replyDueAt'] });
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
              `Without it job #${job.number} fails in ${formatDuration(job.budget.replyTimeoutMs)}.\n\n${quote}`
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
          `${letter.to} did not ${pickup ? 'take' : 'answer'} the ${letter.kind} ${letter.id} in ${formatDuration(2 * job.budget.replyTimeoutMs)}`
        );
        failed.push(job.number);
      }

      for (const letter of this.store.listLetters({ states: ['queued'] })) tx.wake.add(letter.to);
      return { failed, reminded };
    });
    return result;
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
   * Waits for the calls being handled and the deliveries they started, then takes no more. A
   * delivery that hangs is given up on after `limits.deliveryTimeoutMs`, so this always ends.
   */
  async close(): Promise<void> {
    this.closing = true;
    await this.idle();
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
    return this.enqueue(async () => {
      const tx: Transaction = { entries: [], wake: new Set(), spawns: [] };
      const result = await this.store.transaction(() => {
        this.assertWritable?.();
        return work(tx);
      });
      for (const entry of tx.entries) this.emit('journal', entry);
      for (const spawn of tx.spawns) this.startSession(spawn.agent, spawn.job, spawn.letter);
      for (const agent of tx.wake) this.wake(agent);
      return result;
    });
  }

  private journal(tx: Transaction, entry: Omit<JournalEntry, 'seq' | 'at'>): void {
    tx.entries.push(this.store.appendJournal({ at: this.iso(), ...entry }));
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
    }
  }

  private async pickUp(tx: Transaction, job: BridgeJob): Promise<void> {
    await this.transition(tx, job.number, 'working');
    for (const task of this.store.listLetters({ job: job.number, to: job.to, kinds: ['task'] })) {
      if (UNREAD_STATES.includes(task.state)) this.markRead(tx, task);
      else if (task.replyDueAt) this.store.updateLetter(task.id, { clear: ['replyDueAt'] });
    }
  }

  private async failJob(tx: Transaction, number: number, reason: string): Promise<void> {
    const { job } = this.requireJob(number);
    if (isFinishedJobState(job.state)) return;
    await this.transition(tx, number, 'failed', reason);
    await this.patchRecord(job.taskId, { reason });
    this.closeLetters(tx, number);
    const text = `Job #${number} has failed: ${reason}.`;
    this.systemNote(tx, job, job.from, text);
    this.systemNote(tx, job, job.to, `${text} Stop working on it.`);
  }

  /** A finished job waits for nothing: its letters stop being due, and the job's own letter is done with. */
  private closeLetters(tx: Transaction, number: number, except?: string): void {
    for (const letter of this.store.listLetters({ job: number })) {
      if (letter.id === except) continue;
      if (letter.kind === 'task' && letter.state !== 'handled') {
        this.markHandled(tx, letter);
      } else if (letter.replyDueAt) {
        this.store.updateLetter(letter.id, { clear: ['replyDueAt'] });
      }
    }
  }

  private accept(
    tx: Transaction,
    fields: Pick<Letter, 'id' | 'job' | 'kind' | 'from' | 'to' | 'body'> &
      Partial<Pick<Letter, 'inReplyTo' | 'outcome' | 'replyDueAt'>>
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
      },
    });
    tx.wake.add(letter.to);
    return letter;
  }

  /** A letter the bridge writes itself. It costs the job nothing and is never held back as a repeat. */
  private systemNote(tx: Transaction, job: BridgeJob, to: string, body: string): Letter {
    return this.accept(tx, {
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
    const open = this.store.listLetters({
      job: job.number,
      to: caller,
      kinds: NEEDS_ANSWER,
      states: ['queued', 'delivered', 'read'],
    });
    if (open.length === 1) return open[0];
    if (open.length === 0) {
      throw new BridgeError(
        'invalid_letter',
        `Nothing on job ${job.number} waits for your answer. Send a note instead`,
        {
          job: job.number,
        }
      );
    }
    throw new BridgeError(
      'invalid_letter',
      `Several letters on job ${job.number} wait for your answer: ${open.map((letter) => letter.id).join(', ')}. Say which one with inReplyTo`,
      { job: job.number, letters: open.map((letter) => letter.id) }
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
    return updated;
  }

  private markDelivered(tx: Transaction, letterId: string): void {
    const letter = this.store.getLetter(letterId);
    if (letter?.state !== 'queued') return;
    this.store.updateLetter(letterId, {
      state: 'delivered',
      deliveredAt: this.iso(),
      clear: ['nextAttemptAt', 'lastError'],
    });
    this.journal(tx, {
      type: 'letter.delivered',
      job: letter.job,
      letter: letter.id,
      agent: letter.to,
    });
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
        const adapter = this.adapters.get(agent.harness);
        if (!adapter?.capabilities.push) return undefined;
        const letter = this.store
          .listLetters({ to: name, states: ['queued'], limit: DELIVERY_WINDOW })
          .find((queued) => queued.attempts < this.limits.deliveryAttempts);
        if (!letter) return undefined;
        if (letter.nextAttemptAt && Date.parse(letter.nextAttemptAt) > this.now()) return undefined;
        const { job } = this.requireJob(letter.job);
        return { agent, adapter, job, letter: renderLetter(letter, job) };
      });
      if (!next) return;

      try {
        await within(
          next.adapter.deliver({ agent: next.agent, letter: next.letter, job: next.job }),
          this.limits.deliveryTimeoutMs,
          `Delivering the letter ${next.letter.id} to ${name}`
        );
      } catch (error) {
        await this.mutate(async (tx) => this.deliveryFailed(tx, next.letter.id, asError(error)));
        return;
      }
      await this.mutate(async (tx) => this.markDelivered(tx, next.letter.id));
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
      created = await within(
        adapter.createSession({
          agentName,
          harness: request.agent.harness,
          project: request.agent.project,
          cwd: request.agent.cwd,
          ...(request.agent.sessionName && { sessionName: request.agent.sessionName }),
          job: request.job,
          firstLetter: request.letter,
        }),
        this.limits.sessionStartTimeoutMs,
        `Starting a ${request.agent.harness} session`
      );
      if (!created.sessionId.trim()) throw new Error('the adapter returned no session id');
    } catch (error) {
      const message = asError(error).message;
      await this.mutate(async (tx) => {
        const agent = this.store.getAgent(agentName);
        if (agent?.status === 'starting') {
          this.store.putAgent({ ...agent, status: 'gone' });
          this.journal(tx, { type: 'agent.gone', agent: agentName, data: { error: message } });
        }
        await this.failJob(
          tx,
          jobNumber,
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
      if (created.deliveredFirstLetter) this.markDelivered(tx, letterId);
      if (name !== agentName) {
        this.starting.delete(agentName);
        tx.wake.add(name);
      }
    });
  }
}
