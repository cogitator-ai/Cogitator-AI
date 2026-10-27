/**
 * The trigger manager: routines and what starts them. A firing becomes an event, the event
 * starts a session exactly once (a claim in the store, a run id made from the event, a durable
 * run that a second start finds held), and what the session comes to lands in the inbox
 */

import { createHash } from 'node:crypto';
import type {
  ActiveRoutineRun,
  Agent,
  CronEngine,
  InboxItem,
  InboxItemInput,
  ResumeOptions,
  RoutineDefinition,
  RoutineInfo,
  RoutineRunRecord,
  RoutineRunStatus,
  RoutineStore,
  RoutineWorkflow,
  RoutineWorkflowOutcome,
  RunHandle,
  RunNotification,
  RunResult,
  StartOptions,
  TimerEntry,
  TriggerEvent,
  TriggerFireResult,
  TriggerHttpRequest,
  TriggerHttpResponse,
  TriggerInfo,
  TriggerManagerEvent,
  TriggerSpec,
  TriggerState,
  TriggerStatePatch,
  TriggersConfig,
} from '@cogitator-ai/types';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { getLogger } from '../logger';
import type { PluginLease, PluginRoutineEntry } from '../plugins/contributions';
import { createSchedulerTools, type SchedulerToolsConfig } from '../tools/scheduler-tools';
import { experimental_loadCronEngine } from './cron';
import {
  experimental_agentTaskInput,
  experimental_createTriggerEvent,
  experimental_routineInput,
} from './envelope';
import { experimental_Inbox } from './inbox';
import { experimental_InMemoryRoutineStore } from './routine-stores';
import {
  fullTriggerId,
  routineProblem,
  specSummary,
  splitTriggerId,
  storableProblem,
  triggerIdOf,
} from './routines';
import { experimental_Scheduler, type ScheduledFire, type ScheduledHold } from './scheduler';
import { InMemoryTimerStore } from './timer-stores';
import {
  readApiFire,
  readEmail,
  readGitHub,
  readSlack,
  readWebhook,
  type SourceOutcome,
} from './sources';
import { generateTriggerToken, hashTriggerToken } from './verify';

/** Who the hooks of a routine's notification are for */
export interface TriggerNotifyScope {
  /** The agent of an agent routine: its middleware hears the notification too */
  agent?: Agent;
  /** The routine, the name the hooks see for a workflow routine */
  routineId: string;
  routineName: string;
  runId: string;
  threadId?: string;
  userId?: string;
}

/** What the manager needs of the runtime it starts runs in */
export interface TriggerRuntime {
  start(agent: Agent, options: StartOptions): RunHandle;
  /**
   * Takes up run `runId`, paused in thread `threadId`: resolves once its checkpoint is read and
   * it goes on, with its result to wait for. Rejects before anything runs when no run waits
   * there (`RUN_NOT_PAUSED`) or another run of the thread does (`RUN_NOT_FOUND`)
   */
  resume(
    agent: Agent,
    threadId: string,
    runId: string,
    options: ResumeOptions
  ): Promise<{ result: Promise<RunResult> }>;
  /** Runs the `Notification` hooks and middleware of the runtime */
  notify(notification: RunNotification, scope: TriggerNotifyScope): Promise<void>;
  /** Continues the durable runs a stopped process left, for those the filter takes */
  recoverRuns?(
    filter: (runId: string) => boolean,
    agentOf: (agentName: string, agentId: string) => Agent | undefined
  ): Promise<{ runId: string; handle: RunHandle }[]>;
  /** The plugins: their routines, and a lease a routine's run holds */
  plugins?: {
    routines(): readonly PluginRoutineEntry[];
    lease(): PluginLease;
    onChange(listener: () => void): () => void;
  };
  /** Whether the runtime keeps durable runs */
  durable: boolean;
}

/** Where a routine came from */
type Origin = RoutineInfo['origin'];

interface Registered {
  routine: RoutineDefinition;
  origin: Origin;
  plugin?: string;
}

interface LiveRun {
  runId: string;
  eventId: string;
  triggerId: string;
  source: TriggerEvent['source'];
  threadId: string;
  startedAt: number;
  handle?: RunHandle;
  abort?: AbortController;
}

interface PendingFiring {
  event: TriggerEvent;
  runId: string;
  /** The claim of the event's delivery id, given back when the firing never starts */
  dedup?: string;
}

interface RoutineLive {
  runs: Map<string, LiveRun>;
  queue: PendingFiring[];
  /** Queued firings taken off the queue whose run is about to start: they hold a slot */
  starting: number;
}

/** Firings a routine run id is made of: its trigger and what tells the event apart */
const RUN_ID_PREFIX = 'trg_';
/** The longest run id the runtime takes */
const MAX_RUN_ID = 200;
const DEFAULT_DEDUP_TTL = 24 * 60 * 60 * 1000;
const DEFAULT_CATCH_UP_WINDOW = 7 * 24 * 60 * 60 * 1000;
/** How long the claim on a firing's run id is kept: longer than a provider retries */
const RUN_CLAIM_TTL = 3 * 24 * 60 * 60 * 1000;
const SCHEDULE_INIT_TTL = 30_000;
/** Failed firings in a row after which a schedule entry is skipped until resumed */
const SCHEDULE_RETRIES = 5;
/** How far ahead the entry of a one-shot task is held while its run goes on, renewed meanwhile */
const TASK_HOLD_MS = 5 * 60 * 1000;
/** The first wait before a one-shot task whose run failed is due again, doubled each time */
const TASK_RETRY_BASE_MS = 1000;
const TASK_RETRY_MAX_MS = 5 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MAX_SUMMARY = 300;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function idPart(text: string): string {
  return text.replace(/[^A-Za-z0-9_.:-]/g, '-');
}

/** What tells a firing apart in its run id: no `.`, so the run id splits at its last one */
function keyPart(text: string): string {
  return text.replace(/[^A-Za-z0-9_-]/g, '-');
}

/**
 * The run id of a firing: `trg_<routineId>.<triggerId>.<key>`. Routine and trigger ids hold no
 * `.` and the key none either, so two triggers never share a run id. A trigger id too long for a
 * run id goes by its digest
 */
export function routineRunId(triggerId: string, key: string): string {
  const id = `${RUN_ID_PREFIX}${triggerId}.${keyPart(key)}`;
  return id.length <= MAX_RUN_ID
    ? id
    : `${RUN_ID_PREFIX}${digest(triggerId)}.${keyPart(key)}`.slice(0, MAX_RUN_ID);
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function isRunLeased(error: unknown): boolean {
  return CogitatorError.isCogitatorError(error) && error.code === ErrorCode.RUN_LEASED;
}

function isRunSuspended(error: unknown): boolean {
  return CogitatorError.isCogitatorError(error) && error.code === ErrorCode.RUN_SUSPENDED;
}

/**
 * Whether a run ended without ending: another process holds it (`RUN_LEASED`), or it stopped to
 * be taken up later with its checkpoint kept (`RUN_SUSPENDED`, its durable store was down). Its
 * record of a run going on stays for `recover`, and it writes no failure
 */
function handedOver(outcome: Outcome): boolean {
  return outcome.kind === 'error' && (isRunLeased(outcome.error) || isRunSuspended(outcome.error));
}

function summaryOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_SUMMARY ? flat : `${flat.slice(0, MAX_SUMMARY - 3)}...`;
}

function configurationError(message: string): CogitatorError {
  return new CogitatorError({ message, code: ErrorCode.CONFIGURATION_ERROR });
}

function notFound(message: string): CogitatorError {
  return new CogitatorError({ message, code: ErrorCode.TRIGGER_NOT_FOUND });
}

/**
 * Experimental. Routines and their triggers in a runtime: `cog.experimental_triggers`.
 *
 * - `start()` loads the cron engine, makes sure every cron trigger has its entry in the schedules
 *   store (a routine kept in the store or registered by a plugin as much as one in code), starts
 *   polling it, and continues the durable runs of routines a stopped process left
 * - `handle()` answers the HTTP request of a trigger (the server adapters call it), `fire()` fires
 *   one by hand
 * - each firing starts a session with the routine's prompt as the task and the event as untrusted
 *   data, once however many times it is delivered, as `overlap` and `maxConcurrent` allow
 * - results, failures and runs waiting for a person go to `inbox`, and to the `Notification`
 *   hooks as `routine_result` and `routine_failed`
 */
export class experimental_TriggerManager {
  readonly inbox: experimental_Inbox;
  readonly store: RoutineStore;
  readonly scheduler: experimental_Scheduler;
  private readonly code = new Map<string, Registered>();
  private readonly fromPlugins = new Map<string, Registered>();
  private readonly live = new Map<string, RoutineLive>();
  private readonly rates = new Map<string, number[]>();
  private readonly pending = new Set<Promise<unknown>>();
  /** Runs aborted by `overlap: 'replace'`: their end is recorded as replaced, not failed */
  private readonly replaced = new Set<string>();
  private readonly listeners = new Set<(event: TriggerManagerEvent) => void>();
  /** Tasks agents gave themselves whose run goes on, by schedule entry: their next occurrence is skipped */
  private readonly runningTasks = new Map<string, string>();
  private cronEngine?: CronEngine;
  private started?: Promise<void>;
  private unsubscribePlugins?: () => void;
  private stopped = false;

  constructor(
    private readonly config: TriggersConfig,
    private readonly runtime: TriggerRuntime
  ) {
    this.store = config.store ?? new experimental_InMemoryRoutineStore();
    this.inbox = new experimental_Inbox({
      ...(config.inbox && { store: config.inbox }),
      ...(config.sinks && { sinks: config.sinks }),
    });
    this.cronEngine = config.cron;
    for (const routine of config.routines ?? []) {
      const problem = routineProblem(routine);
      if (problem) throw configurationError(`experimental_triggers.routines: ${problem}`);
      if (this.code.has(routine.id)) {
        throw configurationError(`experimental_triggers.routines: two routines are ${routine.id}`);
      }
      this.code.set(routine.id, { routine, origin: 'code' });
    }
    this.scheduler = new experimental_Scheduler({
      store: config.schedules ?? new InMemoryTimerStore(),
      ...(config.cron && { cron: config.cron }),
      pollInterval: config.pollInterval ?? 1000,
      maxRetries: SCHEDULE_RETRIES,
      accepts: (entry) => entry.trigger !== undefined,
      fire: (fire) => this.fireScheduled(fire),
      onError: (error, entry) =>
        this.report({
          type: 'error',
          error: error.message,
          ...(entry?.trigger?.routineId !== undefined && { routineId: entry.trigger.routineId }),
        }),
    });
  }

  /** The cron engine, loaded on first use */
  async cron(): Promise<CronEngine> {
    this.cronEngine ??= this.config.cron ?? (await experimental_loadCronEngine());
    return this.cronEngine;
  }

  /**
   * Starts the manager once: checks the cron expressions of routines in code, brings the
   * schedules of every routine in line with its triggers, polls the schedules store and continues
   * routine runs a stopped process left
   */
  start(): Promise<void> {
    this.stopped = false;
    this.started ??= this.begin().catch((error: unknown) => {
      this.started = undefined;
      throw error;
    });
    return this.started;
  }

  private async begin(): Promise<void> {
    const engine = await this.cron();
    for (const { routine } of this.code.values()) this.checkCron(routine, engine);
    if (this.stopped) return;
    if (this.runtime.plugins) {
      this.unsubscribePlugins = this.runtime.plugins.onChange(() => {
        this.track(this.syncPlugins());
      });
      await this.syncPlugins();
    }
    for (const registered of await this.all()) {
      if (this.stopped) return;
      await this.syncSchedules(registered);
    }
    if (this.stopped) return;
    await this.recover();
    if (this.stopped) return;
    await this.scheduler.start();
    if (this.stopped) await this.scheduler.stop();
  }

  /**
   * Stops polling the schedules, after a `start()` going on is done. Runs going on are left to
   * finish, their results still reach the inbox. Firings queued behind them are dropped: their
   * claims are given back, so a provider's redelivery starts them, and the history says so.
   * Resolves once the poll going on and the work it started are done
   */
  async stop(): Promise<void> {
    this.stopped = true;
    const starting = this.started;
    if (starting) await starting.catch(() => undefined);
    this.unsubscribePlugins?.();
    this.unsubscribePlugins = undefined;
    await this.scheduler.stop();
    this.started = undefined;
    await this.dropQueued();
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** Gives back the claims of the firings waiting in the queues and records them skipped */
  private async dropQueued(): Promise<void> {
    for (const [routineId, live] of this.live) {
      for (const waiting of live.queue.splice(0)) {
        const { event } = waiting;
        try {
          await this.store.releaseKey(`run:${waiting.runId}`);
          if (waiting.dedup !== undefined) await this.store.releaseKey(waiting.dedup);
        } catch (error) {
          this.report({ type: 'error', error: errorText(error), routineId });
        }
        await this.record({
          id: event.id,
          routineId,
          triggerId: event.triggerId,
          source: event.source,
          at: event.occurredAt,
          ...(event.scheduledFor !== undefined && { scheduledFor: event.scheduledFor }),
          status: 'skipped',
          runId: waiting.runId,
          reason: 'the trigger manager stopped before the firing started',
          finishedAt: Date.now(),
        });
      }
    }
  }

  /** Resolves once every run of every routine going on now has ended and reached the inbox */
  async idle(): Promise<void> {
    for (;;) {
      const runs = [...this.live.values()].flatMap((live) => [...live.runs.values()]);
      if (runs.length === 0 && this.pending.size === 0) return;
      await Promise.allSettled([
        ...this.pending,
        ...runs.map((run) => run.handle?.result ?? Promise.resolve()),
      ]);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /** Keeps work going on in the background: `stop()` and `idle()` wait for it, its failure is reported */
  private track(work: Promise<unknown>): void {
    const kept = work
      .catch((error: unknown) => this.report({ type: 'error', error: errorText(error) }))
      .finally(() => this.pending.delete(kept));
    this.pending.add(kept);
  }

  private report(event: TriggerManagerEvent): void {
    if (event.type === 'error') getLogger().warn('Trigger manager', { error: event.error });
    for (const listener of [this.config.onEvent, ...this.listeners]) {
      try {
        listener?.(event);
      } catch (error) {
        getLogger().warn('A listener of the trigger manager failed', { error: errorText(error) });
      }
    }
  }

  /** Hears what the manager does (firings, ended runs, inbox items, errors), as `onEvent` does */
  subscribe(listener: (event: TriggerManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Whether `start()` ran and the schedules are polled */
  get isStarted(): boolean {
    return this.scheduler.isRunning;
  }

  private checkCron(routine: RoutineDefinition, engine: CronEngine): void {
    for (const spec of routine.triggers ?? []) {
      if (spec.kind !== 'cron') continue;
      const problem = engine.problem(spec.cron, spec.timezone);
      if (problem) {
        throw configurationError(
          `Trigger ${fullTriggerId(routine.id, triggerIdOf(spec))}: ${problem}`
        );
      }
    }
  }

  /** Every routine the manager knows: in code, from plugins and in the store */
  private async all(): Promise<Registered[]> {
    const found = new Map<string, Registered>();
    for (const routine of await this.store.listRoutines()) {
      found.set(routine.id, { routine, origin: 'store' });
    }
    for (const [id, registered] of this.fromPlugins) found.set(id, registered);
    for (const [id, registered] of this.code) found.set(id, registered);
    return [...found.values()];
  }

  /** A routine by id: code first, then plugins, then the store, read fresh */
  private async find(id: string): Promise<Registered | undefined> {
    const known = this.code.get(id) ?? this.fromPlugins.get(id);
    if (known) return known;
    const stored = await this.store.getRoutine(id);
    return stored ? { routine: stored, origin: 'store' } : undefined;
  }

  private liveOf(routineId: string): RoutineLive {
    let live = this.live.get(routineId);
    if (!live) {
      live = { runs: new Map(), queue: [], starting: 0 };
      this.live.set(routineId, live);
    }
    return live;
  }

  private async syncPlugins(): Promise<void> {
    const plugins = this.runtime.plugins;
    if (!plugins) return;
    const current = new Map<string, Registered>();
    for (const entry of plugins.routines()) {
      current.set(entry.routine.id, {
        routine: entry.routine,
        origin: 'plugin',
        plugin: entry.plugin,
      });
    }
    const engine = this.cronEngine;
    for (const [id, registered] of current) {
      const before = this.fromPlugins.get(id);
      if (before?.routine === registered.routine) continue;
      const refused = this.pluginRoutineProblem(registered);
      if (refused) {
        this.report({ type: 'error', error: refused, routineId: id });
        current.delete(id);
        continue;
      }
      try {
        if (engine) this.checkCron(registered.routine, engine);
      } catch (error) {
        this.report({ type: 'error', error: errorText(error), routineId: id });
        continue;
      }
      this.fromPlugins.set(id, registered);
      if (this.started) await this.syncSchedules(registered);
    }
    for (const [id, registered] of this.fromPlugins) {
      if (current.has(id)) continue;
      this.fromPlugins.delete(id);
      await this.dropSchedules(registered.routine.id, []);
    }
  }

  /**
   * Why a plugin's routine may not run, undefined when it may: it acts for a user, continues a
   * thread or tells an owner (only the host's code decides those), or targets an agent or workflow
   * by a name `pluginTargets` does not list
   */
  private pluginRoutineProblem(registered: Registered): string | undefined {
    const { routine } = registered;
    const by = `Routine ${routine.id} of plugin ${registered.plugin ?? 'unknown'}`;
    if (routine.userId !== undefined || routine.owner !== undefined) {
      return `${by} may not set userId or owner`;
    }
    if (routine.session !== undefined && routine.session !== 'new') {
      return `${by} may not continue a thread`;
    }
    const allowed = this.config.pluginTargets;
    if ('agent' in routine.target) {
      const agent = routine.target.agent;
      if (typeof agent === 'string' && !allowed?.agents?.includes(agent)) {
        return `${by} targets agent ${agent}, which experimental_triggers.pluginTargets.agents does not list`;
      }
    } else {
      const workflow = routine.target.workflow;
      if (typeof workflow === 'string' && !allowed?.workflows?.includes(workflow)) {
        return `${by} targets workflow ${workflow}, which experimental_triggers.pluginTargets.workflows does not list`;
      }
    }
    return undefined;
  }

  /** Changes a trigger's state in one step of the store */
  private patchState(
    routineId: string,
    triggerId: string,
    patch: TriggerStatePatch
  ): Promise<TriggerState> {
    return this.store.patchTriggerState(fullTriggerId(routineId, triggerId), routineId, patch);
  }

  private async state(routineId: string, triggerId: string): Promise<TriggerState> {
    const id = fullTriggerId(routineId, triggerId);
    return (await this.store.getTriggerState(id)) ?? { id, routineId, fireCount: 0 };
  }

  private enabled(routine: RoutineDefinition, spec: TriggerSpec, state: TriggerState): boolean {
    return routine.enabled !== false && (state.enabled ?? spec.enabled ?? true);
  }

  /**
   * Makes the schedules store hold one entry per cron trigger of the routine, with its expression,
   * time zone and catch-up, and none for triggers it no longer has
   */
  private async syncSchedules(registered: Registered): Promise<void> {
    const { routine } = registered;
    const engine = await this.cron();
    const kept: string[] = [];
    const lockedOut: string[] = [];
    for (const spec of routine.triggers ?? []) {
      if (spec.kind !== 'cron') continue;
      const triggerId = triggerIdOf(spec);
      const id = fullTriggerId(routine.id, triggerId);
      const state = await this.state(routine.id, triggerId);
      const cron = engine.normalize(spec.cron);
      const catchUp = routine.catchUp ?? 'latest';
      const catchUpWindowMs = routine.catchUpWindowMs ?? DEFAULT_CATCH_UP_WINDOW;
      const enabled = this.enabled(routine, spec, state);
      let entry = state.scheduleId ? await this.scheduler.get(state.scheduleId) : null;
      if (entry && (entry.fired || entry.cancelled)) entry = null;
      if (entry) {
        const patch: Partial<TimerEntry> = {};
        if (entry.cron !== cron || entry.timezone !== spec.timezone) {
          patch.cron = cron;
          patch.timezone = spec.timezone;
          patch.firesAt = engine.next(cron, Date.now(), spec.timezone);
        }
        if (entry.catchUp !== catchUp) patch.catchUp = catchUp;
        if (entry.catchUpWindowMs !== catchUpWindowMs) patch.catchUpWindowMs = catchUpWindowMs;
        if ((entry.enabled ?? true) !== enabled) patch.enabled = enabled;
        if (Object.keys(patch).length > 0) await this.scheduler.store.update(entry.id, patch);
        kept.push(entry.id);
        continue;
      }
      const lock = `schedule:${id}`;
      if (!(await this.store.claimKey(lock, SCHEDULE_INIT_TTL))) {
        lockedOut.push(triggerId);
        continue;
      }
      try {
        const fresh = await this.state(routine.id, triggerId);
        const existing = fresh.scheduleId ? await this.scheduler.get(fresh.scheduleId) : null;
        if (existing && !existing.fired && !existing.cancelled) {
          kept.push(existing.id);
          continue;
        }
        const added = await this.scheduler.add({
          name: routine.name ?? routine.id,
          cron,
          ...(spec.timezone !== undefined && { timezone: spec.timezone }),
          catchUp,
          catchUpWindowMs,
          enabled,
          trigger: { routineId: routine.id, triggerId },
          workflowId: 'routines',
          runId: routine.id,
          nodeId: triggerId,
        });
        await this.patchState(routine.id, triggerId, { scheduleId: added.id });
        kept.push(added.id);
      } finally {
        await this.store.releaseKey(lock);
      }
    }
    await this.dropSchedules(routine.id, kept, lockedOut);
  }

  /**
   * Cancels the pending schedule entries of a routine but those in `keep` and those of the
   * triggers in `keepTriggers`: another process holds the lock that creates their entry, so the
   * one it just added is not stale
   */
  private async dropSchedules(
    routineId: string,
    keep: readonly string[],
    keepTriggers: readonly string[] = []
  ): Promise<void> {
    for (const entry of await this.scheduler.store.getPending()) {
      if (entry.trigger?.routineId !== routineId || keep.includes(entry.id)) continue;
      if (entry.trigger.triggerId !== undefined && keepTriggers.includes(entry.trigger.triggerId)) {
        continue;
      }
      await this.scheduler.remove(entry.id);
    }
  }

  /** The routines, with their triggers and runs going on */
  async list(): Promise<RoutineInfo[]> {
    const infos: RoutineInfo[] = [];
    for (const registered of await this.all()) infos.push(await this.info(registered));
    return infos.sort((a, b) => a.routine.id.localeCompare(b.routine.id));
  }

  /** One routine, undefined when there is none */
  async get(id: string): Promise<RoutineInfo | undefined> {
    const registered = await this.find(id);
    return registered ? this.info(registered) : undefined;
  }

  private async info(registered: Registered): Promise<RoutineInfo> {
    const { routine } = registered;
    const triggers: TriggerInfo[] = [];
    for (const spec of routine.triggers ?? []) {
      const triggerId = triggerIdOf(spec);
      const state = await this.state(routine.id, triggerId);
      const entry =
        spec.kind === 'cron' && state.scheduleId
          ? await this.scheduler.get(state.scheduleId)
          : null;
      triggers.push({
        id: fullTriggerId(routine.id, triggerId),
        routineId: routine.id,
        kind: spec.kind,
        enabled: this.enabled(routine, spec, state),
        spec: specSummary(spec),
        state,
        ...(entry && !entry.fired && !entry.cancelled && { nextFireAt: entry.firesAt }),
        ...(state.scheduleId !== undefined && { scheduleId: state.scheduleId }),
      });
    }
    const live = this.live.get(routine.id);
    return {
      routine: this.shown(routine),
      origin: registered.origin,
      ...(registered.plugin !== undefined && { plugin: registered.plugin }),
      triggers,
      active: live?.runs.size ?? 0,
      queued: live?.queue.length ?? 0,
    };
  }

  /** A routine as it may be shown: the triggers' secrets left out, the target named */
  private shown(routine: RoutineDefinition): RoutineDefinition {
    const target =
      'agent' in routine.target
        ? {
            agent:
              typeof routine.target.agent === 'string'
                ? routine.target.agent
                : routine.target.agent.name,
          }
        : {
            workflow:
              typeof routine.target.workflow === 'string'
                ? routine.target.workflow
                : routine.target.workflow.name,
          };
    return {
      ...routine,
      target,
      triggers: (routine.triggers ?? []).map((spec) => specSummary(spec) as unknown as TriggerSpec),
    };
  }

  /**
   * Saves a routine to the store and schedules its cron triggers. A routine in code or from a
   * plugin with the same id cannot be replaced
   *
   * @throws CogitatorError `VALIDATION_ERROR` for a routine that is not valid or cannot be saved
   */
  async create(routine: RoutineDefinition): Promise<RoutineInfo> {
    const problem = routineProblem(routine) ?? storableProblem(routine);
    if (problem) throw new CogitatorError({ message: problem, code: ErrorCode.VALIDATION_ERROR });
    if (this.code.has(routine.id) || this.fromPlugins.has(routine.id)) {
      throw new CogitatorError({
        message: `Routine ${routine.id} is defined in code or by a plugin`,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    try {
      this.checkCron(routine, await this.cron());
    } catch (error) {
      throw new CogitatorError({ message: errorText(error), code: ErrorCode.VALIDATION_ERROR });
    }
    await this.store.saveRoutine(routine);
    const registered: Registered = { routine, origin: 'store' };
    await this.syncSchedules(registered);
    return this.info(registered);
  }

  /** Removes a routine of the store, its schedules and trigger state */
  async remove(id: string): Promise<boolean> {
    const routine = await this.store.getRoutine(id);
    if (!routine) return false;
    await this.store.deleteRoutine(id);
    await this.dropSchedules(id, []);
    for (const state of await this.store.listTriggerStates(id)) {
      await this.store.deleteTriggerState(state.id);
    }
    return true;
  }

  /**
   * Pauses (`false`) or resumes a trigger, by `<routineId>.<triggerId>`, or every trigger of a
   * routine by its id. A resumed schedule goes on from its next occurrence
   */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const split = splitTriggerId(id);
    const routineId = (await this.find(id)) ? id : split?.routineId;
    const registered = routineId ? await this.find(routineId) : undefined;
    if (!registered || !routineId) throw notFound(`No routine or trigger ${id}`);
    const specs = (registered.routine.triggers ?? []).filter(
      (spec) => routineId === id || triggerIdOf(spec) === split?.triggerId
    );
    if (specs.length === 0 && routineId !== id) throw notFound(`No trigger ${id}`);
    for (const spec of specs) {
      const triggerId = triggerIdOf(spec);
      const state = await this.patchState(routineId, triggerId, { enabled });
      if (spec.kind === 'cron' && state.scheduleId) {
        if (enabled) await this.scheduler.resume(state.scheduleId);
        else await this.scheduler.pause(state.scheduleId);
      }
    }
  }

  /**
   * Issues a new API token for an `api` trigger without a token of its own, replacing the one
   * before: the token is returned once, the store keeps its SHA-256
   */
  async issueToken(id: string): Promise<{ token: string; hint: string }> {
    const { registered, spec } = await this.resolveTrigger(id);
    if (spec.kind !== 'api') throw notFound(`Trigger ${id} is not an API trigger`);
    if (spec.token !== undefined) {
      throw new CogitatorError({
        message: `Trigger ${id} takes the token of its spec, change it there`,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    const token = generateTriggerToken();
    const hint = token.slice(-4);
    await this.patchState(registered.routine.id, triggerIdOf(spec), {
      tokenHash: hashTriggerToken(token),
      tokenHint: hint,
      tokenIssuedAt: Date.now(),
    });
    return { token, hint };
  }

  /** The same as `issueToken`: the token before stops working */
  rotateToken(id: string): Promise<{ token: string; hint: string }> {
    return this.issueToken(id);
  }

  private async resolveTrigger(
    id: string
  ): Promise<{ registered: Registered; spec: TriggerSpec; triggerId: string }> {
    const split = splitTriggerId(id);
    const registered = split ? await this.find(split.routineId) : undefined;
    const spec = registered?.routine.triggers?.find(
      (candidate) => triggerIdOf(candidate) === split?.triggerId
    );
    if (!split || !registered || !spec) throw notFound(`No trigger ${id}`);
    return { registered, spec, triggerId: split.triggerId };
  }

  /**
   * Answers a trigger's HTTP request: `fire` for `POST /triggers/:id/fire` (API triggers),
   * `webhook` for `POST /triggers/:id/webhook` (webhook, GitHub, email and Slack triggers)
   */
  async handle(
    id: string,
    route: 'fire' | 'webhook',
    request: TriggerHttpRequest
  ): Promise<TriggerHttpResponse> {
    let found: Awaited<ReturnType<typeof this.resolveTrigger>>;
    try {
      found = await this.resolveTrigger(id);
    } catch {
      return { status: 404, body: { error: { code: 'NOT_FOUND', message: `No trigger ${id}` } } };
    }
    const { registered, spec, triggerId } = found;
    const routine = registered.routine;
    const wrongRoute =
      route === 'fire' ? spec.kind !== 'api' : spec.kind === 'api' || spec.kind === 'cron';
    if (wrongRoute) {
      return {
        status: 404,
        body: {
          error: { code: 'NOT_FOUND', message: `Trigger ${id} does not take ${route} requests` },
        },
      };
    }
    const state = await this.state(routine.id, triggerId);
    const target = { triggerId: id, routineId: routine.id };
    let outcome: SourceOutcome;
    switch (spec.kind) {
      case 'api':
        outcome = readApiFire(spec, state, request, target);
        break;
      case 'webhook':
        outcome = readWebhook(spec, request, target);
        break;
      case 'github':
        outcome = readGitHub(spec, request, target);
        break;
      case 'email':
        outcome = await readEmail(spec, request, target);
        break;
      case 'slack':
        outcome = readSlack(spec, request, target);
        break;
      default:
        return { status: 404, body: { error: { code: 'NOT_FOUND', message: `No trigger ${id}` } } };
    }
    if (outcome.kind === 'answer') return outcome.response;
    if (!this.enabled(routine, spec, state)) {
      return {
        status: 409,
        body: { error: { code: 'TRIGGER_DISABLED', message: `Trigger ${id} is paused` } },
      };
    }
    const limited = this.rateLimited(id, spec);
    if (limited !== undefined) {
      return {
        status: 429,
        headers: { 'Retry-After': String(limited) },
        body: {
          error: {
            code: 'RATE_LIMITED',
            message: `Trigger ${id} takes at most ${spec.maxPerHour} events an hour`,
          },
        },
      };
    }
    const replay =
      outcome.replay !== undefined ? `replay:${id}:${digest(outcome.replay.key)}` : undefined;
    if (
      replay !== undefined &&
      outcome.replay !== undefined &&
      !(await this.store.claimKey(
        replay,
        Math.max(outcome.replay.ttlMs, this.config.dedupTtlMs ?? DEFAULT_DEDUP_TTL)
      ))
    ) {
      return {
        status: 200,
        body: this.result(outcome.event, routine.id, 'duplicate', {
          reason: 'The signature was used before',
        }),
      };
    }
    try {
      const result = await this.dispatch(registered, outcome.event, this.eventKey(outcome.event));
      const status = result.status === 'duplicate' ? 200 : spec.kind === 'slack' ? 200 : 202;
      return { status, body: result };
    } catch (error) {
      if (replay !== undefined) await this.store.releaseKey(replay).catch(() => undefined);
      this.report({ type: 'error', error: errorText(error), routineId: routine.id, triggerId: id });
      return {
        status: 500,
        body: { error: { code: 'INTERNAL_ERROR', message: 'The routine could not be started' } },
      };
    }
  }

  /** Seconds to wait when the trigger took `maxPerHour` events in the last hour, else undefined */
  private rateLimited(id: string, spec: TriggerSpec): number | undefined {
    if (spec.maxPerHour === undefined) return undefined;
    const now = Date.now();
    const times = (this.rates.get(id) ?? []).filter((at) => now - at < HOUR);
    if (times.length >= spec.maxPerHour) {
      this.rates.set(id, times);
      return Math.max(1, Math.ceil((times[0] + HOUR - now) / 1000));
    }
    times.push(now);
    this.rates.set(id, times);
    return undefined;
  }

  /**
   * Fires a trigger by hand, as a person does from Studio or the CLI: an event of source `manual`
   * with what is given as its text and payload, as untrusted as any other
   */
  async fire(
    id: string,
    input: { text?: string; payload?: unknown; actor?: string } = {}
  ): Promise<TriggerFireResult> {
    const { registered } = await this.resolveTrigger(id);
    const event = experimental_createTriggerEvent({
      source: 'manual',
      triggerId: id,
      routineId: registered.routine.id,
      verified: { method: 'manual', ok: true },
      ...(input.text !== undefined && { text: input.text }),
      ...(input.payload !== undefined && { payload: input.payload }),
      ...(input.actor !== undefined && { actor: input.actor }),
    });
    return this.dispatch(registered, event, this.eventKey(event));
  }

  /** What tells an event's run apart: its delivery id when it has one, else the event */
  private eventKey(event: TriggerEvent): string {
    return event.dedupKey !== undefined ? digest(event.dedupKey) : keyPart(event.id);
  }

  private async fireScheduled(fire: ScheduledFire): Promise<ScheduledHold | undefined> {
    const { entry, occurrence } = fire;
    const trigger = entry.trigger;
    if (!trigger) return undefined;
    if (trigger.agent !== undefined) return this.fireAgentTask(entry, occurrence);
    const routineId = trigger.routineId;
    const triggerId = trigger.triggerId;
    const registered = routineId ? await this.find(routineId) : undefined;
    const spec = registered?.routine.triggers?.find(
      (candidate) => candidate.kind === 'cron' && triggerIdOf(candidate) === triggerId
    );
    if (!registered || !spec || !routineId || !triggerId) {
      await this.scheduler.remove(entry.id);
      this.report({
        type: 'error',
        error: `Schedule ${entry.id} fires routine trigger ${routineId}.${triggerId}, which is gone: it is removed`,
      });
      return undefined;
    }
    const state = await this.state(routineId, triggerId);
    if (!this.enabled(registered.routine, spec, state)) return undefined;
    const event = experimental_createTriggerEvent({
      source: 'cron',
      triggerId: fullTriggerId(routineId, triggerId),
      routineId,
      scheduledFor: occurrence,
      verified: { method: 'schedule', ok: true },
    });
    await this.dispatch(registered, event, String(occurrence));
    return undefined;
  }

  /**
   * A task an agent gave itself came due: its agent continues the thread it was given in. While
   * the run of an earlier occurrence of the task goes on, this one is skipped. A one-shot task
   * is held while its run goes on (its entry pushed `TASK_HOLD_MS` ahead and renewed, so neither
   * this poll nor another process waits for it or fires it again) and settled when the run ends:
   * fired, or on a failure (a provider down, say) due again after a backoff, up to its retries,
   * unless it is `bestEffort`. Its failure goes to the inbox once no retry is left
   */
  private async fireAgentTask(
    entry: TimerEntry,
    occurrence: number
  ): Promise<ScheduledHold | undefined> {
    const name = entry.trigger?.agent ?? '';
    const agent = this.config.agents?.[name];
    if (!agent) {
      throw configurationError(
        `Task ${entry.id} runs on agent ${name}, which is not in experimental_triggers.agents`
      );
    }
    const oneShot = !entry.cron && !(entry.type === 'recurring' && entry.interval);
    const meta = entry.metadata ?? {};
    const hold = (): ScheduledHold => ({ holdUntil: Date.now() + TASK_HOLD_MS });
    const going = this.runningTasks.get(entry.id);
    if (going !== undefined) {
      if (oneShot) return hold();
      this.report({
        type: 'error',
        error: `Task ${entry.id} skipped the occurrence of ${new Date(occurrence).toISOString()}: its run ${going} goes on`,
      });
      return undefined;
    }
    if (
      oneShot &&
      typeof meta.taskRun === 'string' &&
      (await this.store.getActiveRun(meta.taskRun))
    ) {
      return hold();
    }
    const description =
      typeof meta.description === 'string' ? meta.description : (entry.name ?? '');
    const runId = `${RUN_ID_PREFIX}${idPart(entry.id)}_${occurrence}`;
    if (!(await this.store.claimKey(`run:${runId}`, RUN_CLAIM_TTL))) {
      return oneShot ? hold() : undefined;
    }
    const threadId = typeof meta.threadId === 'string' ? meta.threadId : `task_${idPart(entry.id)}`;
    const userId = typeof meta.userId === 'string' ? meta.userId : undefined;
    const event = experimental_createTriggerEvent({
      source: 'agent',
      triggerId: entry.id,
      scheduledFor: occurrence,
      verified: { method: 'agent', ok: true },
      text: description,
    });
    const task: ActiveRoutineRun = {
      runId,
      kind: 'task',
      eventId: event.id,
      triggerId: entry.id,
      source: 'agent',
      at: event.occurredAt,
      scheduledFor: occurrence,
      threadId,
      agent: name,
      description,
      ...(userId !== undefined && { userId }),
    };
    if (oneShot) {
      await this.scheduler.store.update(entry.id, { metadata: { ...meta, taskRun: runId } });
    }
    const handle = this.runtime.start(agent, {
      input: experimental_agentTaskInput(event),
      threadId,
      runId,
      ...(userId !== undefined && { userId }),
      durable: this.durable,
      inputMetadata: { trigger: event },
    });
    const retried =
      oneShot && meta.bestEffort !== true && (entry.consecutiveErrors ?? 0) + 1 < SCHEDULE_RETRIES;
    await this.followTask(task, handle.result, { reportFailure: !retried, holdEntry: oneShot });
    return oneShot ? hold() : undefined;
  }

  /**
   * Keeps the entry of a one-shot task held while its run goes on, pushing it ahead every third
   * of `TASK_HOLD_MS`. Returns what stops it, resolving once a push going on is done
   */
  private holdEntry(entryId: string): () => Promise<void> {
    let pushing: Promise<unknown> = Promise.resolve();
    const timer = setInterval(() => {
      pushing = this.scheduler.store
        .update(entryId, { firesAt: Date.now() + TASK_HOLD_MS })
        .catch((error: unknown) => this.report({ type: 'error', error: errorText(error) }));
    }, TASK_HOLD_MS / 3);
    timer.unref?.();
    return async () => {
      clearInterval(timer);
      await pushing;
    };
  }

  /**
   * Settles the entry of a one-shot task once the run it holds the entry for has ended: fired
   * when it completed (or failed, for `bestEffort`), else its failures in a row counted and due
   * again after a backoff, which the scheduler skips past its retries. A run handed over to
   * another process or suspended leaves the entry held, for whoever takes the run up
   */
  private async settleTaskEntry(task: ActiveRoutineRun, outcome: Outcome): Promise<void> {
    const entry = await this.scheduler.get(task.triggerId);
    if (!entry || entry.fired || entry.cancelled || entry.metadata?.taskRun !== task.runId) return;
    if (entry.cron || (entry.type === 'recurring' && entry.interval)) return;
    if (handedOver(outcome)) return;
    const now = Date.now();
    const failed = outcome.kind === 'error';
    if (!failed || entry.metadata?.bestEffort === true) {
      await this.scheduler.store.update(entry.id, {
        lastRunAt: now,
        lastRunStatus: failed ? 'error' : 'ok',
        consecutiveErrors: 0,
        ...(failed ? { lastError: errorText(outcome.error) } : { lastError: undefined }),
      });
      await this.scheduler.store.markFired(entry.id);
      return;
    }
    const errors = (entry.consecutiveErrors ?? 0) + 1;
    await this.scheduler.store.update(entry.id, {
      lastRunAt: now,
      lastRunStatus: 'error',
      lastError: errorText(outcome.error),
      consecutiveErrors: errors,
      firesAt: now + Math.min(TASK_RETRY_BASE_MS * 2 ** (errors - 1), TASK_RETRY_MAX_MS),
    });
  }

  /**
   * Waits for the run of a task in the background: the task's next occurrences are skipped
   * meanwhile, its outcome goes to the inbox, and a durable run is kept for `recover`
   */
  private async followTask(
    task: ActiveRoutineRun,
    result: Promise<RunResult>,
    options: { reportFailure?: boolean; holdEntry?: boolean } = {}
  ): Promise<{ outcome: Promise<Outcome> }> {
    this.runningTasks.set(task.triggerId, task.runId);
    if (this.durable) await this.saveActive(task);
    const lease = this.runtime.plugins?.lease();
    const outcome = settle(result);
    const stopHolding = options.holdEntry
      ? this.holdEntry(task.triggerId)
      : () => Promise.resolve();
    let ended: Outcome | undefined;
    this.track(
      outcome
        .then(async (settled) => {
          ended = settled;
          await stopHolding();
          await this.settleTaskEntry(task, settled);
          if (settled.kind === 'error' && options.reportFailure === false) return;
          await this.finishTask(task, settled);
        })
        .finally(async () => {
          lease?.release();
          if (this.runningTasks.get(task.triggerId) === task.runId) {
            this.runningTasks.delete(task.triggerId);
          }
          if (!(ended && handedOver(ended))) await this.dropActive(task.runId);
        })
    );
    return { outcome };
  }

  /** What a task's run came to, in the inbox: its answer, its failure, or what it waits for */
  private async finishTask(task: ActiveRoutineRun, outcome: Outcome): Promise<void> {
    const description = task.description ?? '';
    const common = {
      source: 'agent' as const,
      runId: task.runId,
      threadId: task.threadId,
      triggerEventId: task.eventId,
      ...(task.userId !== undefined && { userId: task.userId }),
    };
    if (outcome.kind === 'error') {
      if (handedOver(outcome)) return;
      await this.addToInbox({
        ...common,
        kind: 'failure',
        title: `Scheduled task failed: ${description}`,
        summary: errorText(outcome.error),
      });
      return;
    }
    if (outcome.kind !== 'agent') return;
    const result = outcome.result;
    if (result.status === 'paused') {
      await this.addToInbox(
        waitingItem(result, `Scheduled task: ${description}`, common, {
          agent: task.agent,
          taskId: task.triggerId,
          description,
        })
      );
      return;
    }
    await this.addToInbox({
      ...common,
      kind: 'result',
      title: `Scheduled task: ${description}`,
      summary: summaryOf(result.output),
      ...(result.output.length > MAX_SUMMARY && { body: result.output }),
    });
  }

  /** Keeps a run going on in the store, for `recover` after a restart */
  private async saveActive(run: ActiveRoutineRun): Promise<void> {
    try {
      await this.store.saveActiveRun(run);
    } catch (error) {
      this.report({
        type: 'error',
        error: `Could not keep run ${run.runId} for recovery: ${errorText(error)}`,
        ...(run.routineId !== undefined && { routineId: run.routineId }),
      });
    }
  }

  private async dropActive(runId: string): Promise<void> {
    if (!this.durable) return;
    try {
      await this.store.deleteActiveRun(runId);
    } catch (error) {
      this.report({ type: 'error', error: errorText(error) });
    }
  }

  private get durable(): boolean {
    return this.config.durable ?? this.runtime.durable;
  }

  private async record(record: RoutineRunRecord): Promise<void> {
    try {
      await this.store.recordRun(record);
    } catch (error) {
      this.report({
        type: 'error',
        error: `Could not record a run: ${errorText(error)}`,
        routineId: record.routineId,
      });
    }
  }

  private result(
    event: TriggerEvent,
    routineId: string,
    status: TriggerFireResult['status'],
    extra: { runId?: string; threadId?: string; reason?: string } = {}
  ): TriggerFireResult {
    return {
      type: 'routine_fire',
      status,
      eventId: event.id,
      routineId,
      triggerId: event.triggerId,
      ...extra,
    };
  }

  /**
   * Starts the run of one firing, once: a repeated delivery (`dedupKey`) and a second worker
   * firing the same occurrence find the claim taken. Then `overlap` and `maxConcurrent` decide
   */
  private async dispatch(
    registered: Registered,
    event: TriggerEvent,
    key: string
  ): Promise<TriggerFireResult> {
    const { routine } = registered;
    const dedupTtl = this.config.dedupTtlMs ?? DEFAULT_DEDUP_TTL;
    const dedup =
      event.dedupKey !== undefined ? `dedup:${event.triggerId}:${event.dedupKey}` : undefined;
    if (dedup !== undefined && !(await this.store.claimKey(dedup, dedupTtl))) {
      return this.result(event, routine.id, 'duplicate', {
        reason: 'The event was delivered before',
      });
    }
    const runId = routineRunId(event.triggerId, key);
    const runTtl = dedup !== undefined ? dedupTtl : RUN_CLAIM_TTL;
    let claimed: boolean;
    try {
      claimed = await this.store.claimKey(`run:${runId}`, runTtl);
    } catch (error) {
      if (dedup !== undefined) await this.store.releaseKey(dedup).catch(() => undefined);
      throw error;
    }
    if (!claimed) {
      return this.result(event, routine.id, 'duplicate', {
        runId,
        reason: 'The firing started a run before',
      });
    }
    try {
      return await this.admit(registered, event, runId, dedup);
    } catch (error) {
      if (dedup !== undefined) await this.store.releaseKey(dedup);
      await this.store.releaseKey(`run:${runId}`);
      throw error;
    } finally {
      await this.bumpState(event);
    }
  }

  private async bumpState(event: TriggerEvent): Promise<void> {
    const split = splitTriggerId(event.triggerId);
    if (!split) return;
    try {
      await this.patchState(split.routineId, split.triggerId, {
        fireCountDelta: 1,
        lastFiredAt: event.occurredAt,
      });
    } catch (error) {
      this.report({ type: 'error', error: errorText(error), routineId: split.routineId });
    }
  }

  private async admit(
    registered: Registered,
    event: TriggerEvent,
    runId: string,
    dedup: string | undefined
  ): Promise<TriggerFireResult> {
    const { routine } = registered;
    const overlap = routine.overlap ?? 'skip';
    const max = routine.maxConcurrent ?? (overlap === 'parallel' ? Infinity : 1);
    const live = this.liveOf(routine.id);
    const base: RoutineRunRecord = {
      id: event.id,
      routineId: routine.id,
      triggerId: event.triggerId,
      source: event.source,
      at: event.occurredAt,
      ...(event.scheduledFor !== undefined && { scheduledFor: event.scheduledFor }),
      status: 'started',
    };
    const skip = async (reason: string): Promise<TriggerFireResult> => {
      await this.record({ ...base, status: 'skipped', reason });
      this.report({ type: 'fired', event, status: 'skipped', reason });
      return this.result(event, routine.id, 'skipped', { reason });
    };
    const going = live.runs.size + live.starting;
    if (going >= max) {
      if (overlap === 'skip' || overlap === 'parallel') {
        return skip(`${going} run(s) of the routine going on, at most ${max}`);
      }
      if (overlap === 'queue') {
        if (routine.session !== undefined && routine.session !== 'new') {
          const going = [...live.runs.values()].find(
            (run) => run.threadId === (routine.session as { threadId: string }).threadId
          );
          if (going?.handle?.followUp(experimental_routineInput(routine, event))) {
            await this.record({
              ...base,
              status: 'queued',
              runId: going.runId,
              threadId: going.threadId,
              reason: 'given to the run going on as a follow-up',
            });
            this.report({ type: 'fired', event, status: 'queued', runId: going.runId });
            return this.result(event, routine.id, 'queued', {
              runId: going.runId,
              threadId: going.threadId,
            });
          }
        }
        if (live.queue.length >= (this.config.maxQueued ?? 10)) {
          return skip(`the queue of the routine is full (${live.queue.length})`);
        }
        live.queue.push({ event, runId, ...(dedup !== undefined && { dedup }) });
        await this.record({ ...base, status: 'queued', runId });
        this.report({ type: 'fired', event, status: 'queued', runId });
        return this.result(event, routine.id, 'queued', { runId });
      }
      const oldest = [...live.runs.values()]
        .filter((run) => run.handle !== undefined || run.abort !== undefined)
        .sort((a, b) => a.startedAt - b.startedAt)[0];
      if (!oldest) return skip('the runs of the routine going on cannot be aborted');
      this.abortRun(routine.id, live, oldest, `replaced by ${event.id}`);
    }
    return this.launch(registered, event, runId);
  }

  /**
   * Aborts a run for `overlap: 'replace'`: it is recorded as replaced, whatever it ends with, and
   * no longer counts against `maxConcurrent`
   */
  private abortRun(routineId: string, live: RoutineLive, run: LiveRun, reason: string): void {
    this.replaced.add(run.runId);
    live.runs.delete(run.runId);
    run.handle?.abort(new Error(reason));
    run.abort?.abort(new Error(reason));
    void this.record({
      id: run.eventId,
      routineId,
      triggerId: run.triggerId,
      source: run.source,
      at: run.startedAt,
      status: 'replaced',
      runId: run.runId,
      threadId: run.threadId,
      reason,
      finishedAt: Date.now(),
    });
  }

  private threadOf(routine: RoutineDefinition, runId: string): string {
    return routine.session !== undefined && routine.session !== 'new'
      ? routine.session.threadId
      : `routine_${idPart(routine.id)}_${runId.slice(RUN_ID_PREFIX.length)}`;
  }

  private agentOf(routine: RoutineDefinition): Agent | undefined {
    if (!('agent' in routine.target)) return undefined;
    const target = routine.target.agent;
    return typeof target === 'string' ? this.config.agents?.[target] : target;
  }

  private workflowOf(routine: RoutineDefinition): RoutineWorkflow | undefined {
    if (!('workflow' in routine.target)) return undefined;
    const target = routine.target.workflow;
    return typeof target === 'string' ? this.config.workflows?.[target] : target;
  }

  /** Starts the run of a firing the overlap rules admitted */
  private async launch(
    registered: Registered,
    event: TriggerEvent,
    runId: string
  ): Promise<TriggerFireResult> {
    const { routine } = registered;
    const agent = this.agentOf(routine);
    const workflow = this.workflowOf(routine);
    if (!agent && !workflow) {
      const name =
        'agent' in routine.target
          ? `agent ${String(routine.target.agent)}`
          : `workflow ${String((routine.target as { workflow: unknown }).workflow)}`;
      throw configurationError(
        `Routine ${routine.id} runs ${name}, which is not in experimental_triggers`
      );
    }
    const threadId = this.threadOf(routine, runId);
    const input = experimental_routineInput(routine, event);
    const run: LiveRun = {
      runId,
      eventId: event.id,
      triggerId: event.triggerId,
      source: event.source,
      threadId,
      startedAt: Date.now(),
    };
    const lease = this.runtime.plugins?.lease();
    const record: RoutineRunRecord = {
      id: event.id,
      routineId: routine.id,
      triggerId: event.triggerId,
      source: event.source,
      at: event.occurredAt,
      ...(event.scheduledFor !== undefined && { scheduledFor: event.scheduledFor }),
      status: 'started',
      runId,
      threadId,
    };
    let finished: Promise<Outcome>;
    try {
      if (agent) {
        const handle = this.runtime.start(agent, {
          input,
          threadId,
          runId,
          ...(routine.userId !== undefined && { userId: routine.userId }),
          durable: this.durable,
          inputMetadata: { trigger: event, routine: routine.id },
        });
        run.handle = handle;
        finished = settle(handle.result);
      } else {
        const controller = new AbortController();
        run.abort = controller;
        finished = workflow!
          .run({ routine, event, input, runId, signal: controller.signal, inbox: this.inbox })
          .then(
            (outcome): Outcome => ({ kind: 'workflow', outcome }),
            (error: unknown): Outcome => ({ kind: 'error', error })
          );
      }
    } catch (error) {
      lease?.release();
      throw error;
    }
    this.liveOf(routine.id).runs.set(runId, run);
    await this.record(record);
    this.report({ type: 'fired', event, status: 'started', runId });
    await this.follow(registered, event, run, record, finished, lease, agent !== undefined);
    return this.result(event, routine.id, 'started', { runId, threadId });
  }

  /**
   * Follows a run of a routine in the background: it counts against `maxConcurrent` while it
   * goes on, a durable agent run is kept for `recover`, and once it ends its outcome is written
   * down and the next queued firing may start
   */
  private async follow(
    registered: Registered,
    event: TriggerEvent,
    run: LiveRun,
    record: RoutineRunRecord,
    finished: Promise<Outcome>,
    lease: PluginLease | undefined,
    recoverable: boolean
  ): Promise<void> {
    const { routine } = registered;
    const live = this.liveOf(routine.id);
    live.runs.set(run.runId, run);
    const kept = recoverable && this.durable;
    if (kept) {
      await this.saveActive({
        runId: run.runId,
        kind: 'routine',
        eventId: event.id,
        triggerId: event.triggerId,
        routineId: routine.id,
        source: event.source,
        at: record.at,
        ...(event.scheduledFor !== undefined && { scheduledFor: event.scheduledFor }),
        threadId: run.threadId,
        ...(routine.userId !== undefined && { userId: routine.userId }),
      });
    }
    let ended: Outcome | undefined;
    this.track(
      finished
        .then((outcome) => {
          ended = outcome;
          return this.finish(registered, event, run, record, outcome);
        })
        .finally(async () => {
          lease?.release();
          this.replaced.delete(run.runId);
          if (live.runs.get(run.runId) === run) live.runs.delete(run.runId);
          if (kept && !(ended && handedOver(ended))) await this.dropActive(run.runId);
          this.next(registered);
        })
    );
  }

  /** Starts the next queued firing of a routine, when one waits and a run may start */
  private next(registered: Registered): void {
    const live = this.live.get(registered.routine.id);
    if (!live || live.queue.length === 0 || this.stopped) return;
    const max = registered.routine.maxConcurrent ?? 1;
    if (live.runs.size + live.starting >= max) return;
    const waiting = live.queue.shift()!;
    live.starting++;
    let holding = true;
    const release = (): void => {
      if (!holding) return;
      holding = false;
      live.starting--;
    };
    this.track(
      this.find(registered.routine.id)
        .then((fresh) => {
          release();
          return fresh ? this.launch(fresh, waiting.event, waiting.runId) : undefined;
        })
        .finally(release)
    );
  }

  private async finish(
    registered: Registered,
    event: TriggerEvent,
    run: LiveRun,
    record: RoutineRunRecord,
    outcome: Outcome
  ): Promise<void> {
    const { routine } = registered;
    const name = routine.name ?? routine.id;
    const finishedAt = Date.now();
    if (outcome.kind === 'error' && isRunLeased(outcome.error)) {
      await this.record({
        ...record,
        status: 'skipped',
        reason: 'another process holds the run',
        finishedAt,
      });
      return;
    }
    if (outcome.kind === 'error' && isRunSuspended(outcome.error)) {
      this.report({
        type: 'error',
        error: `Run ${run.runId} was suspended, it goes on when a runtime recovers it: ${errorText(outcome.error)}`,
        routineId: routine.id,
      });
      return;
    }
    if (this.replaced.has(run.runId)) return;
    const common = {
      routineId: routine.id,
      triggerId: event.triggerId,
      triggerEventId: event.id,
      source: event.source,
      runId: run.runId,
      threadId: run.threadId,
      ...(routine.userId !== undefined && { userId: routine.userId }),
      ...(routine.owner !== undefined && { metadata: { owner: { ...routine.owner } } }),
    };
    let status: RoutineRunStatus;
    let item: InboxItemInput | undefined;
    let notification: RunNotification | undefined;
    if (outcome.kind === 'error') {
      const message = errorText(outcome.error);
      status = 'failed';
      await this.record({ ...record, status, reason: message, finishedAt });
      if (routine.notify?.failure !== false) {
        item = {
          ...common,
          kind: 'failure',
          title: `${name} failed`,
          summary: summaryOf(message),
          body: message,
        };
        notification = { type: 'routine_failed', title: `${name} failed`, message };
      }
    } else if (outcome.kind === 'agent') {
      const result = outcome.result;
      if (result.status === 'paused') {
        status = 'paused';
        await this.record({ ...record, status, finishedAt });
        item = waitingItem(
          result,
          name,
          common,
          routine.owner !== undefined ? { owner: { ...routine.owner } } : {}
        );
      } else {
        status = 'completed';
        await this.record({ ...record, status, finishedAt });
        if (routine.notify?.result !== false) {
          item = {
            ...common,
            kind: 'result',
            title: name,
            summary: summaryOf(result.output || 'The run finished without an answer'),
            ...(result.output.length > MAX_SUMMARY && { body: result.output }),
          };
          notification = { type: 'routine_result', title: name, message: summaryOf(result.output) };
        }
      }
    } else {
      const { outcome: done } = outcome;
      const workflowRun =
        done.workflowRunId !== undefined ? { workflowRunId: done.workflowRunId } : {};
      if (done.status === 'waiting') {
        status = 'paused';
        await this.record({ ...record, ...workflowRun, status, finishedAt });
      } else if (done.status === 'failed') {
        status = 'failed';
        const message = done.error ?? 'The workflow failed';
        await this.record({ ...record, ...workflowRun, status, reason: message, finishedAt });
        if (routine.notify?.failure !== false) {
          item = {
            ...common,
            ...workflowRun,
            kind: 'failure',
            title: `${name} failed`,
            summary: summaryOf(message),
            body: message,
          };
          notification = { type: 'routine_failed', title: `${name} failed`, message };
        }
      } else {
        status = 'completed';
        await this.record({ ...record, ...workflowRun, status, finishedAt });
        const output = done.output ?? '';
        if (routine.notify?.result !== false) {
          item = {
            ...common,
            ...workflowRun,
            kind: 'result',
            title: name,
            summary: summaryOf(output || 'The workflow finished'),
            ...(output.length > MAX_SUMMARY && { body: output }),
          };
          notification = {
            type: 'routine_result',
            title: name,
            message: summaryOf(output || 'The workflow finished'),
          };
        }
      }
    }
    this.report({ type: 'completed', routineId: routine.id, runId: run.runId, status });
    if (item) await this.addToInbox(item);
    const agent = this.agentOf(routine);
    if (notification) {
      try {
        await this.runtime.notify(notification, {
          ...(agent && { agent }),
          routineId: routine.id,
          routineName: name,
          runId: run.runId,
          threadId: run.threadId,
          ...(routine.userId !== undefined && { userId: routine.userId }),
        });
      } catch (error) {
        this.report({
          type: 'error',
          error: `Notification hooks failed: ${errorText(error)}`,
          routineId: routine.id,
        });
      }
    }
  }

  private async addToInbox(item: InboxItemInput): Promise<InboxItem | undefined> {
    try {
      const added = await this.inbox.add(item);
      this.report({ type: 'inbox', item: added });
      return added;
    } catch (error) {
      this.report({
        type: 'error',
        error: `Could not add to the inbox: ${errorText(error)}`,
        ...(item.routineId !== undefined && { routineId: item.routineId }),
      });
      return undefined;
    }
  }

  /**
   * Answers a run that waits for a person, from its inbox item: `decisions` for approvals (by
   * tool call id), `responses` for questions (by interrupt id). The run of a routine, or of a task
   * an agent gave itself, goes on and its outcome reaches the inbox. The item is claimed as
   * answered in one step of the inbox store, so two answers at once resume the run once
   *
   * @throws CogitatorError `INBOX_ITEM_ANSWERED` when the item was answered already,
   * `TRIGGER_NOT_FOUND` when it waits for nothing or its routine or agent is gone
   */
  async respond(itemId: string, answer: RoutineAnswer): Promise<TriggerFireResult> {
    const item = await this.inbox.get(itemId);
    if (!item || (item.kind !== 'approval' && item.kind !== 'question') || !item.runId) {
      throw notFound(`No inbox item ${itemId} that waits for an answer`);
    }
    if (item.answeredAt !== undefined) throw answeredAlready(itemId);
    if (item.approvalId !== undefined && item.threadId === undefined) {
      return this.respondToWorkflow(item, answer);
    }
    const threadId = item.threadId;
    if (!threadId) throw notFound(`No inbox item ${itemId} that waits for an answer`);
    const taskAgent =
      item.source === 'agent' && typeof item.metadata?.agent === 'string'
        ? item.metadata.agent
        : undefined;
    if (taskAgent !== undefined) return this.respondToTask(item, taskAgent, threadId, answer);
    const registered = item.routineId ? await this.find(item.routineId) : undefined;
    const agent = registered ? this.agentOf(registered.routine) : undefined;
    if (!registered || !agent) throw notFound(`The routine of inbox item ${itemId} is gone`);
    if (!(await this.inbox.claimAnswer(itemId))) throw answeredAlready(itemId);
    const event = experimental_createTriggerEvent({
      source: 'manual',
      triggerId: item.triggerId ?? fullTriggerId(registered.routine.id, 'manual'),
      routineId: registered.routine.id,
      verified: { method: 'manual', ok: true },
    });
    const controller = new AbortController();
    const run: LiveRun = {
      runId: item.runId,
      eventId: item.triggerEventId ?? event.id,
      triggerId: event.triggerId,
      source: item.source ?? 'manual',
      threadId,
      startedAt: Date.now(),
      abort: controller,
    };
    const record: RoutineRunRecord = {
      id: run.eventId,
      routineId: registered.routine.id,
      triggerId: run.triggerId,
      source: run.source,
      at: item.createdAt,
      status: 'started',
      runId: run.runId,
      threadId: run.threadId,
    };
    const taken = await this.takeUp(item.id, () =>
      this.runtime.resume(agent, threadId, run.runId, {
        ...resumeAnswer(answer),
        signal: controller.signal,
        durable: this.durable,
        ...(registered.routine.userId !== undefined && { userId: registered.routine.userId }),
      })
    );
    const lease = this.runtime.plugins?.lease();
    await this.follow(registered, event, run, record, settle(taken.result), lease, true);
    return this.result(event, registered.routine.id, 'started', {
      runId: run.runId,
      threadId: run.threadId,
    });
  }

  /**
   * Resumes the run of an inbox item whose answer was just claimed. When the run no longer waits
   * (another run of its thread paused since, or nothing waits there), the item stays answered and
   * the call throws `INBOX_ITEM_ANSWERED`. Any other failure before the run goes on gives the
   * answer back, so the item can be answered again
   */
  private async takeUp(
    itemId: string,
    resume: () => Promise<{ result: Promise<RunResult> }>
  ): Promise<{ result: Promise<RunResult> }> {
    try {
      return await resume();
    } catch (error) {
      const gone =
        CogitatorError.isCogitatorError(error) &&
        (error.code === ErrorCode.RUN_NOT_FOUND || error.code === ErrorCode.RUN_NOT_PAUSED);
      if (gone) {
        throw new CogitatorError({
          message: `The run of inbox item ${itemId} no longer waits for an answer`,
          code: ErrorCode.INBOX_ITEM_ANSWERED,
          cause: error instanceof Error ? error : new Error(String(error)),
        });
      }
      await this.inbox.releaseAnswer(itemId);
      throw error;
    }
  }

  /** Answers a task an agent gave itself whose run waits for a person: its agent resumes it */
  private async respondToTask(
    item: InboxItem,
    agentName: string,
    threadId: string,
    answer: RoutineAnswer
  ): Promise<TriggerFireResult> {
    const agent = this.config.agents?.[agentName];
    if (!agent || item.runId === undefined) {
      throw notFound(`The agent ${agentName} of inbox item ${item.id} is gone`);
    }
    if (!(await this.inbox.claimAnswer(item.id))) throw answeredAlready(item.id);
    const meta = item.metadata ?? {};
    const taskId = typeof meta.taskId === 'string' ? meta.taskId : item.runId;
    const task: ActiveRoutineRun = {
      runId: item.runId,
      kind: 'task',
      eventId: item.triggerEventId ?? item.id,
      triggerId: taskId,
      source: 'agent',
      at: item.createdAt,
      threadId,
      agent: agentName,
      description: typeof meta.description === 'string' ? meta.description : '',
      ...(item.userId !== undefined && { userId: item.userId }),
    };
    const taken = await this.takeUp(item.id, () =>
      this.runtime.resume(agent, threadId, task.runId, {
        ...resumeAnswer(answer),
        durable: this.durable,
        ...(item.userId !== undefined && { userId: item.userId }),
      })
    );
    await this.followTask(task, taken.result);
    return {
      type: 'routine_fire',
      status: 'started',
      eventId: task.eventId,
      triggerId: taskId,
      runId: item.runId,
      threadId,
    };
  }

  /** Answers an approval a routine's workflow waits on, through its `respond` */
  private async respondToWorkflow(
    item: InboxItem,
    answer: RoutineAnswer
  ): Promise<TriggerFireResult> {
    const registered = item.routineId ? await this.find(item.routineId) : undefined;
    const workflow = registered ? this.workflowOf(registered.routine) : undefined;
    if (!registered || !workflow?.respond || item.approvalId === undefined) {
      throw notFound(`The workflow of inbox item ${item.id} cannot be answered`);
    }
    const decision =
      answer.decision ??
      answer.decisions?.[item.approvalId]?.approved ??
      answer.defaultDecision?.approved;
    if (decision === undefined) {
      throw new CogitatorError({
        message: `Inbox item ${item.id} needs a decision`,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    if (!(await this.inbox.claimAnswer(item.id))) throw answeredAlready(item.id);
    try {
      await workflow.respond(item.approvalId, decision, answer.respondedBy);
    } catch (error) {
      const answered =
        CogitatorError.isCogitatorError(error) && error.code === ErrorCode.INBOX_ITEM_ANSWERED;
      if (!answered) await this.inbox.releaseAnswer(item.id);
      throw error;
    }
    return {
      type: 'routine_fire',
      status: 'started',
      eventId: item.triggerEventId ?? item.id,
      routineId: registered.routine.id,
      triggerId: item.triggerId ?? fullTriggerId(registered.routine.id, 'manual'),
      ...(item.runId !== undefined && { runId: item.runId }),
    };
  }

  /** The history of firings, newest first */
  history(filter?: { routineId?: string; limit?: number }): Promise<RoutineRunRecord[]> {
    return this.store.listRuns(filter);
  }

  /**
   * Tools an agent schedules itself with (`schedule_task`, `list_tasks`, `cancel_task`), its tasks
   * kept in the schedules store and run by this manager on that agent, in the thread they were
   * given in. The agent must be in `experimental_triggers.agents` under `agent`
   */
  schedulerTools(
    agent: string,
    options: Omit<SchedulerToolsConfig, 'store' | 'agent' | 'cron'> = {}
  ) {
    if (!this.config.agents?.[agent]) {
      throw configurationError(
        `schedulerTools: agent ${agent} is not in experimental_triggers.agents`
      );
    }
    return createSchedulerTools({
      ...options,
      store: this.scheduler.store,
      agent,
      ...(this.cronEngine && { cron: this.cronEngine }),
    });
  }

  /**
   * Every agent a run of this manager may be on: those of `experimental_triggers.agents` and the
   * agents routines in code or of plugins name directly as their target
   */
  private async knownAgents(): Promise<Agent[]> {
    const found = new Set<Agent>(Object.values(this.config.agents ?? {}));
    for (const { routine } of await this.all()) {
      if ('agent' in routine.target && typeof routine.target.agent !== 'string') {
        found.add(routine.target.agent);
      }
    }
    return [...found];
  }

  /**
   * Continues the durable runs of routines and of tasks agents gave themselves that a stopped
   * process left, as the store kept them going on (not from the history, which drops old
   * records). Each takes a lease on the plugins, its outcome reaches the inbox
   */
  private async recover(): Promise<void> {
    if (!this.durable || !this.runtime.recoverRuns) return;
    const active = new Map((await this.store.listActiveRuns()).map((run) => [run.runId, run]));
    if (active.size === 0) return;
    const agents = await this.knownAgents();
    const recovered = await this.runtime.recoverRuns(
      (runId) => active.has(runId),
      (agentName, agentId) =>
        agents.find((agent) => agent.id === agentId) ??
        agents.find((agent) => agent.name === agentName)
    );
    for (const { runId, handle } of recovered) {
      const kept = active.get(runId);
      if (!kept) continue;
      if (kept.kind === 'task') {
        await this.followTask(kept, handle.result);
        continue;
      }
      const registered = kept.routineId ? await this.find(kept.routineId) : undefined;
      if (!registered) {
        this.report({
          type: 'error',
          error: `Run ${runId} of routine ${kept.routineId ?? '?'} came back, but the routine is gone`,
        });
        this.track(
          settle(handle.result).then((outcome) =>
            handedOver(outcome) ? undefined : this.dropActive(runId)
          )
        );
        continue;
      }
      const event = experimental_createTriggerEvent({
        id: kept.eventId,
        source: kept.source,
        triggerId: kept.triggerId,
        routineId: registered.routine.id,
        occurredAt: kept.at,
        ...(kept.scheduledFor !== undefined && { scheduledFor: kept.scheduledFor }),
        verified: { method: 'manual', ok: true },
      });
      const run: LiveRun = {
        runId,
        eventId: kept.eventId,
        triggerId: kept.triggerId,
        source: kept.source,
        threadId: kept.threadId,
        startedAt: Date.now(),
        handle,
      };
      const record: RoutineRunRecord = {
        id: kept.eventId,
        routineId: registered.routine.id,
        triggerId: kept.triggerId,
        source: kept.source,
        at: kept.at,
        ...(kept.scheduledFor !== undefined && { scheduledFor: kept.scheduledFor }),
        status: 'started',
        runId,
        threadId: kept.threadId,
      };
      await this.follow(
        registered,
        event,
        run,
        record,
        settle(handle.result),
        this.runtime.plugins?.lease(),
        true
      );
    }
  }
}

function answeredAlready(itemId: string): CogitatorError {
  return new CogitatorError({
    message: `Inbox item ${itemId} was answered already`,
    code: ErrorCode.INBOX_ITEM_ANSWERED,
  });
}

/** A run's result as an outcome, its failure too */
function settle(result: Promise<RunResult>): Promise<Outcome> {
  return result.then(
    (done): Outcome => ({ kind: 'agent', result: done }),
    (error: unknown): Outcome => ({ kind: 'error', error })
  );
}

/** What of an answer the runtime's `resume` takes */
function resumeAnswer(
  answer: RoutineAnswer
): Pick<ResumeOptions, 'decisions' | 'defaultDecision' | 'responses'> {
  return {
    ...(answer.decisions !== undefined && { decisions: answer.decisions }),
    ...(answer.defaultDecision !== undefined && { defaultDecision: answer.defaultDecision }),
    ...(answer.responses !== undefined && { responses: answer.responses }),
  };
}

/**
 * The inbox item of a run that waits for a person: an `approval` with Approve and Reject for each
 * tool call it holds, else a `question` with its interrupts, `metadata` kept with them
 */
function waitingItem(
  result: RunResult,
  name: string,
  common: Omit<InboxItemInput, 'kind' | 'title' | 'summary'>,
  metadata: Record<string, unknown>
): InboxItemInput {
  const approvals = result.pendingApprovals ?? [];
  const questions = (result.interrupts ?? []).filter((interrupt) => interrupt.kind !== 'approval');
  return {
    ...common,
    kind: approvals.length > 0 ? 'approval' : 'question',
    title: approvals.length > 0 ? `${name} needs approval` : `${name} has a question`,
    summary: summaryOf(
      [
        ...approvals.map((approval) => `${approval.toolName}: ${approval.description}`),
        ...questions.map((question) => question.message),
      ].join('\n') || 'The run waits for a person'
    ),
    actions: approvals.flatMap((approval) => [
      {
        id: `approve:${approval.toolCallId}`,
        label: 'Approve',
        kind: 'approve' as const,
        approvalId: approval.toolCallId,
      },
      {
        id: `reject:${approval.toolCallId}`,
        label: 'Reject',
        kind: 'reject' as const,
        approvalId: approval.toolCallId,
      },
    ]),
    metadata: {
      ...metadata,
      interrupts: (result.interrupts ?? []).map((interrupt) => ({
        id: interrupt.id,
        kind: interrupt.kind,
        message: interrupt.message,
        ...(interrupt.toolName !== undefined && { toolName: interrupt.toolName }),
      })),
    },
  };
}

/**
 * An answer to a routine that waits for a person: `decisions` for an agent's approvals (by tool
 * call id), `responses` for its questions (by interrupt id), `decision` for a workflow's approval
 */
export interface RoutineAnswer extends Pick<
  ResumeOptions,
  'decisions' | 'defaultDecision' | 'responses'
> {
  decision?: unknown;
  /** Who answers, for a workflow's approval */
  respondedBy?: string;
}

/** How a run of a routine ended, before it is written down */
type Outcome =
  | { kind: 'agent'; result: RunResult }
  | { kind: 'workflow'; outcome: RoutineWorkflowOutcome }
  | { kind: 'error'; error: unknown };
