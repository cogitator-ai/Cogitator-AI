/**
 * The trigger manager: routines and what starts them. A firing becomes an event, the event
 * starts a session exactly once (a claim in the store, a run id made from the event, a durable
 * run that a second start finds held), and what the session comes to lands in the inbox
 */

import { createHash } from 'node:crypto';
import type {
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
import { experimental_Scheduler, type ScheduledFire } from './scheduler';
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
  resume(agent: Agent, threadId: string, options: ResumeOptions): Promise<RunResult>;
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
}

interface RoutineLive {
  runs: Map<string, LiveRun>;
  queue: PendingFiring[];
}

/** Firings a routine run id is made of: its trigger and what tells the event apart */
const RUN_ID_PREFIX = 'trg_';
const DEFAULT_DEDUP_TTL = 24 * 60 * 60 * 1000;
const DEFAULT_CATCH_UP_WINDOW = 7 * 24 * 60 * 60 * 1000;
/** How long the claim on a firing's run id is kept: longer than a provider retries */
const RUN_CLAIM_TTL = 3 * 24 * 60 * 60 * 1000;
const SCHEDULE_INIT_TTL = 30_000;
const HOUR = 60 * 60 * 1000;
const MAX_SUMMARY = 300;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function idPart(text: string): string {
  return text.replace(/[^A-Za-z0-9_.-]/g, '-');
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function isRunLeased(error: unknown): boolean {
  return CogitatorError.isCogitatorError(error) && error.code === ErrorCode.RUN_LEASED;
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
    if (this.runtime.plugins) {
      this.unsubscribePlugins = this.runtime.plugins.onChange(() => {
        this.track(this.syncPlugins());
      });
      await this.syncPlugins();
    }
    for (const registered of await this.all()) await this.syncSchedules(registered);
    await this.scheduler.start();
    await this.recover();
  }

  /**
   * Stops polling the schedules. Runs going on are left to finish, their results still reach the
   * inbox. Resolves once the poll going on and the work it started are done
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribePlugins?.();
    this.unsubscribePlugins = undefined;
    await this.scheduler.stop();
    this.started = undefined;
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
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
      live = { runs: new Map(), queue: [] };
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
      if (!(await this.store.claimKey(lock, SCHEDULE_INIT_TTL))) continue;
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
        await this.store.saveTriggerState({ ...fresh, scheduleId: added.id });
        kept.push(added.id);
      } finally {
        await this.store.releaseKey(lock);
      }
    }
    await this.dropSchedules(routine.id, kept);
  }

  /** Cancels the pending schedule entries of a routine but those in `keep` */
  private async dropSchedules(routineId: string, keep: readonly string[]): Promise<void> {
    for (const entry of await this.scheduler.store.getPending()) {
      if (entry.trigger?.routineId === routineId && !keep.includes(entry.id)) {
        await this.scheduler.remove(entry.id);
      }
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
      const state = await this.state(routineId, triggerId);
      await this.store.saveTriggerState({ ...state, enabled });
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
    const state = await this.state(registered.routine.id, triggerIdOf(spec));
    const hint = token.slice(-4);
    await this.store.saveTriggerState({
      ...state,
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
    if (!this.enabled(routine, spec, state)) {
      return {
        status: 409,
        body: { error: { code: 'TRIGGER_DISABLED', message: `Trigger ${id} is paused` } },
      };
    }
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
    try {
      const result = await this.dispatch(registered, outcome.event, this.eventKey(outcome.event));
      const status = result.status === 'duplicate' ? 200 : spec.kind === 'slack' ? 200 : 202;
      return { status, body: result };
    } catch (error) {
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
    return event.dedupKey !== undefined ? digest(event.dedupKey) : idPart(event.id);
  }

  private async fireScheduled(fire: ScheduledFire): Promise<void> {
    const { entry, occurrence } = fire;
    const trigger = entry.trigger;
    if (!trigger) return;
    if (trigger.agent !== undefined) {
      await this.fireAgentTask(entry, occurrence);
      return;
    }
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
      return;
    }
    const state = await this.state(routineId, triggerId);
    if (!this.enabled(registered.routine, spec, state)) return;
    const event = experimental_createTriggerEvent({
      source: 'cron',
      triggerId: fullTriggerId(routineId, triggerId),
      routineId,
      scheduledFor: occurrence,
      verified: { method: 'schedule', ok: true },
    });
    await this.dispatch(registered, event, String(occurrence));
  }

  /** A task an agent gave itself came due: its agent continues the thread it was given in */
  private async fireAgentTask(entry: TimerEntry, occurrence: number): Promise<void> {
    const name = entry.trigger?.agent ?? '';
    const agent = this.config.agents?.[name];
    if (!agent) {
      throw configurationError(
        `Task ${entry.id} runs on agent ${name}, which is not in experimental_triggers.agents`
      );
    }
    const meta = entry.metadata ?? {};
    const description =
      typeof meta.description === 'string' ? meta.description : (entry.name ?? '');
    const runId = `${RUN_ID_PREFIX}${idPart(entry.id)}_${occurrence}`;
    if (!(await this.store.claimKey(`run:${runId}`, RUN_CLAIM_TTL))) return;
    const threadId = typeof meta.threadId === 'string' ? meta.threadId : `task_${idPart(entry.id)}`;
    const userId = typeof meta.userId === 'string' ? meta.userId : undefined;
    const event = experimental_createTriggerEvent({
      source: 'agent',
      triggerId: entry.id,
      scheduledFor: occurrence,
      verified: { method: 'agent', ok: true },
      text: description,
    });
    const handle = this.runtime.start(agent, {
      input: experimental_agentTaskInput(event),
      threadId,
      runId,
      ...(userId !== undefined && { userId }),
      ...(this.durable && { durable: true }),
      inputMetadata: { trigger: event },
    });
    this.track(
      handle.result.then(
        async (result) => {
          await this.addToInbox({
            kind: result.status === 'paused' ? 'question' : 'result',
            title: `Scheduled task: ${description}`,
            summary: summaryOf(result.output),
            ...(result.output.length > MAX_SUMMARY && { body: result.output }),
            source: 'agent',
            runId,
            threadId,
            triggerEventId: event.id,
            ...(userId !== undefined && { userId }),
          });
        },
        async (error: unknown) => {
          if (isRunLeased(error)) return;
          await this.addToInbox({
            kind: 'failure',
            title: `Scheduled task failed: ${description}`,
            summary: errorText(error),
            source: 'agent',
            runId,
            threadId,
            triggerEventId: event.id,
            ...(userId !== undefined && { userId }),
          });
        }
      )
    );
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
    const runId = `${RUN_ID_PREFIX}${idPart(event.triggerId)}_${key}`;
    if (!(await this.store.claimKey(`run:${runId}`, RUN_CLAIM_TTL))) {
      return this.result(event, routine.id, 'duplicate', {
        runId,
        reason: 'The firing started a run before',
      });
    }
    try {
      return await this.admit(registered, event, runId);
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
      const state = await this.state(split.routineId, split.triggerId);
      await this.store.saveTriggerState({
        ...state,
        fireCount: state.fireCount + 1,
        lastFiredAt: event.occurredAt,
      });
    } catch (error) {
      this.report({ type: 'error', error: errorText(error), routineId: split.routineId });
    }
  }

  private async admit(
    registered: Registered,
    event: TriggerEvent,
    runId: string
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
    if (live.runs.size >= max) {
      if (overlap === 'skip' || overlap === 'parallel') {
        return skip(`${live.runs.size} run(s) of the routine going on, at most ${max}`);
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
        live.queue.push({ event, runId });
        await this.record({ ...base, status: 'queued', runId });
        this.report({ type: 'fired', event, status: 'queued', runId });
        return this.result(event, routine.id, 'queued', { runId });
      }
      const oldest = [...live.runs.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
      if (oldest) this.abortRun(routine.id, oldest, `replaced by ${event.id}`);
    }
    return this.launch(registered, event, runId);
  }

  private abortRun(routineId: string, run: LiveRun, reason: string): void {
    this.replaced.add(run.runId);
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
    const live = this.liveOf(routine.id);
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
          ...(this.durable && { durable: true }),
          inputMetadata: { trigger: event, routine: routine.id },
        });
        run.handle = handle;
        finished = handle.result.then(
          (result): Outcome => ({ kind: 'agent', result }),
          (error: unknown): Outcome => ({ kind: 'error', error })
        );
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
    live.runs.set(runId, run);
    await this.record(record);
    this.report({ type: 'fired', event, status: 'started', runId });
    this.track(
      finished
        .then((outcome) => this.finish(registered, event, run, record, outcome))
        .finally(() => {
          lease?.release();
          live.runs.delete(runId);
          this.next(registered);
        })
    );
    return this.result(event, routine.id, 'started', { runId, threadId });
  }

  /** Starts the next queued firing of a routine, when one waits and a run may start */
  private next(registered: Registered): void {
    const live = this.live.get(registered.routine.id);
    if (!live || live.queue.length === 0 || this.stopped) return;
    const max = registered.routine.maxConcurrent ?? 1;
    if (live.runs.size >= max) return;
    const waiting = live.queue.shift()!;
    this.track(
      this.find(registered.routine.id).then((fresh) =>
        fresh ? this.launch(fresh, waiting.event, waiting.runId) : undefined
      )
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
      if (isRunLeased(outcome.error)) {
        await this.record({
          ...record,
          status: 'skipped',
          reason: 'another process holds the run',
          finishedAt,
        });
        return;
      }
      if (this.replaced.delete(run.runId)) return;
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
        const approvals = result.pendingApprovals ?? [];
        const questions = (result.interrupts ?? []).filter(
          (interrupt) => interrupt.kind !== 'approval'
        );
        item = {
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
            ...(routine.owner !== undefined && { owner: { ...routine.owner } }),
            interrupts: (result.interrupts ?? []).map((interrupt) => ({
              id: interrupt.id,
              kind: interrupt.kind,
              message: interrupt.message,
              ...(interrupt.toolName !== undefined && { toolName: interrupt.toolName }),
            })),
          },
        };
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
   * Answers a routine run that waits for a person, from its inbox item: `decisions` for approvals
   * (by tool call id), `responses` for questions (by interrupt id). The run goes on and its
   * outcome reaches the inbox; the item is archived
   */
  async respond(itemId: string, answer: RoutineAnswer): Promise<TriggerFireResult> {
    const item = await this.inbox.get(itemId);
    if (!item || (item.kind !== 'approval' && item.kind !== 'question') || !item.runId) {
      throw notFound(`No inbox item ${itemId} that waits for an answer`);
    }
    if (item.status === 'archived') {
      throw new CogitatorError({
        message: `Inbox item ${itemId} was answered or archived already`,
        code: ErrorCode.INBOX_ITEM_ANSWERED,
      });
    }
    if (item.approvalId !== undefined && item.threadId === undefined) {
      return this.respondToWorkflow(item, answer);
    }
    const threadId = item.threadId;
    if (!threadId) throw notFound(`No inbox item ${itemId} that waits for an answer`);
    const registered = item.routineId ? await this.find(item.routineId) : undefined;
    const agent = registered ? this.agentOf(registered.routine) : undefined;
    if (!registered || !agent) throw notFound(`The routine of inbox item ${itemId} is gone`);
    await this.inbox.archive(itemId);
    const event = experimental_createTriggerEvent({
      source: 'manual',
      triggerId: item.triggerId ?? fullTriggerId(registered.routine.id, 'manual'),
      routineId: registered.routine.id,
      verified: { method: 'manual', ok: true },
    });
    const run: LiveRun = {
      runId: item.runId,
      eventId: item.triggerEventId ?? event.id,
      triggerId: event.triggerId,
      source: item.source ?? 'manual',
      threadId,
      startedAt: Date.now(),
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
    const live = this.liveOf(registered.routine.id);
    live.runs.set(run.runId, run);
    const lease = this.runtime.plugins?.lease();
    this.track(
      this.runtime
        .resume(agent, threadId, {
          ...(answer.decisions !== undefined && { decisions: answer.decisions }),
          ...(answer.defaultDecision !== undefined && { defaultDecision: answer.defaultDecision }),
          ...(answer.responses !== undefined && { responses: answer.responses }),
          ...(registered.routine.userId !== undefined && { userId: registered.routine.userId }),
        })
        .then(
          (result): Outcome => ({ kind: 'agent', result }),
          (error: unknown): Outcome => ({ kind: 'error', error })
        )
        .then((outcome) => this.finish(registered, event, run, record, outcome))
        .finally(() => {
          lease?.release();
          live.runs.delete(run.runId);
        })
    );
    return this.result(event, registered.routine.id, 'started', {
      runId: run.runId,
      threadId: run.threadId,
    });
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
    await workflow.respond(item.approvalId, decision, answer.respondedBy);
    await this.inbox.archive(item.id);
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

  /** Continues the durable runs of routines a stopped process left, their outcome to the inbox */
  private async recover(): Promise<void> {
    if (!this.durable || !this.runtime.recoverRuns) return;
    const agents = this.config.agents ?? {};
    const recovered = await this.runtime.recoverRuns(
      (runId) => runId.startsWith(RUN_ID_PREFIX),
      (agentName, agentId) =>
        Object.values(agents).find((agent) => agent.id === agentId) ??
        Object.values(agents).find((agent) => agent.name === agentName)
    );
    for (const { runId, handle } of recovered) {
      const record = (await this.store.listRuns({ limit: 500 })).find((run) => run.runId === runId);
      const registered = record ? await this.find(record.routineId) : undefined;
      if (!record || !registered) continue;
      const event = experimental_createTriggerEvent({
        id: record.id,
        source: record.source,
        triggerId: record.triggerId,
        routineId: record.routineId,
        occurredAt: record.at,
        verified: { method: 'manual', ok: true },
      });
      const run: LiveRun = {
        runId,
        eventId: record.id,
        triggerId: record.triggerId,
        source: record.source,
        threadId: record.threadId ?? this.threadOf(registered.routine, runId),
        startedAt: Date.now(),
        handle,
      };
      const live = this.liveOf(registered.routine.id);
      live.runs.set(runId, run);
      this.track(
        handle.result
          .then(
            (result): Outcome => ({ kind: 'agent', result }),
            (error: unknown): Outcome => ({ kind: 'error', error })
          )
          .then((outcome) => this.finish(registered, event, run, record, outcome))
          .finally(() => live.runs.delete(runId))
      );
    }
  }
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
