/**
 * The typed client of the Cogitator app-server protocol, generated from its Zod schemas by
 * `pnpm --filter @cogitator-ai/app-server generate` (or `cogitator app-server generate-ts`).
 * Do not edit it by hand: change the schemas and generate it again.
 */

export const APP_SERVER_PROTOCOL_VERSION = 1;

/** The error codes the app-server answers with */
export const APP_SERVER_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  notFound: -32002,
  notInitialized: -32010,
  alreadyInitialized: -32011,
  threadBusy: -32020,
  turnNotActive: -32021,
  threadPaused: -32022,
  threadArchived: -32023,
  runtimeError: -32030,
} as const;

/** Data of the sender of its own, the other side passes it over */
export type Meta = Record<string, unknown>;

/** How the tool calls of a turn are allowed, see PermissionMode in @cogitator-ai/types */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';

/** Text the user wrote */
export interface TextInput {
  type: 'text';
  text: string;
  _meta?: Meta;
}

/** An image the model can fetch */
export interface ImageUrlInput {
  type: 'image';
  /** An http(s) or data: URL of the image */
  url: string;
  _meta?: Meta;
}

/** An image sent inline */
export interface ImageDataInput {
  type: 'image';
  /** The image, base64 encoded */
  data: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  _meta?: Meta;
}

/** One part of what the user sends: text or an image */
export type UserInput = TextInput | ImageUrlInput | ImageDataInput;

/** `steer` after the tool calls of the current step, `followUp` when the agent would stop, `inject` as context for the next model call */
export type Delivery = 'steer' | 'followUp' | 'inject';

/** A message sent to a turn that it had not taken when it ended */
export interface QueuedMessage {
  delivery: Delivery;
  input: Array<UserInput>;
  _meta?: Meta;
}

/** Token usage of a run, the same in the JSON response and in the finish event of the stream */
export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Hidden reasoning tokens, already counted in outputTokens */
  reasoningTokens?: number;
  /** Input tokens read from the provider's prompt cache */
  cachedInputTokens?: number;
  /** Input tokens written to the provider's prompt cache */
  cacheWriteTokens?: number;
}

/** A tool call waiting for an approval decision */
export interface PendingApproval {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  description: string;
  sideEffects?: Array<string>;
  /** Why the call asks: the rule, the mode or the tool's own approval setting */
  reason?: string;
  /** The `ask` rule that made the call ask, as written, such as `Bash(git push *)` */
  rule?: string;
  /** The rule an "always allow" answer (`remember: true`) saves */
  suggestedRule?: string;
  /** The permission mode of the run */
  mode?: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';
}

/** A question a paused run waits on */
export interface PendingInterrupt {
  /** Key of the answer in the `responses` of the resume */
  id: string;
  /** `approval` for a tool call, `input` for an answer a tool asked for, `plan` for a plan to approve, `budget` for a budget the run reached */
  kind: 'approval' | 'input' | 'plan' | 'budget';
  reason: string;
  message: string;
  /** JSON Schema the answer must match */
  responseSchema?: Record<string, unknown>;
  /** ISO time after which an answer is refused */
  expiresAt?: string;
  toolCallId?: string;
  toolName?: string;
  /** More to show the person who answers: the `plan` of a plan, the usage of a budget (`scope`, `metric`, `used`, `limit`), the `reason`, `rule` and `suggestedRule` of an approval */
  details?: Record<string, unknown>;
}

/** An event of the stream protocol, the JSON of one SSE `data:` line. The stream ends with `data: [DONE]` */
export type StreamEvent = {
  type: 'start';
  messageId: string;
  /** The thread of an agent run: the one the request named, or a new one. Send it with the next message to continue the conversation */
  threadId?: string;
} | {
  type: 'text-start';
  id: string;
} | {
  type: 'text-delta';
  id: string;
  delta: string;
} | {
  type: 'text-end';
  id: string;
} | {
  type: 'reasoning-start';
  id: string;
} | {
  type: 'reasoning-delta';
  id: string;
  delta: string;
} | {
  type: 'reasoning-end';
  id: string;
} | {
  type: 'tool-call-start';
  id: string;
  toolName: string;
} | {
  type: 'tool-call-delta';
  id: string;
  argsTextDelta: string;
} | {
  type: 'tool-call-end';
  id: string;
  /** The model stopped before the arguments were complete, the call never runs */
  dropped?: true;
} | {
  type: 'tool-result';
  id: string;
  toolCallId: string;
  result?: unknown;
  /** Data for the application, never sent to the model */
  details?: unknown;
  /** How a client shows a tool call, without the code of the tool */
  presentation?: {
    label: string;
    /** Name of an icon, Lucide names by convention */
    icon?: string;
    /** One line about the call, such as a path */
    detail?: string;
  };
  /** The call never ran and has no result: remove it */
  dropped?: true;
  /** Why a dropped call never ran: never finished, or not kept by the run */
  reason?: 'incomplete' | 'discarded';
} | {
  type: 'tool-update';
  toolCallId: string;
  content?: unknown;
  details?: unknown;
  /** How a client shows a tool call, without the code of the tool */
  presentation?: {
    label: string;
    /** Name of an icon, Lucide names by convention */
    icon?: string;
    /** One line about the call, such as a path */
    detail?: string;
  };
  /** The arguments the call runs with, replacing the streamed ones */
  arguments?: Record<string, unknown>;
} | {
  type: 'approval-required';
  threadId: string;
  approvals: Array<PendingApproval>;
} | {
  type: 'interrupt-required';
  threadId: string;
  interrupts: Array<PendingInterrupt>;
} | {
  type: 'error';
  message: string;
  code?: string;
} | {
  type: 'finish';
  messageId: string;
  usage?: RunUsage;
  /** The thread of an agent run: the one the request named, or a new one. Send it with the next message to continue the conversation */
  threadId?: string;
  /** `paused` when tool calls wait for approval: resume with the thread id to go on */
  status?: 'completed' | 'paused';
  /** The tool calls a paused run waits on */
  pendingApprovals?: Array<PendingApproval>;
  /** The questions a paused run's tools asked */
  interrupts?: Array<PendingInterrupt>;
  /** The answer parsed against the agent's responseFormat */
  structured?: unknown;
  /** Why the answer does not match the agent's responseFormat */
  structuredError?: string;
  /** The answer stopped at the output token limit and may be cut off */
  truncated?: true;
  /** The provider withheld the answer */
  blocked?: 'content_filter' | 'refusal';
  /** Tool calls used up the agent's maxIterations before the model answered */
  iterationLimitReached?: true;
  /** A hook or middleware ended the run before its next model call */
  stopped?: {
    reason: string;
    middleware: string;
  };
} | {
  type: 'workflow';
  event: string;
  data?: unknown;
} | {
  type: 'swarm';
  event: string;
  data?: unknown;
};

export interface ClientInfo {
  name: string;
  title?: string;
  version?: string;
}

export interface ServerInfo {
  name: string;
  version: string;
}

export interface ClientCapabilities {
  /** `request` to be asked with `approval/request` while a turn waits, `pause` (the default) to have the turn end paused */
  approvals?: 'request' | 'pause';
  /** Whether to send `_cogitator/trace/span` as the spans of turns end */
  traces?: boolean;
  /** Notification methods not to send, such as `thread/log` */
  optOutNotifications?: Array<string>;
  _meta?: Meta;
}

export interface ServerCapabilities {
  approvals: Array<'request' | 'pause'>;
  review: boolean;
  memorySearch: boolean;
  rewind: boolean;
  workflows: boolean;
  swarms: boolean;
  /** Whether `thread/log` notifications are sent */
  threadLog: boolean;
  /** Whether the spans of turns are kept and sent */
  traces: boolean;
  _meta?: Meta;
}

export interface AgentInfo {
  name: string;
  description?: string;
  model?: string;
  default: boolean;
  /** Whether the agent runs outside the runtime, such as an ACP agent the host launched: its threads cannot be forked, rewound or reviewed */
  external?: boolean;
}

export interface InitializeParams {
  /** The protocol version the client speaks */
  protocolVersion: number;
  clientInfo: ClientInfo;
  capabilities?: ClientCapabilities;
  _meta?: Meta;
}

export interface InitializeResult {
  /** The protocol version the server speaks */
  protocolVersion: number;
  serverInfo: ServerInfo;
  capabilities: ServerCapabilities;
  agents: Array<AgentInfo>;
  _meta?: Meta;
}

/** `running` while a turn goes on, `paused` while a turn waits on approvals or answers */
export type ThreadStatus = 'idle' | 'running' | 'paused';

/** A conversation with an agent, kept in the memory of the runtime */
export interface Thread {
  id: string;
  /** The agent the thread runs, by the name `initialize` lists it under */
  agent?: string;
  status: ThreadStatus;
  archived: boolean;
  /** The turn going on, while `running` */
  activeTurnId?: string;
  /** The thread this one was forked from */
  forkedFrom?: string;
  /** The permission mode new turns of the thread start in */
  permissionMode?: PermissionMode;
  /** ISO time */
  createdAt: string;
  /** ISO time the thread itself last changed */
  updatedAt: string;
  metadata: Record<string, unknown>;
  _meta?: Meta;
}

/** A message of the active branch of a thread */
export interface ThreadMessage {
  entryId: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  text: string;
  createdAt: string;
  _meta?: Meta;
}

export interface ThreadStartParams {
  /** The agent to run, the default agent when left out */
  agent?: string;
  /** An id of your own for the thread */
  threadId?: string;
  metadata?: Record<string, unknown>;
  permissionMode?: PermissionMode;
  _meta?: Meta;
}

export interface ThreadStartResult {
  thread: Thread;
  _meta?: Meta;
}

export interface ThreadResumeParams {
  threadId: string;
  _meta?: Meta;
}

export interface ThreadResumeResult {
  thread: Thread;
  messages: Array<ThreadMessage>;
  /** What the paused thread waits on */
  pending?: TurnPending;
  _meta?: Meta;
}

export interface ThreadForkParams {
  threadId: string;
  /** The last entry the fork keeps, the end of the active branch by default */
  atEntryId?: string;
  newThreadId?: string;
  _meta?: Meta;
}

export interface ThreadForkResult {
  thread: Thread;
  _meta?: Meta;
}

export interface ThreadListParams {
  /** `true` for archived threads only, `false` for the others, unset for all */
  archived?: boolean;
  agent?: string;
  cursor?: string;
  limit?: number;
  _meta?: Meta;
}

export interface ThreadListResult {
  threads: Array<Thread>;
  nextCursor?: string;
  _meta?: Meta;
}

export interface ThreadIdParams {
  threadId: string;
  _meta?: Meta;
}

export interface ThreadResult {
  thread: Thread;
  _meta?: Meta;
}

export interface ThreadSetPermissionModeParams {
  threadId: string;
  mode: PermissionMode;
  _meta?: Meta;
}

/** The answer to a tool call that waits for approval */
export type ApprovalDecision = {
  approved: true;
  /** Arguments to run the call with instead */
  updatedArguments?: Record<string, unknown>;
  /** Also allow such calls from now on */
  remember?: boolean;
} | {
  approved: false;
  reason?: string;
  /** Also refuse such calls from now on */
  remember?: boolean;
};

/** How a paused thread goes on */
export interface TurnResume {
  /** Decisions by tool call id */
  decisions?: Record<string, ApprovalDecision>;
  /** Answers to the interrupts by interrupt id */
  responses?: Record<string, unknown>;
  /** The decision for every call `decisions` leaves out */
  defaultDecision?: ApprovalDecision;
  _meta?: Meta;
}

/** How the turn stands: `inProgress` until it ends */
export type TurnStatus = 'inProgress' | 'completed' | 'paused' | 'interrupted' | 'failed';

/** What the model calls of a turn used */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Hidden reasoning tokens, already counted in outputTokens */
  reasoningTokens?: number;
  /** Input tokens read from the provider's prompt cache */
  cachedInputTokens?: number;
  /** Input tokens written to the provider's prompt cache */
  cacheWriteTokens?: number;
  /** What the turn cost, in USD */
  cost: number;
  durationMs: number;
}

/** Why a turn failed */
export interface TurnError {
  message: string;
  code?: string;
}

/** What a paused turn waits on: answer it with `turn/start` and `resume` */
export interface TurnPending {
  approvals: Array<PendingApproval>;
  interrupts: Array<PendingInterrupt>;
  _meta?: Meta;
}

/** What a review looks at */
export type ReviewTarget = {
  type: 'uncommittedChanges';
} | {
  type: 'baseBranch';
  branch: string;
} | {
  type: 'commit';
  sha: string;
  title?: string;
} | {
  type: 'custom';
  instructions: string;
};

export interface ReviewLocation {
  path: string;
  startLine: number;
  endLine: number;
}

/** One problem a review found */
export interface ReviewFinding {
  /** One line naming the problem */
  title: string;
  /** Why it is a problem and what to do about it */
  body: string;
  /** 0 for a problem that must be fixed before merging, up to 3 for a nit */
  priority: number;
  /** How sure the reviewer is, from 0 to 1 */
  confidence: number;
  location?: ReviewLocation;
}

/** What a review found */
export interface ReviewOutput {
  findings: Array<ReviewFinding>;
  /** Whether the changes do what they mean to without breaking anything */
  overallCorrectness: 'correct' | 'incorrect';
  overallExplanation: string;
}

/** One run of the agent in a thread */
export interface Turn {
  id: string;
  threadId: string;
  status: TurnStatus;
  /** The answer of the agent, once the turn ended */
  output?: string;
  /** The answer parsed against the output schema */
  structured?: unknown;
  structuredError?: string;
  usage?: TurnUsage;
  error?: TurnError;
  pending?: TurnPending;
  undelivered?: Array<QueuedMessage>;
  /** The findings of a review turn */
  review?: ReviewOutput;
  startedAt: string;
  completedAt?: string;
  _meta?: Meta;
}

/** Starts a turn with `input`, or resumes a paused thread with `resume` */
export interface TurnStartParams {
  threadId: string;
  input?: Array<UserInput>;
  resume?: TurnResume;
  /** A JSON Schema the answer must match, read into `structured` */
  outputSchema?: Record<string, unknown>;
  /** A model for this turn, as `provider/model` */
  model?: string;
  permissionMode?: PermissionMode;
  _meta?: Meta;
}

export interface TurnStartResult {
  turn: Turn;
  _meta?: Meta;
}

export interface TurnSteerParams {
  threadId: string;
  /** The turn the message is for, so it never lands in another */
  expectedTurnId: string;
  input: Array<UserInput>;
  /** `steer` by default */
  delivery?: Delivery;
  _meta?: Meta;
}

export interface TurnSteerResult {
  turnId: string;
  _meta?: Meta;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
  _meta?: Meta;
}

export interface TurnInterruptResult {
  undelivered: Array<QueuedMessage>;
  _meta?: Meta;
}

export interface ReviewStartParams {
  /** The thread the review is asked from */
  threadId: string;
  target: ReviewTarget;
  /** A model for the review, as `provider/model` */
  model?: string;
  _meta?: Meta;
}

export interface ReviewStartResult {
  turn: Turn;
  /** The thread the review turn runs in */
  reviewThreadId: string;
  _meta?: Meta;
}

export interface MemorySearchParams {
  query: string;
  /** The thread whose turns to search */
  threadId?: string;
  /** The agent whose memory items to search */
  agent?: string;
  limit?: number;
  _meta?: Meta;
}

/** A memory item or a turn of the thread that matches the query */
export type MemorySearchHit = {
  kind: 'item';
  ref: string;
  text: string;
  type: string;
  held?: string;
} | {
  kind: 'turn';
  id: string;
  date: string;
  role: string;
  excerpt: string;
};

export interface MemorySearchResult {
  results: Array<MemorySearchHit>;
  note?: string;
  _meta?: Meta;
}

export interface ThreadRewindParams {
  threadId: string;
  /** The entry the active branch ends at after the rewind */
  toEntryId: string;
  /** Restore the workspace files of that point too */
  files?: boolean;
  dryRun?: boolean;
  /** Stop the runs in the way instead of refusing */
  force?: boolean;
  _meta?: Meta;
}

export interface ThreadRewindResult {
  threadId: string;
  toEntryId: string;
  dryRun: boolean;
  conversation: {
    rewound: boolean;
    cut: Array<string>;
    previousLeafId?: string;
  };
  runs: {
    going: Array<string>;
    interrupted: Array<string>;
    paused: boolean;
    durable: Array<string>;
  };
  files?: Record<string, unknown>;
  /** The whole report of Cogitator.rewind(), memory items included */
  report: Record<string, unknown>;
  _meta?: Meta;
}

/** A span of the trace of a turn: a model call, a tool call, the run itself */
export interface Span {
  id: string;
  traceId: string;
  parentId?: string;
  name: string;
  kind: 'internal' | 'client' | 'server' | 'producer' | 'consumer';
  status: 'ok' | 'error' | 'unset';
  /** Epoch milliseconds */
  startTime: number;
  /** Epoch milliseconds */
  endTime: number;
  /** Milliseconds */
  duration: number;
  attributes: Record<string, unknown>;
  events?: Array<{
    name: string;
    timestamp: number;
    attributes?: Record<string, unknown>;
  }>;
}

export interface TraceGetParams {
  turnId: string;
  _meta?: Meta;
}

export interface TraceGetResult {
  threadId: string;
  turnId: string;
  /** The spans the host keeps of the turn, oldest first */
  spans: Array<Span>;
  _meta?: Meta;
}

/** A span of a turn as it ends, sent to clients that asked for traces */
export interface TraceSpanNotification {
  threadId: string;
  turnId: string;
  span: Span;
  _meta?: Meta;
}

/** A workflow or a swarm the host can run */
export interface Runnable {
  name: string;
  description?: string;
}

export interface RunnableListParams {
  _meta?: Meta;
}

export interface RunnableListResult {
  items: Array<Runnable>;
  _meta?: Meta;
}

export interface RunnableRunParams {
  name: string;
  input?: unknown;
  _meta?: Meta;
}

export interface RunnableRunResult {
  runId: string;
  result?: unknown;
  _meta?: Meta;
}

/** An event of a workflow or swarm run, sent while `run` goes on */
export interface RunnableEventNotification {
  runId: string;
  name: string;
  event: unknown;
  _meta?: Meta;
}

/** A choice for an approval, as ACP `session/request_permission` offers it. `allow_always` saves an allow rule, `reject_always` a deny rule */
export interface PermissionOption {
  optionId: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface ApprovalToolCall {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  description: string;
  sideEffects?: Array<string>;
  /** Why the call asks: the rule, the mode or the tool's own approval setting */
  reason?: string;
  /** The `ask` rule that made the call ask, as written, such as `Bash(git push *)` */
  rule?: string;
  /** The rule an "always allow" answer (`remember: true`) saves */
  suggestedRule?: string;
  /** The permission mode of the run */
  mode?: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';
  /** The subagent the call is made in, when its approval bubbled up */
  subagent?: string;
}

/** Asks the client to decide a tool call, in the form of ACP `session/request_permission` */
export interface ApprovalRequestParams {
  threadId: string;
  turnId: string;
  toolCall: ApprovalToolCall;
  options: Array<PermissionOption>;
  _meta?: Meta;
}

/** `cancelled` leaves the call waiting: the turn ends paused */
export interface ApprovalRequestResult {
  outcome: {
    outcome: 'selected';
    optionId: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
  } | {
    outcome: 'cancelled';
  };
  /** Arguments to run an allowed call with instead */
  updatedArguments?: Record<string, unknown>;
  /** Why the call was rejected, for the model */
  reason?: string;
  _meta?: Meta;
}

export interface ThreadStartedNotification {
  thread: Thread;
  _meta?: Meta;
}

export interface ThreadArchiveNotification {
  threadId: string;
  _meta?: Meta;
}

export interface ThreadLogEntry {
  id: string;
  /** message, tool_result, or a session event such as compaction */
  type: string;
  role?: 'system' | 'user' | 'assistant' | 'tool';
  text?: string;
  parentId?: string | null;
  createdAt: string;
}

/** A change to the memory of a thread, as the adapter reports it */
export interface ThreadLogNotification {
  threadId: string;
  change: 'entry-added' | 'entry-deleted' | 'entry-redacted' | 'thread-cleared' | 'thread-deleted';
  entryId?: string;
  entry?: ThreadLogEntry;
  _meta?: Meta;
}

export interface TurnStartedNotification {
  threadId: string;
  turn: Turn;
  _meta?: Meta;
}

/** An event of the stream protocol of a turn, or of a run it delegated */
export interface TurnEventNotification {
  threadId: string;
  turnId: string;
  event: StreamEvent;
  /** The tool call of the run that delegated the run the event is of, for a subagent */
  parentToolCallId?: string;
  /** The agent of that delegated run */
  agent?: string;
  _meta?: Meta;
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: Turn;
  _meta?: Meta;
}

/** The requests a client sends, by method */
export interface AppServerMethods {
  /** Opens the session: what the client can do, answered by what the server can do and its agents */
  'initialize': { params: InitializeParams; result: InitializeResult };
  /** Starts a thread with an agent, then sends `thread/started` */
  'thread/start': { params: ThreadStartParams; result: ThreadStartResult };
  /** Opens a thread kept in memory, with the messages of its active branch */
  'thread/resume': { params: ThreadResumeParams; result: ThreadResumeResult };
  /** Forks a thread into a new one holding its branch up to an entry, then sends `thread/started` */
  'thread/fork': { params: ThreadForkParams; result: ThreadForkResult };
  /** Lists the threads a page at a time, newest first */
  'thread/list': { params: ThreadListParams; result: ThreadListResult };
  /** Archives a thread, then sends `thread/archived` */
  'thread/archive': { params: ThreadIdParams; result: ThreadResult };
  /** Takes a thread out of the archive, then sends `thread/unarchived` */
  'thread/unarchive': { params: ThreadIdParams; result: ThreadResult };
  /** Sets the permission mode of a thread, for the turn going on from its next tool call */
  'thread/setPermissionMode': { params: ThreadSetPermissionModeParams; result: ThreadResult };
  /** Starts a turn: the answer comes first, then `turn/started`, `turn/event` and `turn/completed` */
  'turn/start': { params: TurnStartParams; result: TurnStartResult };
  /** Sends a message to the turn going on */
  'turn/steer': { params: TurnSteerParams; result: TurnSteerResult };
  /** Stops the turn going on, which then completes as `interrupted` */
  'turn/interrupt': { params: TurnInterruptParams; result: TurnInterruptResult };
  /** Reviews changes in a review thread of their own, the completed turn carrying `review` */
  'review/start': { params: ReviewStartParams; result: ReviewStartResult };
  /** Searches the turns of a thread and the memory items of an agent */
  '_cogitator/memory/search': { params: MemorySearchParams; result: MemorySearchResult };
  /** Rewinds a thread to an entry, its memory and optionally its files with it */
  '_cogitator/thread/rewind': { params: ThreadRewindParams; result: ThreadRewindResult };
  /** The spans the host keeps of a turn */
  '_cogitator/trace/get': { params: TraceGetParams; result: TraceGetResult };
  /** Lists the workflows the host runs */
  '_cogitator/workflow/list': { params: RunnableListParams; result: RunnableListResult };
  /** Runs a workflow, sending `_cogitator/workflow/event` while it goes on */
  '_cogitator/workflow/run': { params: RunnableRunParams; result: RunnableRunResult };
  /** Lists the swarms the host runs */
  '_cogitator/swarm/list': { params: RunnableListParams; result: RunnableListResult };
  /** Runs a swarm, sending `_cogitator/swarm/event` while it goes on */
  '_cogitator/swarm/run': { params: RunnableRunParams; result: RunnableRunResult };
}

/** The notifications the server sends, by method */
export interface AppServerNotifications {
  'thread/started': ThreadStartedNotification;
  'thread/archived': ThreadArchiveNotification;
  'thread/unarchived': ThreadArchiveNotification;
  'thread/log': ThreadLogNotification;
  'turn/started': TurnStartedNotification;
  'turn/event': TurnEventNotification;
  'turn/completed': TurnCompletedNotification;
  '_cogitator/workflow/event': RunnableEventNotification;
  '_cogitator/swarm/event': RunnableEventNotification;
  '_cogitator/trace/span': TraceSpanNotification;
}

/** The requests the server sends to the client, by method */
export interface AppServerServerRequests {
  /** Asks the client to decide a tool call while the turn waits */
  'approval/request': { params: ApprovalRequestParams; result: ApprovalRequestResult };
}

/**
 * Moves lines between the client and an app-server, such as the stdin and stdout of
 * `cogitator app-server`: `send` writes one JSON message (the transport adds the newline),
 * `onLine` hears each line the server writes, `close` ends the connection
 */
export interface AppServerClientTransport {
  send(line: string): void;
  onLine(callback: (line: string) => void): void;
  close(): void;
}

/** An error the server answered a request with */
export class AppServerClientError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(error: { code: number; message: string; data?: unknown }) {
    super(error.message);
    this.name = 'AppServerClientError';
    this.code = error.code;
    if (error.data !== undefined) this.data = error.data;
  }
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

type IncomingMessage = Record<string, unknown>;

function isObject(value: unknown): value is IncomingMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string | number {
  return typeof value === 'string' || typeof value === 'number';
}

/**
 * A client of the Cogitator app-server: a typed method per request, `on()` for notifications
 * and `onRequest()` for what the server asks, such as `approval/request`. Call
 * `initialize()` first.
 *
 * @example
 * ```ts
 * const client = new AppServerClient(transport);
 * await client.initialize({ protocolVersion: APP_SERVER_PROTOCOL_VERSION, clientInfo: { name: 'my-app' } });
 * const { thread } = await client.threadStart();
 * client.on('turn/event', ({ event }) => {
 *   if (event.type === 'text-delta') process.stdout.write(event.delta);
 * });
 * await client.turnStart({ threadId: thread.id, input: [{ type: 'text', text: 'Hello' }] });
 * ```
 */
export class AppServerClient {
  private nextId = 1;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>();
  private readonly handlers = new Map<string, (params: unknown) => unknown>();
  private closedReason: Error | undefined;

  constructor(private readonly transport: AppServerClientTransport) {
    transport.onLine((line) => this.receive(line));
  }

  /** Whether {@link close} was called */
  get closed(): boolean {
    return this.closedReason !== undefined;
  }

  /**
   * Sends a request and resolves with its result.
   *
   * @throws AppServerClientError when the server answers with an error
   */
  request<M extends keyof AppServerMethods>(
    method: M,
    params: AppServerMethods[M]['params']
  ): Promise<AppServerMethods[M]['result']> {
    if (this.closedReason) return Promise.reject(this.closedReason);
    const id = this.nextId++;
    return new Promise<AppServerMethods[M]['result']>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (result) => resolve(result as AppServerMethods[M]['result']),
        reject,
      });
      try {
        this.transport.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Sends a notification */
  notify(method: string, params?: unknown): void {
    if (this.closedReason) throw this.closedReason;
    this.transport.send(
      JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined && { params }) })
    );
  }

  /** Hears notifications of `method`, until the returned function is called */
  on<M extends keyof AppServerNotifications>(
    method: M,
    listener: (params: AppServerNotifications[M]) => void
  ): () => void {
    const heard = (params: unknown) => listener(params as AppServerNotifications[M]);
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(heard);
    return () => {
      set.delete(heard);
    };
  }

  /** Answers the requests of `method` the server sends, until the returned function is called */
  onRequest<M extends keyof AppServerServerRequests>(
    method: M,
    handler: (
      params: AppServerServerRequests[M]['params']
    ) => AppServerServerRequests[M]['result'] | Promise<AppServerServerRequests[M]['result']>
  ): () => void {
    const handle = (params: unknown) => handler(params as AppServerServerRequests[M]['params']);
    this.handlers.set(method, handle);
    return () => {
      if (this.handlers.get(method) === handle) this.handlers.delete(method);
    };
  }

  /** Closes the connection: requests still waiting reject, the transport closes */
  close(): void {
    if (this.closedReason) return;
    this.closedReason = new Error('The app-server client is closed');
    for (const pending of this.pending.values()) pending.reject(this.closedReason);
    this.pending.clear();
    this.transport.close();
  }

  /** Opens the session: what the client can do, answered by what the server can do and its agents (`initialize`) */
  initialize(params: InitializeParams): Promise<InitializeResult> {
    return this.request('initialize', params);
  }

  /** Starts a thread with an agent, then sends `thread/started` (`thread/start`) */
  threadStart(params: ThreadStartParams = {}): Promise<ThreadStartResult> {
    return this.request('thread/start', params);
  }

  /** Opens a thread kept in memory, with the messages of its active branch (`thread/resume`) */
  threadResume(params: ThreadResumeParams): Promise<ThreadResumeResult> {
    return this.request('thread/resume', params);
  }

  /** Forks a thread into a new one holding its branch up to an entry, then sends `thread/started` (`thread/fork`) */
  threadFork(params: ThreadForkParams): Promise<ThreadForkResult> {
    return this.request('thread/fork', params);
  }

  /** Lists the threads a page at a time, newest first (`thread/list`) */
  threadList(params: ThreadListParams = {}): Promise<ThreadListResult> {
    return this.request('thread/list', params);
  }

  /** Archives a thread, then sends `thread/archived` (`thread/archive`) */
  threadArchive(params: ThreadIdParams): Promise<ThreadResult> {
    return this.request('thread/archive', params);
  }

  /** Takes a thread out of the archive, then sends `thread/unarchived` (`thread/unarchive`) */
  threadUnarchive(params: ThreadIdParams): Promise<ThreadResult> {
    return this.request('thread/unarchive', params);
  }

  /** Sets the permission mode of a thread, for the turn going on from its next tool call (`thread/setPermissionMode`) */
  threadSetPermissionMode(params: ThreadSetPermissionModeParams): Promise<ThreadResult> {
    return this.request('thread/setPermissionMode', params);
  }

  /** Starts a turn: the answer comes first, then `turn/started`, `turn/event` and `turn/completed` (`turn/start`) */
  turnStart(params: TurnStartParams): Promise<TurnStartResult> {
    return this.request('turn/start', params);
  }

  /** Sends a message to the turn going on (`turn/steer`) */
  turnSteer(params: TurnSteerParams): Promise<TurnSteerResult> {
    return this.request('turn/steer', params);
  }

  /** Stops the turn going on, which then completes as `interrupted` (`turn/interrupt`) */
  turnInterrupt(params: TurnInterruptParams): Promise<TurnInterruptResult> {
    return this.request('turn/interrupt', params);
  }

  /** Reviews changes in a review thread of their own, the completed turn carrying `review` (`review/start`) */
  reviewStart(params: ReviewStartParams): Promise<ReviewStartResult> {
    return this.request('review/start', params);
  }

  /** Searches the turns of a thread and the memory items of an agent (`_cogitator/memory/search`) */
  memorySearch(params: MemorySearchParams): Promise<MemorySearchResult> {
    return this.request('_cogitator/memory/search', params);
  }

  /** Rewinds a thread to an entry, its memory and optionally its files with it (`_cogitator/thread/rewind`) */
  threadRewind(params: ThreadRewindParams): Promise<ThreadRewindResult> {
    return this.request('_cogitator/thread/rewind', params);
  }

  /** The spans the host keeps of a turn (`_cogitator/trace/get`) */
  traceGet(params: TraceGetParams): Promise<TraceGetResult> {
    return this.request('_cogitator/trace/get', params);
  }

  /** Lists the workflows the host runs (`_cogitator/workflow/list`) */
  workflowList(params: RunnableListParams = {}): Promise<RunnableListResult> {
    return this.request('_cogitator/workflow/list', params);
  }

  /** Runs a workflow, sending `_cogitator/workflow/event` while it goes on (`_cogitator/workflow/run`) */
  workflowRun(params: RunnableRunParams): Promise<RunnableRunResult> {
    return this.request('_cogitator/workflow/run', params);
  }

  /** Lists the swarms the host runs (`_cogitator/swarm/list`) */
  swarmList(params: RunnableListParams = {}): Promise<RunnableListResult> {
    return this.request('_cogitator/swarm/list', params);
  }

  /** Runs a swarm, sending `_cogitator/swarm/event` while it goes on (`_cogitator/swarm/run`) */
  swarmRun(params: RunnableRunParams): Promise<RunnableRunResult> {
    return this.request('_cogitator/swarm/run', params);
  }

  private receive(line: string): void {
    if (line.trim() === '') return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    for (const message of Array.isArray(value) ? value : [value]) {
      if (isObject(message)) this.dispatch(message);
    }
  }

  private dispatch(message: IncomingMessage): void {
    const method = message.method;
    if (typeof method !== 'string') {
      if (!isId(message.id)) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (isObject(message.error)) {
        const error = message.error;
        pending.reject(
          new AppServerClientError({
            code: typeof error.code === 'number' ? error.code : APP_SERVER_ERROR_CODES.internalError,
            message: typeof error.message === 'string' ? error.message : 'Unknown error',
            data: error.data,
          })
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (!isId(message.id)) {
      for (const listener of [...(this.listeners.get(method) ?? [])]) listener(message.params);
      return;
    }
    void this.answer(message.id, method, message.params);
  }

  private async answer(id: string | number, method: string, params: unknown): Promise<void> {
    const handler = this.handlers.get(method);
    let reply: Record<string, unknown>;
    if (!handler) {
      reply = {
        jsonrpc: '2.0',
        id,
        error: { code: APP_SERVER_ERROR_CODES.methodNotFound, message: 'Method not found: ' + method },
      };
    } else {
      try {
        reply = { jsonrpc: '2.0', id, result: (await handler(params)) ?? null };
      } catch (error) {
        reply = {
          jsonrpc: '2.0',
          id,
          error: {
            code: APP_SERVER_ERROR_CODES.internalError,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }
    if (!this.closedReason) this.transport.send(JSON.stringify(reply));
  }
}
