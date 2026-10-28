import { randomUUID } from 'node:crypto';
import type { Agent, Cogitator } from '@cogitator-ai/core';
import {
  createMemorySearchTools,
  fromAgentWireResponseFormat,
  memoryAgentId,
} from '@cogitator-ai/core';
import { AgentStreamSession, createThreadId, type StreamEvent } from '@cogitator-ai/server-shared';
import type {
  DelegatedRunStart,
  ImageInput,
  MemoryAdapter,
  MemoryChange,
  MessageContent,
  PermissionMode,
  ResponseFormat,
  RunHandle,
  RunResult,
  Span,
  Thread,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from '@cogitator-ai/types';
import { MemorySearchResultSchema } from '../protocol/extensions.js';
import { ReviewOutputSchema } from '../protocol/review.js';
import { APP_SERVER_PROTOCOL_VERSION } from '../protocol/common.js';
import type {
  AgentInfo,
  AppServerNotification,
  Delivery,
  InitializeResult,
  MemorySearchParams,
  MemorySearchResult,
  QueuedMessage,
  ReviewStartParams,
  Runnable,
  ThreadForkParams,
  ThreadInfo,
  ThreadListParams,
  ThreadListResult,
  ThreadResumeResult,
  ThreadRewindParams,
  ThreadRewindResult,
  ThreadStartParams,
  ThreadStatus,
  TurnInfo,
  TurnResume,
  TurnStartParams,
  TurnSteerParams,
  UserInput,
} from '../protocol/types.js';
import {
  THREAD_KEYS,
  jsonCopy,
  pendingOfInterrupts,
  pendingOfResult,
  toMessageContent,
  toQueuedMessages,
  toRunInput,
  toThreadInfo,
  toThreadLogEntry,
  toThreadMessage,
  toTurnUsage,
} from './convert.js';
import {
  describeTurnError,
  invalidParams,
  notFound,
  runtimeError,
  threadArchived,
  threadBusy,
  threadPaused,
  turnNotActive,
} from './errors.js';
import {
  REVIEW_INSTRUCTIONS,
  gitReviewContext,
  reviewPrompt,
  type ReviewContextReader,
} from './review.js';

/** What a workflow or swarm run gets besides its input */
export interface AppServerRunContext {
  runId: string;
  /** Aborts when the host closes */
  signal: AbortSignal;
  /** Sends an event of the run to the clients */
  emit(event: unknown): void;
}

/** Workflows or swarms a host runs for `_cogitator/workflow/*` and `_cogitator/swarm/*` */
export interface AppServerRunner {
  list(): readonly Runnable[] | Promise<readonly Runnable[]>;
  run(name: string, input: unknown, context: AppServerRunContext): Promise<unknown>;
}

export interface SessionHostReviewOptions {
  /** The agent reviews run with, the agent of the thread by default */
  agent?: Agent;
  /** The repository whose changes a review reads, the working directory by default */
  cwd?: string;
  /** Reads what a target names, `git` in `cwd` by default */
  context?: ReviewContextReader;
}

export interface SessionHostOptions {
  /** The runtime the turns run in. It needs memory (`memory.adapter`) to keep threads */
  cogitator: Cogitator;
  /** The agents clients can start threads with, by the names they see */
  agents: Readonly<Record<string, Agent>> | ReadonlyMap<string, Agent>;
  /** The agent of a thread started without one, the first of `agents` by default */
  defaultAgent?: string;
  /** What `initialize` answers as `serverInfo` */
  serverInfo?: { name: string; version: string };
  review?: SessionHostReviewOptions;
  workflows?: AppServerRunner;
  swarms?: AppServerRunner;
  /**
   * Show clients the message of an error that is not the runtime's own, such as a failed
   * connection to a model (default false: `Internal error`). Turn it on for a local host
   */
  exposeErrors?: boolean;
}

/** A tool call a turn waits on while the client that started it is asked */
export interface ApprovalAsk {
  threadId: string;
  turnId: string;
  request: ToolApprovalRequest;
}

/** Decides a tool call while the turn waits, `'pause'` to end the turn paused */
export type ApprovalAsker = (ask: ApprovalAsk) => Promise<ToolApprovalDecision | 'pause'>;

export interface TurnStartOptions {
  /** Asks the client about tool calls that need approval; without it such a turn pauses */
  onApproval?: ApprovalAsker;
  /**
   * The turn starts running once this settles, so the answer to the request that started it
   * reaches the client before `turn/started`
   */
  after?: Promise<unknown>;
  /** Who started the turn, so {@link SessionHost.interruptOwned} stops only its turns */
  owner?: object;
}

export type SessionHostListener = (notification: AppServerNotification) => void;

interface QueuedInput {
  delivery: Delivery;
  input: UserInput[];
}

/** The spans the host keeps of one turn at most, the oldest dropped past it */
export const MAX_TRACE_SPANS_PER_TURN = 2000;
/** The turns the host keeps the spans of, the oldest forgotten past it */
export const MAX_TRACED_TURNS = 200;

interface TurnTrace {
  threadId: string;
  spans: Span[];
}

interface TurnRecord {
  info: TurnInfo;
  handle?: RunHandle;
  interrupted: boolean;
  queued: QueuedInput[];
  undelivered: QueuedMessage[];
  done: Promise<void>;
  owner?: object;
}

interface TurnPlan {
  agent: Agent;
  mode?: PermissionMode;
  input?: { input: string; images?: ImageInput[] };
  resume?: TurnResume;
  review?: boolean;
}

/**
 * The threads and turns of an app-server over a {@link Cogitator}: threads live in the runtime's
 * memory, a turn is a run started with `cogitator.start()` (or `startResume()` for a paused
 * thread) whose handle steers and interrupts it, and every event of a turn, those of the runs it
 * delegates to included, reaches the listeners as notifications. One turn goes on per thread at
 * a time.
 *
 * Errors the methods throw are `JsonRpcCallError`s with the app-server's codes, or errors of the
 * runtime, as the server answers them.
 */
export class SessionHost {
  private readonly cogitator: Cogitator;
  private readonly agentMap: ReadonlyMap<string, Agent>;
  private readonly defaultAgentName: string;
  private readonly listeners = new Set<SessionHostListener>();
  private readonly active = new Map<string, TurnRecord>();
  private readonly traces = new Map<string, TurnTrace>();
  private readonly running = new Set<Promise<void>>();
  private readonly closing = new AbortController();
  private readonly reviewContext: ReviewContextReader;
  private memory: MemoryAdapter | undefined;
  private memoryReady: Promise<void> | undefined;
  private stopLog: (() => void) | undefined;

  constructor(private readonly options: SessionHostOptions) {
    this.cogitator = options.cogitator;
    this.agentMap =
      options.agents instanceof Map
        ? new Map(options.agents)
        : new Map(Object.entries(options.agents as Readonly<Record<string, Agent>>));
    const first = this.agentMap.keys().next();
    const defaultAgent = options.defaultAgent ?? (first.done ? undefined : first.value);
    if (defaultAgent === undefined || !this.agentMap.has(defaultAgent)) {
      throw new Error(
        defaultAgent === undefined
          ? 'SessionHost needs at least one agent'
          : `The default agent ${defaultAgent} is not one of the agents`
      );
    }
    this.defaultAgentName = defaultAgent;
    this.reviewContext =
      options.review?.context ?? gitReviewContext(options.review?.cwd ?? process.cwd());
  }

  /** Whether errors other than the runtime's show their message, see `exposeErrors` */
  get exposesErrors(): boolean {
    return this.options.exposeErrors ?? false;
  }

  /** Hears every notification of the host, until the returned function is called */
  subscribe(listener: SessionHostListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Connects the memory and starts reporting its changes as `thread/log`. Safe to call again */
  ready(): Promise<void> {
    this.memoryReady ??= (async () => {
      this.memory = await this.cogitator.getMemory();
      const memory = this.memory;
      if (memory?.onChange) this.stopLog = memory.onChange((change) => this.logChange(change));
    })();
    return this.memoryReady;
  }

  /** The agents clients see */
  agents(): AgentInfo[] {
    return [...this.agentMap].map(([name, agent]) => ({
      name,
      ...(agent.config.description !== undefined && { description: agent.config.description }),
      ...(agent.config.model && { model: agent.config.model }),
      default: name === this.defaultAgentName,
    }));
  }

  /** What `initialize` answers, but the protocol version */
  async describe(): Promise<Omit<InitializeResult, 'protocolVersion'>> {
    await this.ready();
    const memory = this.memory;
    return {
      serverInfo: this.options.serverInfo ?? { name: 'cogitator-app-server', version: '0.1.0' },
      capabilities: {
        approvals: ['request', 'pause'],
        review: true,
        memorySearch: memory !== undefined,
        rewind: typeof memory?.rewind === 'function' && typeof memory.getPath === 'function',
        workflows: this.options.workflows !== undefined,
        swarms: this.options.swarms !== undefined,
        threadLog: typeof memory?.onChange === 'function',
        traces: true,
      },
      agents: this.agents(),
    };
  }

  /** The protocol version the host speaks */
  get protocolVersion(): number {
    return APP_SERVER_PROTOCOL_VERSION;
  }

  /** The runner of `kind`, when the host was given one */
  runner(kind: 'workflow' | 'swarm'): AppServerRunner | undefined {
    return kind === 'workflow' ? this.options.workflows : this.options.swarms;
  }

  async startThread(params: ThreadStartParams): Promise<ThreadInfo> {
    const name = params.agent ?? this.defaultAgentName;
    const agent = this.agentNamed(name);
    const memory = await this.requireMemory();
    if (params.threadId !== undefined && (await this.findThread(params.threadId))) {
      throw invalidParams(`Thread ${params.threadId} exists already: resume it instead`);
    }
    const thread = unwrap(
      await memory.createThread(
        memoryAgentId(agent),
        {
          ...params.metadata,
          agentId: memoryAgentId(agent),
          [THREAD_KEYS.agent]: name,
          ...(params.permissionMode !== undefined && {
            [THREAD_KEYS.permissionMode]: params.permissionMode,
          }),
        },
        params.threadId ?? createThreadId()
      )
    );
    const info = await this.threadInfo(thread);
    this.emit({ method: 'thread/started', params: { thread: info } });
    return info;
  }

  async resumeThread(threadId: string): Promise<ThreadResumeResult> {
    const thread = await this.requireThread(threadId);
    const memory = await this.requireMemory();
    const entries = unwrap(
      memory.getPath
        ? await memory.getPath({ threadId, types: ['message', 'tool_result'] })
        : await memory.getEntries({ threadId, types: ['message', 'tool_result'] })
    );
    const paused = this.active.has(threadId) ? undefined : await this.cogitator.pausedRun(threadId);
    return {
      thread: await this.threadInfo(thread),
      messages: entries.map(toThreadMessage),
      ...(paused && { pending: pendingOfInterrupts(paused.interrupts) }),
    };
  }

  async forkThread(params: ThreadForkParams): Promise<ThreadInfo> {
    const source = await this.requireThread(params.threadId);
    const atEntryId = params.atEntryId ?? source.activeLeafId;
    if (atEntryId === undefined) {
      throw invalidParams(`Thread ${params.threadId} has no entries to fork`);
    }
    const memory = await this.requireMemory();
    if (!(await entryIn(memory, params.threadId, atEntryId))) throw notFound('entry', atEntryId);
    const forked = await this.cogitator.forkThread(params.threadId, atEntryId, {
      ...(params.newThreadId !== undefined && { newThreadId: params.newThreadId }),
    });
    const thread = unwrap(
      await memory.updateThread(forked.thread.id, {
        [THREAD_KEYS.agent]: this.agentNameOf(source),
        [THREAD_KEYS.forkedFrom]: params.threadId,
        [THREAD_KEYS.archived]: false,
        ...(source.metadata[THREAD_KEYS.permissionMode] !== undefined && {
          [THREAD_KEYS.permissionMode]: source.metadata[THREAD_KEYS.permissionMode],
        }),
      })
    );
    const info = await this.threadInfo(thread);
    this.emit({ method: 'thread/started', params: { thread: info } });
    return info;
  }

  async listThreads(params: ThreadListParams): Promise<ThreadListResult> {
    await this.requireMemory();
    const page = await this.cogitator.listThreads({
      ...(params.archived !== undefined && { archived: params.archived }),
      ...(params.agent !== undefined && { metadata: { [THREAD_KEYS.agent]: params.agent } }),
      ...(params.cursor !== undefined && { cursor: params.cursor }),
      ...(params.limit !== undefined && { limit: params.limit }),
    });
    const threads = await Promise.all(page.threads.map((thread) => this.threadInfo(thread)));
    return { threads, ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }) };
  }

  async archiveThread(threadId: string, archived: boolean): Promise<ThreadInfo> {
    await this.requireThread(threadId);
    const going = this.active.get(threadId);
    if (going) throw threadBusy(threadId, going.info.id);
    const thread = archived
      ? await this.cogitator.archiveThread(threadId)
      : await this.cogitator.unarchiveThread(threadId);
    this.emit({
      method: archived ? 'thread/archived' : 'thread/unarchived',
      params: { threadId },
    });
    return this.threadInfo(thread);
  }

  /**
   * Sets the permission mode of a thread: new turns start in it, and the turn going on switches
   * to it from its next tool call
   */
  async setPermissionMode(threadId: string, mode: PermissionMode): Promise<ThreadInfo> {
    await this.requireThread(threadId);
    const memory = await this.requireMemory();
    this.active.get(threadId)?.handle?.setPermissionMode?.(mode);
    const thread = unwrap(
      await memory.updateThread(threadId, { [THREAD_KEYS.permissionMode]: mode })
    );
    return this.threadInfo(thread);
  }

  /**
   * Starts a turn in a thread, or resumes its paused one, and returns it in progress: it runs
   * once `options.after` settles, sending `turn/started`, its events and `turn/completed`
   */
  async startTurn(params: TurnStartParams, options: TurnStartOptions = {}): Promise<TurnInfo> {
    const turn = this.reserve(params.threadId, options.owner);
    let plan: TurnPlan;
    try {
      const thread = await this.requireThread(params.threadId);
      if (thread.metadata[THREAD_KEYS.archived] === true) throw threadArchived(params.threadId);
      if (params.resume && params.input) {
        throw invalidParams(
          'Pass input to start a turn or resume to go on with a paused one, not both'
        );
      }
      const paused = await this.cogitator.pausedRun(params.threadId);
      if (paused && !params.resume) throw threadPaused(params.threadId);
      if (!paused && params.resume) {
        throw invalidParams(`Thread ${params.threadId} has no paused turn to resume`);
      }
      if (!params.resume && !params.input) {
        throw invalidParams('Pass input to start a turn, or resume to go on with a paused one');
      }
      const mode = params.permissionMode ?? modeOf(thread);
      plan = {
        agent: this.turnAgent(this.agentOf(thread), params.model, params.outputSchema),
        ...(mode !== undefined && { mode }),
        ...(params.input && { input: toRunInput(params.input) }),
        ...(params.resume && { resume: params.resume }),
      };
    } catch (error) {
      this.active.delete(params.threadId);
      throw error;
    }
    this.launch(turn, plan, options);
    return copyTurn(turn.info);
  }

  /**
   * Reviews changes in a review thread of their own, made for the review: returns the review
   * turn in progress, whose `turn/completed` carries the findings as `review`
   */
  async startReview(
    params: ReviewStartParams,
    options: TurnStartOptions = {}
  ): Promise<{ turn: TurnInfo; reviewThreadId: string }> {
    const source = await this.requireThread(params.threadId);
    const memory = await this.requireMemory();
    const base = this.options.review?.agent ?? this.agentOf(source);
    let changes: string;
    try {
      changes = await this.reviewContext(params.target);
    } catch (error) {
      throw runtimeError(
        'REVIEW_CONTEXT_FAILED',
        error instanceof Error ? error.message : 'Reading the changes to review failed'
      );
    }
    const agent = base.clone({
      instructions: REVIEW_INSTRUCTIONS,
      responseFormat: { type: 'json_schema', schema: ReviewOutputSchema },
      ...(params.model !== undefined && { model: params.model }),
    });
    const reviewThreadId = `review_${randomUUID()}`;
    const thread = unwrap(
      await memory.createThread(
        memoryAgentId(agent),
        {
          agentId: memoryAgentId(agent),
          [THREAD_KEYS.agent]: this.agentNameOf(source),
          [THREAD_KEYS.reviewOf]: params.threadId,
        },
        reviewThreadId
      )
    );
    this.emit({ method: 'thread/started', params: { thread: await this.threadInfo(thread) } });
    const turn = this.reserve(reviewThreadId, options.owner);
    this.launch(
      turn,
      { agent, input: { input: reviewPrompt(params.target, changes) }, review: true },
      options
    );
    return { turn: copyTurn(turn.info), reviewThreadId };
  }

  /** Sends a message to the turn going on, `steer` by default */
  steerTurn(params: TurnSteerParams): { turnId: string } {
    const turn = this.activeTurn(params.threadId, params.expectedTurnId);
    const queued: QueuedInput = { delivery: params.delivery ?? 'steer', input: params.input };
    if (!turn.handle) {
      turn.queued.push(queued);
      return { turnId: turn.info.id };
    }
    if (!deliver(turn.handle, queued)) {
      throw turnNotActive(params.threadId, params.expectedTurnId, undefined);
    }
    return { turnId: turn.info.id };
  }

  /** Stops the turn going on and returns the messages it had not taken */
  interruptTurn(threadId: string, turnId: string): { undelivered: QueuedMessage[] } {
    const turn = this.activeTurn(threadId, turnId);
    return { undelivered: this.interrupt(turn) };
  }

  /** Stops the turns `owner` started, such as a client that went away, and waits for them */
  async interruptOwned(owner: object): Promise<void> {
    const owned = [...this.active.values()].filter((turn) => turn.owner === owner);
    for (const turn of owned) this.interrupt(turn);
    await Promise.all(owned.map((turn) => turn.done));
  }

  /** Waits for the turn going on in `threadId`, if one does */
  async waitForTurn(threadId: string): Promise<void> {
    await this.active.get(threadId)?.done;
  }

  async searchMemory(params: MemorySearchParams): Promise<MemorySearchResult> {
    const memory = await this.requireMemory();
    const agent = this.agentNamed(params.agent ?? this.defaultAgentName);
    if (params.threadId !== undefined) await this.requireThread(params.threadId);
    const agentId = memoryAgentId(agent);
    const threadId = params.threadId;
    const [search] = createMemorySearchTools({
      memory,
      agentId,
      placeOf: () => (threadId !== undefined ? { threadId } : undefined),
    });
    const invoked = await this.cogitator.invokeTool(
      search,
      { query: params.query, ...(params.limit !== undefined && { limit: params.limit }) },
      { agentId, ...(params.threadId !== undefined && { threadId: params.threadId }) }
    );
    if (invoked.error !== undefined) throw runtimeError('MEMORY_SEARCH_FAILED', invoked.error);
    const parsed = MemorySearchResultSchema.safeParse(invoked.result);
    if (!parsed.success) throw runtimeError('MEMORY_SEARCH_FAILED', 'Memory search answered oddly');
    return parsed.data;
  }

  async rewindThread(params: ThreadRewindParams): Promise<ThreadRewindResult> {
    const thread = await this.requireThread(params.threadId);
    const going = this.active.get(params.threadId);
    if (going && !params.force && !params.dryRun) throw threadBusy(params.threadId, going.info.id);
    const memory = await this.requireMemory();
    if (!(await entryIn(memory, params.threadId, params.toEntryId))) {
      throw notFound('entry', params.toEntryId);
    }
    const report = await this.cogitator.rewind(params.threadId, params.toEntryId, {
      agents: [this.agentOf(thread)],
      ...(params.files !== undefined && { files: params.files }),
      ...(params.dryRun !== undefined && { dryRun: params.dryRun }),
      ...(params.force !== undefined && { force: params.force }),
    });
    const plain = jsonCopy(report);
    return {
      threadId: report.threadId,
      toEntryId: report.toEntryId,
      dryRun: report.dryRun,
      conversation: plain.conversation,
      runs: plain.runs,
      ...(report.files && { files: jsonCopy(report.files) }),
      report: plain,
    };
  }

  /** Runs a workflow or a swarm by name, its events sent as `_cogitator/<kind>/event` */
  async run(
    kind: 'workflow' | 'swarm',
    name: string,
    input: unknown
  ): Promise<{ runId: string; result?: unknown }> {
    const runner = this.runner(kind);
    if (!runner) throw notFound(kind, name);
    const listed = await runner.list();
    if (!listed.some((item) => item.name === name)) throw notFound(kind, name);
    const runId = `${kind}_${randomUUID()}`;
    const method = kind === 'workflow' ? '_cogitator/workflow/event' : '_cogitator/swarm/event';
    const result = await runner.run(name, input, {
      runId,
      signal: this.closing.signal,
      emit: (event) => this.emit({ method, params: { runId, name, event } }),
    });
    return { runId, ...(result !== undefined && { result }) };
  }

  /**
   * The spans the host keeps of a turn, oldest first: the last {@link MAX_TRACE_SPANS_PER_TURN}
   * of each of the last {@link MAX_TRACED_TURNS} turns
   */
  getTrace(turnId: string): { threadId: string; turnId: string; spans: Span[] } {
    const trace = this.traces.get(turnId);
    if (!trace) throw notFound('turn', turnId);
    return { threadId: trace.threadId, turnId, spans: trace.spans.map((span) => ({ ...span })) };
  }

  /** Stops every turn and waits for them, then stops reporting memory changes */
  async close(): Promise<void> {
    if (!this.closing.signal.aborted) this.closing.abort(new Error('The app-server host closed'));
    for (const turn of this.active.values()) this.interrupt(turn);
    await Promise.all([...this.running]);
    this.stopLog?.();
    this.stopLog = undefined;
    this.listeners.clear();
    this.traces.clear();
  }

  /** A new trace for a turn, forgetting the oldest turn past {@link MAX_TRACED_TURNS} */
  private openTrace(threadId: string, turnId: string): TurnTrace {
    const trace: TurnTrace = { threadId, spans: [] };
    this.traces.set(turnId, trace);
    while (this.traces.size > MAX_TRACED_TURNS) {
      const oldest = this.traces.keys().next();
      if (oldest.done) break;
      this.traces.delete(oldest.value);
    }
    return trace;
  }

  private recordSpan(trace: TurnTrace, turnId: string, span: Span): void {
    const copy = jsonCopy(span);
    if (this.traces.get(turnId) === trace) {
      trace.spans.push(copy);
      if (trace.spans.length > MAX_TRACE_SPANS_PER_TURN) trace.spans.shift();
    }
    this.emit({
      method: '_cogitator/trace/span',
      params: { threadId: trace.threadId, turnId, span: copy },
    });
  }

  private emit(notification: AppServerNotification): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(notification);
      } catch {
        continue;
      }
    }
  }

  private logChange(change: MemoryChange): void {
    const threadId =
      change.type === 'entry-added' ? change.entry.threadId : (change.threadId ?? undefined);
    if (threadId === undefined) return;
    this.emit({
      method: 'thread/log',
      params: {
        threadId,
        change: change.type,
        ...(change.type === 'entry-added' && {
          entryId: change.entry.id,
          entry: toThreadLogEntry(change.entry),
        }),
        ...((change.type === 'entry-deleted' || change.type === 'entry-redacted') && {
          entryId: change.entryId,
        }),
      },
    });
  }

  /** Holds the thread for a new turn, refusing while one goes on */
  private reserve(threadId: string, owner: object | undefined): TurnRecord {
    const going = this.active.get(threadId);
    if (going) throw threadBusy(threadId, going.info.id);
    const turn: TurnRecord = {
      info: {
        id: `turn_${randomUUID()}`,
        threadId,
        status: 'inProgress',
        startedAt: new Date().toISOString(),
      },
      interrupted: false,
      queued: [],
      undelivered: [],
      done: Promise.resolve(),
      ...(owner && { owner }),
    };
    this.active.set(threadId, turn);
    return turn;
  }

  private launch(turn: TurnRecord, plan: TurnPlan, options: TurnStartOptions): void {
    const done = this.runTurn(turn, plan, options).finally(() => {
      this.running.delete(done);
    });
    turn.done = done;
    this.running.add(done);
  }

  private async runTurn(turn: TurnRecord, plan: TurnPlan, options: TurnStartOptions) {
    await Promise.resolve(options.after).catch(() => undefined);
    const threadId = turn.info.threadId;
    const turnId = turn.info.id;
    const trace = this.openTrace(threadId, turnId);
    this.emit({ method: 'turn/started', params: { threadId, turn: copyTurn(turn.info) } });
    if (turn.interrupted) {
      this.finish(turn, { status: 'interrupted' });
      return;
    }
    const emit = (event: StreamEvent, delegated?: DelegatedRunStart) =>
      this.emit({
        method: 'turn/event',
        params: {
          threadId,
          turnId,
          event,
          ...(delegated && {
            parentToolCallId: delegated.parentToolCallId,
            agent: delegated.agent,
          }),
        },
      });
    const session = new AgentStreamSession((event) => emit(event), {
      threadId,
      delegated: (start) => (event) => emit(event, start),
    });
    session.start();
    const asker = options.onApproval;
    const runOptions = {
      stream: true,
      ...session.callbacks,
      onSpan: (span: Span) => this.recordSpan(trace, turnId, span),
      ...(plan.mode !== undefined && { permissions: { mode: plan.mode } }),
      ...(asker && {
        onApproval: (request: ToolApprovalRequest) => asker({ threadId, turnId, request }),
      }),
    };
    let handle: RunHandle;
    try {
      handle = plan.resume
        ? this.cogitator.startResume(plan.agent, threadId, {
            ...runOptions,
            ...(plan.resume.decisions && { decisions: plan.resume.decisions }),
            ...(plan.resume.responses && { responses: plan.resume.responses }),
            ...(plan.resume.defaultDecision && { defaultDecision: plan.resume.defaultDecision }),
          })
        : this.cogitator.start(plan.agent, {
            ...runOptions,
            threadId,
            input: plan.input?.input ?? '',
            ...(plan.input?.images && { images: plan.input.images }),
          });
    } catch (error) {
      const described = describeTurnError(error, this.exposesErrors);
      session.fail(described.message, described.code);
      this.finish(turn, { status: 'failed', error: described });
      return;
    }
    turn.handle = handle;
    for (const queued of turn.queued.splice(0)) {
      if (!deliver(handle, queued)) turn.undelivered.push({ ...queued });
    }
    try {
      const result = await handle.result;
      session.complete(result);
      this.finish(turn, fromResult(result, plan.review ?? false));
    } catch (error) {
      if (turn.interrupted) {
        session.fail('The turn was interrupted', 'INTERRUPTED');
        this.finish(turn, { status: 'interrupted' });
        return;
      }
      const described = describeTurnError(error, this.exposesErrors);
      session.fail(described.message, described.code);
      this.finish(turn, { status: 'failed', error: described });
    }
  }

  private finish(turn: TurnRecord, outcome: Partial<TurnInfo> & Pick<TurnInfo, 'status'>): void {
    const undelivered = [...turn.undelivered, ...(outcome.undelivered ?? [])];
    turn.info = {
      ...turn.info,
      ...outcome,
      ...(undelivered.length > 0 && { undelivered }),
      completedAt: new Date().toISOString(),
    };
    if (this.active.get(turn.info.threadId) === turn) this.active.delete(turn.info.threadId);
    this.emit({
      method: 'turn/completed',
      params: { threadId: turn.info.threadId, turn: copyTurn(turn.info) },
    });
  }

  private interrupt(turn: TurnRecord): QueuedMessage[] {
    turn.interrupted = true;
    const queued = turn.queued.splice(0).map((message) => ({ ...message }));
    const left = turn.handle ? toQueuedMessages(turn.handle.abort()) : [];
    const undelivered = [...queued, ...left];
    turn.undelivered.push(...undelivered);
    return undelivered;
  }

  private activeTurn(threadId: string, turnId: string): TurnRecord {
    const turn = this.active.get(threadId);
    if (turn?.info.id !== turnId || turn.interrupted) {
      throw turnNotActive(threadId, turnId, turn?.info.id);
    }
    return turn;
  }

  private turnAgent(
    agent: Agent,
    model: string | undefined,
    outputSchema: Record<string, unknown> | undefined
  ): Agent {
    let responseFormat: ResponseFormat | undefined;
    if (outputSchema !== undefined) {
      try {
        responseFormat = fromAgentWireResponseFormat({ type: 'json_schema', schema: outputSchema });
      } catch (error) {
        throw invalidParams(
          `outputSchema is not a JSON Schema the runtime reads: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (model === undefined && responseFormat === undefined) return agent;
    return agent.clone({
      ...(model !== undefined && { model }),
      ...(responseFormat !== undefined && { responseFormat }),
    });
  }

  private agentNamed(name: string): Agent {
    const agent = this.agentMap.get(name);
    if (!agent) throw notFound('agent', name);
    return agent;
  }

  private agentNameOf(thread: Thread): string {
    const name = thread.metadata[THREAD_KEYS.agent];
    return typeof name === 'string' ? name : this.defaultAgentName;
  }

  private agentOf(thread: Thread): Agent {
    return this.agentNamed(this.agentNameOf(thread));
  }

  private async requireMemory(): Promise<MemoryAdapter> {
    await this.ready();
    const memory = this.memory ?? (await this.cogitator.getMemory());
    if (!memory) {
      throw runtimeError(
        'MEMORY_REQUIRED',
        'The app-server keeps threads in memory: set memory.adapter in the Cogitator config'
      );
    }
    this.memory = memory;
    return memory;
  }

  private async findThread(threadId: string): Promise<Thread | null> {
    const memory = await this.requireMemory();
    return unwrap(await memory.getThread(threadId));
  }

  private async requireThread(threadId: string): Promise<Thread> {
    const thread = await this.findThread(threadId);
    if (!thread) throw notFound('thread', threadId);
    return thread;
  }

  private async statusOf(
    threadId: string
  ): Promise<{ status: ThreadStatus; activeTurnId?: string }> {
    const turn = this.active.get(threadId);
    if (turn) return { status: 'running', activeTurnId: turn.info.id };
    const paused = await this.cogitator.pausedRun(threadId);
    return { status: paused ? 'paused' : 'idle' };
  }

  private async threadInfo(thread: Thread): Promise<ThreadInfo> {
    return toThreadInfo(thread, await this.statusOf(thread.id));
  }
}

function modeOf(thread: Thread): PermissionMode | undefined {
  const mode = thread.metadata[THREAD_KEYS.permissionMode];
  return typeof mode === 'string' ? (mode as PermissionMode) : undefined;
}

function deliver(handle: RunHandle, queued: QueuedInput): boolean {
  const content: MessageContent = toMessageContent(queued.input);
  switch (queued.delivery) {
    case 'steer':
      return handle.steer(content);
    case 'followUp':
      return handle.followUp(content);
    case 'inject':
      return handle.inject(content);
  }
}

function fromResult(
  result: RunResult,
  review: boolean
): Partial<TurnInfo> & Pick<TurnInfo, 'status'> {
  const paused = result.status === 'paused';
  const parsedReview = review ? ReviewOutputSchema.safeParse(result.structured) : undefined;
  return {
    status: paused ? 'paused' : 'completed',
    output: result.output,
    ...(result.structured !== undefined && { structured: result.structured }),
    ...(result.structuredError !== undefined && { structuredError: result.structuredError }),
    usage: toTurnUsage(result.usage),
    ...(paused && { pending: pendingOfResult(result) }),
    ...(result.undelivered &&
      result.undelivered.length > 0 && { undelivered: toQueuedMessages(result.undelivered) }),
    ...(parsedReview?.success && { review: parsedReview.data }),
  };
}

async function entryIn(memory: MemoryAdapter, threadId: string, entryId: string): Promise<boolean> {
  const entry = unwrap(await memory.getEntry(entryId));
  return entry !== null && entry.threadId === threadId;
}

function copyTurn(turn: TurnInfo): TurnInfo {
  return structuredClone(turn);
}

function unwrap<T>(result: { success: true; data: T } | { success: false; error: string }): T {
  if (!result.success) throw runtimeError('MEMORY_ERROR', result.error);
  return result.data;
}
