/**
 * Triggers, routines and the inbox: what starts a session without a person typing (a schedule,
 * an API call, a webhook, an event of GitHub, email or Slack, a task an agent gave itself), the
 * saved tasks they start, and where the results land
 */

import type { Agent } from './agent';
import type { TimerStore } from './workflow';

/** Where a trigger event came from */
export type TriggerSource =
  'cron' | 'api' | 'webhook' | 'github' | 'email' | 'slack' | 'agent' | 'manual';

/** The kinds of trigger a routine can have */
export type TriggerKind = 'cron' | 'api' | 'webhook' | 'github' | 'email' | 'slack';

/** How the sender of an event was checked */
export type TriggerVerificationMethod =
  'schedule' | 'bearer' | 'hmac' | 'github' | 'mailgun' | 'secret' | 'slack' | 'agent' | 'manual';

/** What the check of the sender found */
export interface TriggerVerification {
  readonly method: TriggerVerificationMethod;
  readonly ok: boolean;
  /** More about it, such as the sender authentication of a mail (`pass`, `fail`, `none`) */
  readonly detail?: string;
}

/**
 * One firing of a trigger, the envelope a session starts from. Everything it carries from outside
 * (`payload`, `text`, `actor`) is data, never instructions: the model reads it inside a
 * `<trigger-payload untrusted="true">` block after the routine's own prompt, which is the task
 */
export interface TriggerEvent {
  readonly id: string;
  readonly source: TriggerSource;
  readonly triggerId: string;
  readonly routineId?: string;
  /** When the event came in, ms since epoch */
  readonly occurredAt: number;
  /** The occurrence a schedule fired for, ms since epoch: later than it for a late or caught-up run */
  readonly scheduledFor?: number;
  /** What tells a repeated delivery of the same event apart, such as `X-GitHub-Delivery` */
  readonly dedupKey?: string;
  /** The event's name at its source: a GitHub event (`pull_request.opened`), a Slack event type */
  readonly name?: string;
  /** The event as it came, JSON-safe */
  readonly payload?: unknown;
  /** The text of the event: an API call's `text`, a mail's body, a Slack message */
  readonly text?: string;
  /** Always true: the event comes from outside the routine */
  readonly untrusted: true;
  readonly verified: TriggerVerification;
  /** Who sent it, as its source names them: a GitHub login, a mail address, a Slack user */
  readonly actor?: string;
}

/** A secret given in code, or the name of the environment variable that holds it */
export type TriggerSecret = string | { env: string };

/** A request a trigger answers, as an HTTP server received it */
export interface TriggerHttpRequest {
  method: string;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** The body exactly as received: signatures cover these bytes */
  rawBody: string | Uint8Array;
  query?: Readonly<Record<string, string>>;
  /** The caller's address, for the rate limit */
  ip?: string;
}

/** How a trigger answers an HTTP request */
export interface TriggerHttpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/**
 * What firing a trigger came to: a run `started`, the firing `queued` behind a run going on (or
 * given to it as a follow-up), `skipped` (a run goes on, a limit was reached, the trigger is
 * paused, the schedule missed it) or a `duplicate` of an event that already started a run
 */
export interface TriggerFireResult {
  type: 'routine_fire';
  status: 'started' | 'queued' | 'skipped' | 'duplicate';
  eventId: string;
  /** The routine fired, absent for a task an agent gave itself that `respond()` resumed */
  routineId?: string;
  /** `<routineId>.<triggerId>`, or the schedule entry of a task an agent gave itself */
  triggerId: string;
  runId?: string;
  threadId?: string;
  reason?: string;
}

/** A mail an email trigger read from a provider's webhook */
export interface EmailTriggerMail {
  from?: string;
  subject?: string;
  text?: string;
  messageId?: string;
  /** Sender authentication (DKIM, SPF, DMARC) as the provider reported it */
  authentication?: 'pass' | 'fail' | 'none';
  /** The fields of the request, for the payload */
  fields?: Record<string, unknown>;
}

/** A condition on a field of a GitHub event, as Claude Code's GitHub triggers have them */
export interface GitHubTriggerFilter {
  /** A dot path into the payload, such as `pull_request.base.ref` or `action` */
  field: string;
  equals?: string | number | boolean;
  contains?: string;
  /** A regular expression the whole value must match */
  matches?: string;
}

interface TriggerSpecBase {
  /** Unique among the routine's triggers, `[a-z0-9][a-z0-9_-]*`. Defaults to the kind */
  id?: string;
  /** Default true */
  enabled?: boolean;
  /** Most events per hour the trigger takes, the rest are answered `429` */
  maxPerHour?: number;
}

/** Fires on a schedule: a cron expression (5 or 6 fields, `@daily` and the like) in a time zone */
export interface CronTriggerSpec extends TriggerSpecBase {
  kind: 'cron';
  cron: string;
  /** An IANA time zone, such as `Europe/Moscow`. Default: the process's */
  timezone?: string;
}

/**
 * Fires on `POST /triggers/:id/fire` with `Authorization: Bearer <token>` and `{ "text": "..." }`.
 * The token is the one given here, else one the manager issues (`issueToken`), shown once and kept
 * only as its SHA-256
 */
export interface ApiTriggerSpec extends TriggerSpecBase {
  kind: 'api';
  token?: TriggerSecret;
}

/** Fires on a webhook signed with HMAC over the raw body, as `webhookTrigger` of workflows checks it */
export interface WebhookTriggerSpec extends TriggerSpecBase {
  kind: 'webhook';
  secret: TriggerSecret;
  /** Default `sha256` */
  algorithm?: 'sha256' | 'sha512';
  /** The header with the signature, hex, optionally `sha256=` first. Default `x-signature` */
  signatureHeader?: string;
  /** A header naming the delivery, for deduplication */
  deliveryHeader?: string;
}

/** Fires on GitHub webhook deliveries, checked by `X-Hub-Signature-256` */
export interface GitHubTriggerSpec extends TriggerSpecBase {
  kind: 'github';
  secret: TriggerSecret;
  /** Events to take, `pull_request` or with the action `pull_request.opened`. Default: all */
  events?: string[];
  /** Conditions every one of which the payload must meet */
  filters?: GitHubTriggerFilter[];
}

/** Fires on inbound mail from a provider's webhook, checked as the email channel checks it */
export interface EmailTriggerSpec extends TriggerSpecBase {
  kind: 'email';
  provider: 'mailgun' | 'postmark' | 'sendgrid';
  /** Mailgun's webhook signing key */
  signingKey?: TriggerSecret;
  /** A secret the provider sends in the URL (`?token=`) or in `X-Webhook-Token` */
  token?: TriggerSecret;
  /** Basic auth the provider sends */
  basicAuth?: { username: string; password: TriggerSecret };
  /** How old a Mailgun signature may be, in seconds (default 300) */
  maxAgeSeconds?: number;
  /** Reads the mail from the request, `experimental_emailTriggerParser()` of the channels package. Code only */
  parse?: (request: TriggerHttpRequest) => Promise<EmailTriggerMail>;
}

/** Fires on Slack Events API callbacks, checked by Slack's request signature */
export interface SlackTriggerSpec extends TriggerSpecBase {
  kind: 'slack';
  signingSecret: TriggerSecret;
  /** Event types to take, such as `app_mention` or `message`. Default: all */
  events?: string[];
}

export type TriggerSpec =
  | CronTriggerSpec
  | ApiTriggerSpec
  | WebhookTriggerSpec
  | GitHubTriggerSpec
  | EmailTriggerSpec
  | SlackTriggerSpec;

/**
 * What happens when a routine fires while runs of it go on (`maxConcurrent` of them):
 * - `skip` (default): the new firing is skipped and recorded in the history
 * - `queue`: it waits for a run to end; on a routine with a thread of its own it is given to the
 *   run going on as a follow-up message
 * - `parallel`: it starts next to them, up to `maxConcurrent`, past that it is skipped
 * - `replace`: the oldest run going on is aborted and the new one starts
 */
export type RoutineOverlap = 'skip' | 'queue' | 'parallel' | 'replace';

/**
 * What a schedule does about occurrences it missed (the process was down or asleep), as far back
 * as `catchUpWindowMs`: `latest` (default) runs once for the latest of them, `all` runs each in
 * turn (at most 100), `none` runs none and goes on from the next one
 */
export type ScheduleCatchUp = 'latest' | 'none' | 'all';

/** The agent or workflow a routine runs */
export type RoutineTarget =
  | {
      /** An agent of `experimental_triggers.agents` by name, or an agent */
      agent: string | Agent;
    }
  | {
      /** A workflow of `experimental_triggers.workflows` by name, or one */
      workflow: string | RoutineWorkflow;
    };

/** Who hears about a routine's results: the channel and chat they go to */
export interface RoutineOwner {
  channel?: string;
  channelId?: string;
  userId?: string;
  topicId?: string;
  conversationId?: string;
}

/**
 * A saved task and what starts it. Each firing starts a session of its own (or continues the
 * routine's thread), with `prompt` as the task and the event as untrusted data
 */
export interface RoutineDefinition {
  /** `[a-z0-9][a-z0-9_:-]*`, a plugin's routines are `plugin:id` */
  id: string;
  name?: string;
  description?: string;
  /**
   * The task. It is the routine's instruction, the event's contents are not: the model acts on
   * what an event says only as far as this prompt tells it to
   */
  prompt: string;
  target: RoutineTarget;
  /** `new` (default): a new thread per firing. A thread id: every firing continues that thread */
  session?: 'new' | { threadId: string };
  triggers?: TriggerSpec[];
  /** Default `skip` */
  overlap?: RoutineOverlap;
  /** Most runs of the routine going on at once, default 1 (with `parallel`, unlimited) */
  maxConcurrent?: number;
  /** Default `latest` */
  catchUp?: ScheduleCatchUp;
  /** How far back missed occurrences are caught up, default 7 days */
  catchUpWindowMs?: number;
  /** The user the runs act for */
  userId?: string;
  owner?: RoutineOwner;
  /** Which outcomes go to the inbox and its notifications, both by default */
  notify?: { result?: boolean; failure?: boolean };
  /** Default true */
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}

/** A routine as the manager lists it: where it was defined and its triggers' state */
export interface RoutineInfo {
  routine: RoutineDefinition;
  origin: 'code' | 'store' | 'plugin';
  /** The plugin it came from */
  plugin?: string;
  triggers: TriggerInfo[];
  /** Runs of it going on in this process */
  active: number;
  /** Firings waiting for a run to end (`overlap: 'queue'`) */
  queued: number;
}

/** A trigger as the manager lists it */
export interface TriggerInfo {
  /** `<routineId>.<triggerId>`, the id the HTTP routes take */
  id: string;
  routineId: string;
  kind: TriggerKind;
  enabled: boolean;
  spec: TriggerSpecSummary;
  state: TriggerState;
  /** The next occurrence of a schedule */
  nextFireAt?: number;
  /** The schedule entry of a cron trigger in the schedules store */
  scheduleId?: string;
}

/** A trigger's spec without its secrets */
export type TriggerSpecSummary = { kind: TriggerKind; id: string } & Record<string, unknown>;

/** What the manager keeps about a trigger between firings and restarts */
export interface TriggerState {
  /** `<routineId>.<triggerId>` */
  id: string;
  routineId: string;
  /** SHA-256 (hex) of the API token the manager issued */
  tokenHash?: string;
  /** The last 4 characters of that token, to tell tokens apart */
  tokenHint?: string;
  tokenIssuedAt?: number;
  /** The schedule entry of a cron trigger */
  scheduleId?: string;
  /** Overrides `enabled` of the spec: set by `pause` and `resume` */
  enabled?: boolean;
  fireCount: number;
  lastFiredAt?: number;
  lastError?: string;
}

/**
 * A change to a trigger's state that a store applies in one step, on top of the state as it is
 * then: the fields given replace theirs, `fireCountDelta` adds to `fireCount`. Two changes at once
 * (a firing and a token rotation) both land, neither overwrites the other's fields
 */
export type TriggerStatePatch = Partial<Omit<TriggerState, 'id' | 'routineId' | 'fireCount'>> & {
  /** Added to `fireCount` */
  fireCountDelta?: number;
};

/**
 * A run of a routine, or of a task an agent gave itself, going on: what the manager needs to take
 * it up again after a restart (a durable run the runtime recovers). Kept apart from the history,
 * which drops old records, and removed once the run ends
 */
export interface ActiveRoutineRun {
  runId: string;
  /** `routine` for a routine's run, `task` for a task an agent gave itself */
  kind: 'routine' | 'task';
  /** The event's id */
  eventId: string;
  /** `<routineId>.<triggerId>`, or the schedule entry of a task */
  triggerId: string;
  routineId?: string;
  source: TriggerSource;
  /** When it fired */
  at: number;
  scheduledFor?: number;
  threadId: string;
  /** The agent of a task, by its name in `experimental_triggers.agents` */
  agent?: string;
  /** The description of a task */
  description?: string;
  userId?: string;
}

/** How a firing of a routine ended up, kept in its history */
export type RoutineRunStatus =
  'started' | 'queued' | 'skipped' | 'completed' | 'failed' | 'paused' | 'replaced';

/** One firing of a routine in its history */
export interface RoutineRunRecord {
  /** The event's id */
  id: string;
  routineId: string;
  triggerId: string;
  source: TriggerSource;
  /** When it fired */
  at: number;
  scheduledFor?: number;
  status: RoutineRunStatus;
  runId?: string;
  threadId?: string;
  workflowRunId?: string;
  /** Why it was skipped or failed */
  reason?: string;
  finishedAt?: number;
}

/**
 * Where the manager keeps routines made at run time (by the CLI, the API, a person), trigger
 * state, run history and the keys that make a firing start once. A store several processes share
 * makes each event start one run among them all: `claimKey` must be atomic (Redis `SET NX`, a
 * Postgres insert), the in-memory and file stores are for one process (the file store locks its
 * file, so the CLI and one runtime may share it)
 */
export interface RoutineStore {
  listRoutines(): Promise<RoutineDefinition[]>;
  getRoutine(id: string): Promise<RoutineDefinition | null>;
  /** Saves a routine. A store refuses a secret given as a string: use `{ env }` */
  saveRoutine(routine: RoutineDefinition): Promise<void>;
  deleteRoutine(id: string): Promise<void>;
  getTriggerState(id: string): Promise<TriggerState | null>;
  listTriggerStates(routineId?: string): Promise<TriggerState[]>;
  saveTriggerState(state: TriggerState): Promise<void>;
  /**
   * Changes a trigger's state in one atomic step (a new state when it has none) and returns it.
   * The manager makes every change through it, so a firing and a pause or a token rotation at the
   * same time keep each other's fields
   */
  patchTriggerState(id: string, routineId: string, patch: TriggerStatePatch): Promise<TriggerState>;
  deleteTriggerState(id: string): Promise<void>;
  /** Takes `key` for `ttlMs`: true for the first caller, false while it is taken */
  claimKey(key: string, ttlMs: number): Promise<boolean>;
  /** Gives `key` back before its time is up */
  releaseKey(key: string): Promise<void>;
  /** Adds or replaces (by `id`) a record of the history, which keeps the latest 200 per routine */
  recordRun(record: RoutineRunRecord): Promise<void>;
  /** The history, newest first */
  listRuns(filter?: { routineId?: string; limit?: number }): Promise<RoutineRunRecord[]>;
  /** Keeps a run going on, for `recover` after a restart */
  saveActiveRun(run: ActiveRoutineRun): Promise<void>;
  getActiveRun(runId: string): Promise<ActiveRoutineRun | null>;
  listActiveRuns(): Promise<ActiveRoutineRun[]>;
  deleteActiveRun(runId: string): Promise<void>;
}

/** What a routine's workflow gets for one firing */
export interface RoutineWorkflowContext {
  routine: RoutineDefinition;
  event: TriggerEvent;
  /** The routine's prompt with the event wrapped as untrusted data, as an agent would get it */
  input: string;
  /** The deterministic id of this firing's run */
  runId: string;
  signal: AbortSignal;
  /** The inbox, for approvals a workflow waits on */
  inbox: InboxWriter;
}

/** How a routine's workflow ended */
export interface RoutineWorkflowOutcome {
  /** `waiting`: it waits for a person (an approval in the inbox) */
  status: 'completed' | 'failed' | 'waiting';
  /** What to show as the result */
  output?: string;
  error?: string;
  workflowRunId?: string;
}

/** A workflow a routine runs, `experimental_routineWorkflow()` of the workflows package */
export interface RoutineWorkflow {
  readonly name: string;
  run(context: RoutineWorkflowContext): Promise<RoutineWorkflowOutcome>;
  /**
   * Answers an approval the workflow waits on (an inbox item's `approvalId`): the trigger
   * manager's `respond()` calls it for a routine that runs a workflow
   */
  respond?(approvalId: string, decision: unknown, respondedBy?: string): Promise<void>;
}

/** What an inbox item is about */
export type InboxItemKind = 'result' | 'approval' | 'question' | 'failure';

export type InboxItemStatus = 'unread' | 'read' | 'archived';

/** Something a person can do from an inbox item */
export interface InboxAction {
  id: string;
  label: string;
  /** `approve` and `reject` answer `approvalId` */
  kind: 'approve' | 'reject' | 'open' | 'reply';
  approvalId?: string;
  url?: string;
}

/** A result, a failure or a question of a routine, kept for a person to read */
export interface InboxItem {
  id: string;
  kind: InboxItemKind;
  title: string;
  /** Short: a line or two */
  summary: string;
  /** The whole result, when it is longer than the summary */
  body?: string;
  status: InboxItemStatus;
  createdAt: number;
  updatedAt?: number;
  /**
   * When a person answered the approval or question (`respond()` of the trigger manager). Set
   * once, by `InboxStore.claimAnswer`: an answered item cannot be answered again, whatever its
   * status, and a status change never makes it unanswered
   */
  answeredAt?: number;
  routineId?: string;
  triggerId?: string;
  triggerEventId?: string;
  source?: TriggerSource;
  runId?: string;
  threadId?: string;
  workflowRunId?: string;
  /** The approval a `approval` item waits on */
  approvalId?: string;
  /** Whose item it is: only they see it through the server routes */
  userId?: string;
  actions?: InboxAction[];
  metadata?: Record<string, unknown>;
}

/** What `add` takes: the item without what the inbox fills in */
export type InboxItemInput = Omit<
  InboxItem,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'answeredAt'
> & {
  id?: string;
  status?: InboxItemStatus;
};

/** Which items `list` returns */
export interface InboxFilter {
  status?: InboxItemStatus | readonly InboxItemStatus[];
  kind?: InboxItemKind | readonly InboxItemKind[];
  routineId?: string;
  /** Only the items of this user; `null` for the items without one */
  userId?: string | null;
  /** Only items created before this time, for paging */
  before?: number;
  /**
   * With `before`: also the items created at `before` whose id sorts before this one, as the
   * list orders them (newest first, then by id from the end). The cursor of a page is then the
   * `createdAt` and `id` of its last item, and items of the same millisecond are not skipped
   */
  beforeId?: string;
  /** Default 50 */
  limit?: number;
}

/** What may change about an item */
export interface InboxItemPatch {
  status?: InboxItemStatus;
  metadata?: Record<string, unknown>;
}

/** Where inbox items are kept */
export interface InboxStore {
  add(item: InboxItem): Promise<void>;
  get(id: string): Promise<InboxItem | null>;
  /** Newest first */
  list(filter?: InboxFilter): Promise<InboxItem[]>;
  /** The item after the change, null when there is no such item */
  update(id: string, patch: InboxItemPatch): Promise<InboxItem | null>;
  /**
   * Marks the item answered at `answeredAt` and archived, in one atomic step: the item after the
   * change for the first caller, null when it is answered already or there is no such item. Two
   * answers at once to one approval resume its run once
   */
  claimAnswer(id: string, answeredAt: number): Promise<InboxItem | null>;
  /** Takes back an answer whose run could not be given it, so it can be answered again */
  releaseAnswer(id: string): Promise<void>;
  delete(id: string): Promise<void>;
}

/** What adds to an inbox */
export interface InboxWriter {
  add(item: InboxItemInput): Promise<InboxItem>;
}

/** Hears of each new inbox item: a channel, a webhook, Studio */
export interface NotificationSink {
  readonly name: string;
  notify(item: InboxItem): void | Promise<void>;
}

/** Computes cron occurrences. `experimental_createCronEngine` builds one over `cron-parser` */
export interface CronEngine {
  /** The first occurrence after `after` (ms), in `timezone` */
  next(expression: string, after: number, timezone?: string): number;
  /** The latest `count` (default 1) occurrences at or before `atOrBefore`, newest first */
  previous(expression: string, atOrBefore: number, timezone?: string, count?: number): number[];
  /** The occurrences after `from` up to and including `to`, at most `limit` (default 100) */
  between(
    expression: string,
    from: number,
    to: number,
    timezone?: string,
    limit?: number
  ): number[];
  /** Why the expression or time zone cannot be used, undefined when it can */
  problem(expression: string, timezone?: string): string | undefined;
  /** The expression with presets of this engine spelled out */
  normalize(expression: string): string;
}

/** Something the trigger manager did, for logs and Studio */
export type TriggerManagerEvent =
  | {
      type: 'fired';
      event: TriggerEvent;
      status: RoutineRunStatus;
      runId?: string;
      reason?: string;
    }
  | { type: 'completed'; routineId: string; runId: string; status: RoutineRunStatus }
  | { type: 'inbox'; item: InboxItem }
  | { type: 'error'; error: string; routineId?: string; triggerId?: string };

/**
 * Experimental. Triggers of a runtime: routines and what starts them, the schedules store, the
 * inbox and who hears of it. See `cog.experimental_triggers`
 */
export interface TriggersConfig {
  /** Agents routines run, by name */
  agents?: Record<string, Agent>;
  /**
   * The agents and workflows of `agents` and `workflows`, by name, that routines of plugins may
   * run. A plugin's routine whose target is a name not listed here is refused (an agent or
   * workflow the plugin passes itself, in its own code, needs no listing). Default: none
   */
  pluginTargets?: { agents?: readonly string[]; workflows?: readonly string[] };
  /** Workflows routines run, by name, `experimental_routineWorkflow()` of the workflows package */
  workflows?: Record<string, RoutineWorkflow>;
  /** Routines in code */
  routines?: RoutineDefinition[];
  /** Routines made at run time, trigger state, history and claims. Default: in memory */
  store?: RoutineStore;
  /**
   * Schedule entries of cron triggers and of tasks agents gave themselves. Default: in memory.
   * Any `TimerStore`: `FileTimerStore`, the Redis and Postgres stores of workflows
   */
  schedules?: TimerStore;
  /** Default: in memory */
  inbox?: InboxStore;
  /** Who hears of new inbox items, besides the `Notification` hooks */
  sinks?: NotificationSink[];
  /** Default: one over `cron-parser`, loaded when the manager starts */
  cron?: CronEngine;
  /** How often the schedules store is polled, ms (default 1000) */
  pollInterval?: number;
  /** How long a delivery id is remembered against repeats, ms (default 24 hours) */
  dedupTtlMs?: number;
  /** Most firings waiting per routine with `overlap: 'queue'` (default 10) */
  maxQueued?: number;
  /** Whether runs are durable (`RunOptions.durable`). Default: when the runtime has `durable` */
  durable?: boolean;
  onEvent?: (event: TriggerManagerEvent) => void;
}
