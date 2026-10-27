import type { Cogitator, experimental_TriggerManager, RoutineAnswer } from '@cogitator-ai/core';
import type {
  InboxItem,
  InboxItemStatus,
  RoutineInfo,
  TimerEntry,
  ToolApprovalDecision,
  TriggerFireResult,
  TriggerInfo,
} from '@cogitator-ai/types';
import {
  INBOX_UNREAD_CAP,
  type ApprovalOutcome,
  type InboxAnswer,
  type InboxChangeRecord,
  type InboxDecision,
  type InboxListing,
  type InboxQuery,
  type RoutineRecord,
  type ScheduleRecord,
  type TriggerRecord,
  type TriggersState,
} from '../protocol.js';

/** A trigger or inbox request the host refuses, with the code the server answers it by. */
export class TriggerRefusal extends Error {
  constructor(
    message: string,
    readonly code:
      | 'TRIGGERS_NOT_CONFIGURED'
      | 'TRIGGERS_NOT_STARTED'
      | 'TRIGGER_NOT_FOUND'
      | 'SCHEDULE_NOT_FOUND'
      | 'SCHEDULE_PAUSED'
      | 'INBOX_ITEM_NOT_FOUND'
      | 'VALIDATION_ERROR'
  ) {
    super(message);
    this.name = 'TriggerRefusal';
  }
}

const MANAGER_METHODS = ['start', 'stop', 'list', 'history', 'fire', 'setEnabled', 'respond'];
const HISTORY_LIMIT = 50;
const DEFAULT_INBOX_LIMIT = 100;
/** How many waiting approvals `approve` looks through for the one it is asked about. */
const APPROVAL_SCAN = 1000;
const NOT_CONFIGURED =
  'The project configures no experimental_triggers, so its runtime has no routines, schedules or inbox';

/** Whether the runtime has a trigger manager: one without `experimental_triggers` has none. */
function isTriggerManager(value: unknown): value is experimental_TriggerManager {
  if (typeof value !== 'object' || value === null) return false;
  const manager = value as Record<string, unknown>;
  return (
    MANAGER_METHODS.every((name) => typeof manager[name] === 'function') &&
    typeof manager.scheduler === 'object' &&
    manager.scheduler !== null &&
    typeof manager.inbox === 'object' &&
    manager.inbox !== null
  );
}

/** `value` as plain JSON. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A refusal of the core as the studio's own: a missing routine, trigger or item (a 404 of the core)
 * by `notFound`, a bad request as `VALIDATION_ERROR`, anything else as it is.
 */
function refusalOf(error: unknown, notFound: TriggerRefusal['code']): unknown {
  if (!(error instanceof Error) || error instanceof TriggerRefusal) return error;
  const { statusCode, code } = error as Error & { statusCode?: unknown; code?: unknown };
  if (statusCode === 404 || code === 'TRIGGER_NOT_FOUND') {
    return new TriggerRefusal(error.message, notFound);
  }
  if (code === 'VALIDATION_ERROR') return new TriggerRefusal(error.message, 'VALIDATION_ERROR');
  return error;
}

function triggerRecord(info: TriggerInfo): TriggerRecord {
  const { state } = info;
  return {
    id: info.id,
    routineId: info.routineId,
    kind: info.kind,
    enabled: info.enabled,
    spec: plain(info.spec),
    fireCount: state.fireCount,
    ...(state.lastFiredAt !== undefined && { lastFiredAt: state.lastFiredAt }),
    ...(state.lastError !== undefined && { lastError: state.lastError }),
    ...(info.nextFireAt !== undefined && { nextFireAt: info.nextFireAt }),
    ...(info.scheduleId !== undefined && { scheduleId: info.scheduleId }),
  };
}

/** A routine as the schedules page shows it: its target named, its triggers without secrets. */
export function routineRecord(info: RoutineInfo): RoutineRecord {
  const { routine } = info;
  const target =
    'agent' in routine.target
      ? {
          kind: 'agent' as const,
          name:
            typeof routine.target.agent === 'string'
              ? routine.target.agent
              : routine.target.agent.name,
        }
      : {
          kind: 'workflow' as const,
          name:
            typeof routine.target.workflow === 'string'
              ? routine.target.workflow
              : routine.target.workflow.name,
        };
  const session = routine.session;
  return {
    id: routine.id,
    ...(routine.name !== undefined && { name: routine.name }),
    ...(routine.description !== undefined && { description: routine.description }),
    prompt: routine.prompt,
    target,
    enabled: routine.enabled !== false,
    overlap: routine.overlap ?? 'skip',
    ...(routine.maxConcurrent !== undefined && { maxConcurrent: routine.maxConcurrent }),
    session: session === undefined || session === 'new' ? 'new' : session.threadId,
    origin: info.origin,
    ...(info.plugin !== undefined && { plugin: info.plugin }),
    triggers: info.triggers.map(triggerRecord),
    active: info.active,
    queued: info.queued,
  };
}

/** A pending schedule entry the trigger manager runs, undefined for any other entry. */
export function scheduleRecord(entry: TimerEntry): ScheduleRecord | undefined {
  const trigger = entry.trigger;
  let owner: ScheduleRecord['owner'];
  if (trigger?.agent !== undefined) {
    const meta = entry.metadata ?? {};
    owner = {
      kind: 'agent',
      agent: trigger.agent,
      ...(typeof meta.description === 'string' && { description: meta.description }),
      ...(typeof meta.threadId === 'string' && { threadId: meta.threadId }),
    };
  } else if (trigger?.routineId !== undefined && trigger.triggerId !== undefined) {
    owner = { kind: 'routine', routineId: trigger.routineId, triggerId: trigger.triggerId };
  } else {
    return undefined;
  }
  return {
    id: entry.id,
    ...(entry.name !== undefined && { name: entry.name }),
    type: entry.type,
    ...(entry.cron !== undefined && { cron: entry.cron }),
    ...(entry.timezone !== undefined && { timezone: entry.timezone }),
    ...(entry.interval !== undefined && { interval: entry.interval }),
    firesAt: entry.firesAt,
    enabled: entry.enabled !== false,
    ...(entry.lastRunAt !== undefined && { lastRunAt: entry.lastRunAt }),
    ...(entry.lastRunStatus !== undefined && { lastRunStatus: entry.lastRunStatus }),
    ...(entry.lastError !== undefined && { lastError: entry.lastError }),
    ...(entry.consecutiveErrors !== undefined && { consecutiveErrors: entry.consecutiveErrors }),
    owner,
  };
}

function decisionOf(decision: InboxDecision): ToolApprovalDecision {
  return decision.approved
    ? { approved: true }
    : { approved: false, ...(decision.reason && { reason: decision.reason }) };
}

function routineAnswer(answer: InboxAnswer): RoutineAnswer {
  return {
    ...(answer.decisions !== undefined && {
      decisions: Object.fromEntries(
        Object.entries(answer.decisions).map(([id, decision]) => [id, decisionOf(decision)])
      ),
    }),
    ...(answer.defaultDecision !== undefined && {
      defaultDecision: decisionOf(answer.defaultDecision),
    }),
    ...(answer.responses !== undefined && { responses: answer.responses }),
    ...('decision' in answer && { decision: answer.decision }),
    ...(answer.respondedBy !== undefined && { respondedBy: answer.respondedBy }),
  };
}

/** The approvals an inbox item answers by tool call id: those of its Approve and Reject actions. */
function approvalsOf(item: InboxItem): string[] {
  return [
    ...new Set(
      (item.actions ?? [])
        .filter((action) => action.kind === 'approve' || action.kind === 'reject')
        .flatMap((action) => (action.approvalId !== undefined ? [action.approvalId] : []))
    ),
  ];
}

/**
 * The routines, schedules and inbox of the project's runtime (`experimental_triggers`) for the
 * studio. The studio never starts the trigger manager by itself, as routines may call real models:
 * `start()` does, when the user asks. Every change of the inbox is reported through `onInbox`.
 */
export class ProjectTriggers {
  private stopInbox?: () => void;
  private reporting: Promise<void> = Promise.resolve();

  private constructor(
    private readonly manager: experimental_TriggerManager | undefined,
    onInbox: (change: InboxChangeRecord, unread: number) => void
  ) {
    if (!manager) return;
    this.stopInbox = manager.inbox.subscribe((change) => {
      const copy = plain(change) as InboxChangeRecord;
      this.reporting = this.reporting
        .then(async () => onInbox(copy, await this.unread(manager)))
        .catch((error: unknown) => {
          console.error(`[studio host] could not report an inbox change: ${errorText(error)}`);
        });
    });
  }

  static open(
    cogitator: Cogitator,
    onInbox: (change: InboxChangeRecord, unread: number) => void
  ): ProjectTriggers {
    const candidate: unknown = cogitator.experimental_triggers;
    return new ProjectTriggers(isTriggerManager(candidate) ? candidate : undefined, onInbox);
  }

  async state(): Promise<TriggersState> {
    const manager = this.manager;
    if (!manager) {
      return { configured: false, started: false, routines: [], schedules: [], history: [] };
    }
    const [routines, entries, history] = await Promise.all([
      manager.list(),
      manager.scheduler.list(),
      manager.history({ limit: HISTORY_LIMIT }),
    ]);
    return {
      configured: true,
      started: manager.scheduler.isRunning,
      routines: routines.map(routineRecord),
      schedules: entries.flatMap((entry) => scheduleRecord(entry) ?? []),
      history: plain(history),
    };
  }

  /** Starts the manager: it schedules the cron triggers and polls the schedules. */
  async start(): Promise<TriggersState> {
    await this.configured().start();
    return this.state();
  }

  /** Stops polling the schedules, runs going on finish. */
  async stop(): Promise<TriggersState> {
    await this.configured().stop();
    return this.state();
  }

  /** Fires a trigger by hand, as a person in the studio, with `text` as the event's text. */
  async fire(triggerId: string, text?: string): Promise<TriggerFireResult> {
    const manager = this.configured();
    try {
      return plain(
        await manager.fire(triggerId, { ...(text !== undefined && { text }), actor: 'studio' })
      );
    } catch (error) {
      throw refusalOf(error, 'TRIGGER_NOT_FOUND');
    }
  }

  /**
   * Runs a schedule entry now, or pauses or resumes it. The entry of a routine's trigger is paused
   * and resumed through the trigger, so the trigger's state says the same, an id that is no entry
   * pauses or resumes the trigger or the routine of that id.
   */
  async schedule(action: 'run' | 'pause' | 'resume', id: string): Promise<TriggersState> {
    const manager = this.configured();
    const found = await manager.scheduler.get(id);
    const entry = found && !found.fired && !found.cancelled ? found : undefined;
    if (action === 'run') {
      if (!entry) throw new TriggerRefusal(`No pending schedule entry ${id}`, 'SCHEDULE_NOT_FOUND');
      if (!manager.scheduler.isRunning) {
        throw new TriggerRefusal(
          'The triggers are not started: start them before running a schedule',
          'TRIGGERS_NOT_STARTED'
        );
      }
      if (entry.enabled === false) {
        throw new TriggerRefusal(`Schedule ${id} is paused: resume it first`, 'SCHEDULE_PAUSED');
      }
      await manager.scheduler.runNow(id);
      return this.state();
    }
    const enabled = action === 'resume';
    const trigger = entry?.trigger;
    if (entry && trigger?.routineId === undefined) {
      if (enabled) await manager.scheduler.resume(id);
      else await manager.scheduler.pause(id);
      return this.state();
    }
    const target =
      trigger?.routineId !== undefined && trigger.triggerId !== undefined
        ? `${trigger.routineId}.${trigger.triggerId}`
        : id;
    try {
      await manager.setEnabled(target, enabled);
    } catch (error) {
      throw refusalOf(error, entry ? 'TRIGGER_NOT_FOUND' : 'SCHEDULE_NOT_FOUND');
    }
    return this.state();
  }

  async inbox(query: InboxQuery): Promise<InboxListing> {
    const manager = this.manager;
    if (!manager) return { configured: false, items: [], unread: 0 };
    const items = await manager.inbox.list({
      ...(query.status !== undefined && { status: query.status }),
      ...(query.kind !== undefined && { kind: query.kind }),
      limit: query.limit ?? DEFAULT_INBOX_LIMIT,
    });
    return { configured: true, items: plain(items), unread: await this.unread(manager) };
  }

  /** Marks an item read or unread, or archives it. */
  async update(id: string, status: InboxItemStatus): Promise<InboxItem> {
    const manager = this.configured();
    const item = await manager.inbox.update(id, { status });
    if (!item) throw new TriggerRefusal(`No inbox item ${id}`, 'INBOX_ITEM_NOT_FOUND');
    return plain(item);
  }

  /** Answers an item a routine's run waits on: the run goes on and the item is archived. */
  async respond(id: string, answer: InboxAnswer): Promise<TriggerFireResult> {
    const manager = this.configured();
    try {
      return plain(await manager.respond(id, routineAnswer(answer)));
    } catch (error) {
      throw refusalOf(error, 'INBOX_ITEM_NOT_FOUND');
    }
  }

  /**
   * Answers the approval of a routine's run that `POST /api/approvals/:id` names: the tool call id
   * of an agent's approval, the approval id of a workflow's, or the id of the item. Not decided when
   * no item waits on it, as for a chat's approval the studio does not know.
   */
  async approve(approvalId: string, approved: boolean, reason?: string): Promise<ApprovalOutcome> {
    const manager = this.manager;
    if (!manager) return { decided: false };
    const waiting = await manager.inbox.list({
      kind: 'approval',
      status: ['unread', 'read'],
      limit: APPROVAL_SCAN,
    });
    const item = waiting.find(
      (candidate) =>
        candidate.id === approvalId ||
        candidate.approvalId === approvalId ||
        approvalsOf(candidate).includes(approvalId)
    );
    if (!item) return { decided: false };
    const decision: InboxDecision = { approved, ...(reason !== undefined && { reason }) };
    const workflow = item.approvalId !== undefined && item.threadId === undefined;
    const ids = approvalsOf(item).includes(approvalId) ? [approvalId] : approvalsOf(item);
    const answer: InboxAnswer = workflow
      ? { decision: approved }
      : { decisions: Object.fromEntries(ids.map((id) => [id, decision])) };
    const result = await this.respond(item.id, answer);
    return { decided: true, inboxItemId: item.id, result };
  }

  close(): void {
    this.stopInbox?.();
    this.stopInbox = undefined;
  }

  private configured(): experimental_TriggerManager {
    if (!this.manager) throw new TriggerRefusal(NOT_CONFIGURED, 'TRIGGERS_NOT_CONFIGURED');
    return this.manager;
  }

  private async unread(manager: experimental_TriggerManager): Promise<number> {
    return (await manager.inbox.list({ status: 'unread', limit: INBOX_UNREAD_CAP + 1 })).length;
  }
}
