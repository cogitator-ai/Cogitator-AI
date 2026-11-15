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
  DEFAULT_INBOX_LIMIT,
  DEFAULT_LIST_LIMIT,
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
import { findCheckoutRoot, findProjectRoot, isInside } from './paths.js';
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
  HarnessNameSchema,
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

/** As many of `items`, in order, as fit `MAX_ANSWER_CHARS` by `sizeOf`, the first one always. */
function fitting<T>(items: readonly T[], sizeOf: (item: T) => number): T[] {
  const taken: T[] = [];
  let size = 0;
  for (const item of items) {
    size += sizeOf(item);
    if (taken.length > 0 && size > MAX_ANSWER_CHARS) break;
    taken.push(item);
  }
  return taken;
}

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
      const harness = parse(HarnessNameSchema, adapter.harness, 'Cannot use the adapter');
      if (this.adapters.has(harness)) {
        throw new BridgeError('invalid_input', `Two adapters for the harness ${harness}`);
      }
      this.adapters.set(harness, adapter);
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
    const outcome = await this.asCaller(caller, async (tx): Promise<CreateJobResult | Refusal> => {
      const from = this.requireCaller(caller);

      if (request.letterId) {
        const sent = this.store.getLetter(request.letterId);
        if (sent) {
          if (sent.kind !== 'task' || sent.from !== from.name || sent.body !== request.body) {
            throw new BridgeError(
              'invalid_letter',
              `The letter id ${request.letterId} belongs to another letter. Give a new job a new id`,
              { letter: request.letterId }
            );
          }
          return { job: this.requireJob(sent.job).job, letter: sent, duplicate: true };
        }
      }

      const resolution = resolveAddress(this.store, request.to, {
        project: from.project,
        caller: from.name,
        now: this.now(),
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
        parent = carriedOut.reduce<BridgeJob | undefined>(
          (deepest, job) => (deepest && deepest.depth >= job.depth ? deepest : job),
          undefined
        );
      }
      let depth: number;
      try {
        depth = nextDepth(parent?.depth, this.limits);
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
      if (!isInside(from.project, cwd) && !isInside(findCheckoutRoot(from.cwd), cwd)) {
        throw new BridgeError(
          'invalid_input',
          `A job is done inside the project it is handed over in (${from.project}) or the checkout you work in, and ${cwd} is outside both`,
          { cwd, project: from.project }
        );
      }

      const now = this.now();
      const refusal = this.handOverRefusal(from, resolution, request.body, cwd, now);
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
      const history = userMessage(forHistory(request.body, firstLetterId));
      const task = await this.tasks.createTask(history, undefined, {
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
        id: firstLetterId,
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
    const outcome = await this.asCaller(caller, async (tx): Promise<SendLetterResult | Refusal> => {
      const from = this.requireCaller(caller);

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

      const answered = this.answeredLetter(request, job, from.name);

      const previous = this.store.listLetters({
        job: job.number,
        from: from.name,
        to,
        newestFirst: true,
        limit: 1,
      })[0];
      if (repeats(previous, request.kind, request.body, answered?.id)) {
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
      const exhausted = exhaustedBudget(job, now, request.kind);
      if (exhausted) {
        const reason =
          exhausted === 'letters'
            ? `the job used all ${job.budget.letters} letters of its budget`
            : ranOutOfTime(job);
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
        await this.transition(tx, job.number, state, forHistory(request.body, letter.id));
        if (state === 'failed')
          await this.patchRecord(job.taskId, { reason: `reported as failed by ${from.name}` });
        this.closeLetters(tx, job.number, letter.id);
        await this.cancelChildren(tx, job);
      } else if (isAssignee && NEEDS_ANSWER.includes(request.kind)) {
        await this.transition(
          tx,
          job.number,
          'input-required',
          forHistory(request.body, letter.id)
        );
      } else if (request.kind === 'answer' && !isAssignee) {
        const open = this.store.countLetters({
          job: job.number,
          from: job.to,
          kinds: NEEDS_ANSWER,
          states: ['queued', 'delivered', 'read'],
        });
        if (open === 0 && this.requireJob(job.number).job.state === 'input-required') {
          await this.transition(tx, job.number, 'working', forHistory(request.body, letter.id));
        }
      }
      return { letter, job: this.requireJob(job.number).job, duplicate: false };
    });
    if (outcome instanceof Refusal) throw outcome.error;
    return outcome;
  }

  /**
   * The letters waiting for the caller, oldest first, each with the text to show. Taking them
   * marks them read, and taking a job's first letter starts the job. One call returns `limit`
   * letters at most (20 by default) and no more text than fits one answer: only the letters
   * returned are marked, the rest wait for the next call. A session that may have missed an
   * answer asks again with `unhandled`, which adds the newest of the letters it took before and
   * has not answered or put away. `afterSeq` looks further than one call returns.
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
      const waiting = [...taken, ...unread].sort((a, b) => a.seq - b.seq);
      const letters = fitting(waiting, (letter) => 2 * letter.body.length);
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

      const overdue = this.store
        .jobTasks({ states: ACTIVE_JOB_STATES, deadlineBy: now })
        .flatMap((task) => jobOf(task) ?? [])
        .sort((a, b) => a.number - b.number);
      for (const late of overdue) {
        if (isFinishedJobState(this.requireJob(late.number).job.state)) continue;
        await this.failJob(tx, late.number, ranOutOfTime(late));
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
          `${letter.to} did not ${pickup ? 'take' : 'answer'} the ${letter.kind} ${letter.id} in ${formatDuration(2 * job.budget.replyTimeoutMs)}`
        );
        failed.push(job.number);
      }

      failed.push(...(await this.retireAgents(tx, now)));
      for (const agent of this.store.queuedRecipients()) tx.wake.add(agent);
      return { failed: [...new Set(failed)], reminded };
    });
    return result;
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
   * Waits for the calls being handled, the deliveries and the session starts they began, then
   * takes no more. A delivery that hangs is given up on after `limits.deliveryTimeoutMs` and a
   * session start after `limits.sessionStartTimeoutMs`, so this always ends.
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
    const tx: Transaction = { entries: [], wake: new Set(), spawns: [] };
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
    for (const spawn of tx.spawns) this.startSession(spawn.agent, spawn.job, spawn.letter);
    for (const agent of tx.wake) this.wake(agent);
    return result;
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
   * handed to the same agent and that is still in progress, it has too many jobs out, it hands
   * jobs over too fast, or too many sessions are being started.
   */
  private handOverRefusal(
    from: AgentRecord,
    resolution: ReturnType<typeof resolveAddress>,
    body: string,
    cwd: string,
    now: number
  ): BridgeError | undefined {
    const open = this.store
      .jobTasks({ from: from.name, states: ACTIVE_JOB_STATES })
      .flatMap((task) => jobOf(task) ?? []);
    const wanted = normalizeBody(body);
    const sameAgent = (job: BridgeJob): boolean =>
      resolution.kind === 'agent'
        ? job.to === resolution.agent.name
        : this.store.getAgent(job.to)?.harness === resolution.harness;
    const same = open.find((job) => {
      if (job.cwd !== cwd || !sameAgent(job)) return false;
      const first = this.store.listLetters({ job: job.number, kinds: ['task'], limit: 1 })[0];
      return first !== undefined && normalizeBody(first.body) === wanted;
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
    if (resolution.kind === 'spawn') {
      const starting = this.store.listAgents({ statuses: ['starting'] }).length;
      if (starting >= this.limits.maxStartingSessions) {
        return new BridgeError(
          'no_session',
          `The bridge is already starting ${starting} sessions, the most at once. Hand the job over again when they are up`,
          { starting, max: this.limits.maxStartingSessions }
        );
      }
    }
    return undefined;
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

  /**
   * Records that an adapter handed a letter to its session. A job handed over this way counts as
   * taken: the harness has it and woke the session, which may work without calling the bridge
   * until it reports. The letter is read only once the session calls about the job.
   */
  private async markDelivered(tx: Transaction, letterId: string): Promise<void> {
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
        const adapter = this.adapters.get(agent.harness);
        if (!adapter?.capabilities.push) return undefined;
        const letter = this.store.listLetters({
          to: name,
          states: ['queued'],
          attemptsBelow: this.limits.deliveryAttempts,
          limit: 1,
        })[0];
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
      await this.mutate((tx) => this.markDelivered(tx, next.letter.id));
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
