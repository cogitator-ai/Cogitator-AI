/**
 * What the studio's three parts say to each other: the runtime host (a child
 * process that runs the project), the server, and the UI in the browser. The
 * file imports types only, so the UI bundle can share it.
 */

import type {
  InboxItem,
  InboxItemKind,
  InboxItemStatus,
  MemoryEntryType,
  Message,
  RoutineOverlap,
  RoutineRunRecord,
  ToolAppCallResult,
  ToolAppResource,
  ToolAppVisibility,
  ToolCall,
  ToolResult,
  TriggerFireResult,
  TriggerKind,
} from '@cogitator-ai/types';

export interface ToolInfo {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: unknown;
  requiresApproval: boolean;
  /** The MCP App the studio shows for the tool's calls */
  app?: ToolAppInfo;
}

/** A tool's MCP App, as the registry describes it */
export interface ToolAppInfo {
  /** The `ui://` resource of the app */
  resourceUri: string;
  /** Who may call the tool: the agent (`model`), its app (`app`) */
  visibility?: ToolAppVisibility[];
}

/** An MCP App as the UI frames it: what the app asks of its frame, without its HTML */
export type ToolAppFrameInfo = Omit<ToolAppResource, 'html'>;

/** What a tool call an MCP App asked for came to: its result, or the approval it waits for */
export type ToolAppCallOutcome =
  { status: 'done'; result: ToolAppCallResult } | { status: 'approval'; tool: string };

export interface AgentInfo {
  /** The key the registry exports it under. */
  key: string;
  name: string;
  description?: string;
  /** `provider/model`, absent when the agent takes the runtime's default model. */
  model?: string;
  instructions: string;
  tools: ToolInfo[];
}

export interface WorkflowEdgeInfo {
  type: string;
  from: string;
  to: string[];
}

export interface WorkflowInfo {
  key: string;
  name: string;
  entryPoint: string;
  nodes: string[];
  edges: WorkflowEdgeInfo[];
  /** The state the workflow starts from, as JSON, the default input of a run. */
  initialState: unknown;
}

export interface SwarmInfo {
  key: string;
  name: string;
  strategy: string;
  agents: string[];
  /** The lead of a team swarm (its supervisor) */
  lead?: string;
  /** The members of a team swarm (its workers) */
  members?: string[];
}

export interface RegistryInfo {
  /** The runtime's `llm.defaultModel`, which agents without a model of their own run on. */
  defaultModel?: string;
  agents: AgentInfo[];
  workflows: WorkflowInfo[];
  swarms: SwarmInfo[];
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  /** USD, as the provider reported it or priced from the model registry. */
  cost: number;
  /** Whether `cost` is known: false when no model of the run has a price. */
  priced?: boolean;
  duration: number;
}

/** A span of a run as the trace shows it, with its own cost when it is a model call. */
export interface SpanRecord {
  id: string;
  parentId?: string;
  name: string;
  kind: 'llm' | 'tool' | 'agent' | 'handoff' | 'other';
  status: 'ok' | 'error' | 'unset';
  startTime: number;
  endTime: number;
  duration: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** USD of a model call, `undefined` when the model's price is unknown. */
  cost?: number;
  attributes: Record<string, unknown>;
}

/** How a tool call is shown, as the tool presents it: a label, an icon name and a detail line. */
export interface ToolPresentationRecord {
  label: string;
  icon?: string;
  detail?: string;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: unknown;
  result?: unknown;
  error?: string;
  presentation?: ToolPresentationRecord;
  /** Data the tool gave the application only, never sent to the model. */
  details?: unknown;
  /** What the running tool reported last with `context.update()`. */
  progress?: unknown;
  approval?: ApprovalRecord;
}

/** The approval a tool call waits for, or how it was answered. */
export interface ApprovalRecord {
  id: string;
  status: 'waiting' | 'approved' | 'rejected';
  /** Why the call was rejected, as the model reads it. */
  reason?: string;
  /** Why the call asks: the rule, the permission mode or the tool's own approval setting. */
  askReason?: string;
  /** The `ask` rule that made the call ask, as written. */
  rule?: string;
  /** The rule an "always allow" answer saves, so calls like this one run without asking. */
  suggestedRule?: string;
  /** The rule the runtime saved for an "always allow" answer, and where, once it saved it. */
  remembered?: { rule: string; layer: 'session' | 'local' | 'project' | 'user' };
}

export type RunStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'stopped';

/** An item of the todo list an agent keeps with `write_todos`. */
export interface TodoRecord {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface WorkflowNodeRecord {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt?: number;
  duration?: number;
  output?: unknown;
  error?: string;
}

/** An agent of a team swarm as its graph shows it. */
export interface TeamMemberRecord {
  name: string;
  role: 'lead' | 'member';
  status: 'idle' | 'working' | 'stopped' | 'failed';
  turns: number;
  /** Why it takes the turn it is in, or took its last one. */
  reason?: string;
  /** The task it works on. */
  currentTask?: string;
  error?: string;
}

/** A task of the shared task list of a team swarm. */
export interface TeamTaskRecord {
  id: string;
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed';
  owner?: string;
  dependsOn: string[];
  createdBy: string;
  result?: string;
  note?: string;
}

/** A message between agents of a team, written into the mailboxes of `to`. */
export interface TeamMessageRecord {
  id: string;
  from: string;
  to: string[];
  broadcast: boolean;
  content: string;
  at: number;
}

/** The lead (or the team's setup, `system`) gave a task to a member. */
export interface TeamAssignmentRecord {
  taskId: string;
  by: string;
  to: string;
  at: number;
}

/** What a run of a team swarm did, built from its events while it runs. */
export interface TeamRecord {
  lead: string;
  members: TeamMemberRecord[];
  tasks: TeamTaskRecord[];
  messages: TeamMessageRecord[];
  assignments: TeamAssignmentRecord[];
  /** How the run ended, once it ended. */
  stopReason?: string;
}

/** A run the studio keeps: an agent run, a workflow run, a swarm run, or a fork of an agent run. */
export interface RunRecord {
  id: string;
  kind: 'agent' | 'workflow' | 'fork' | 'swarm';
  /** Registry key of the agent, workflow or swarm. */
  target: string;
  /** The agent's own name, which nested runs are found by. */
  agentName?: string;
  threadId?: string;
  input: string;
  output?: string;
  reasoning?: string;
  status: RunStatus;
  /**
   * Bumped on every change of the run, so a client keeps the newest copy of
   * it whatever order snapshots and events reach it in.
   */
  revision: number;
  error?: string;
  startedAt: number;
  endedAt?: number;
  model?: string;
  toolCalls: ToolCallRecord[];
  spans: SpanRecord[];
  usage?: UsageInfo;
  /** Runs of agents this run's tools started, in the order they started. */
  children: string[];
  parentRunId?: string;
  /** The tool call of the parent run that started this run. */
  parentToolCallId?: string;
  /** Tool-call steps a fork can start from: 0 is before the first tool call. */
  steps?: StepRecord[];
  forkOf?: ForkOrigin;
  /** Runs forked from this one. */
  forks: string[];
  /** Where the run wrote in the memory of its thread. */
  memory?: MemoryPlace;
  nodes?: WorkflowNodeRecord[];
  /** The agent's todo list as `write_todos` last wrote it in the run. */
  todos?: TodoRecord[];
  /** The agents, task list and messages of a team swarm run. */
  team?: TeamRecord;
  /** The workflow manager's id of the run, which a rerun starts from. */
  workflowRunId?: string;
  rerunOf?: { runId: string; fromNode: string };
}

export interface StepRecord {
  index: number;
  checkpointId: string;
  label: string;
  /** Tool calls made before this step. */
  toolCalls: Array<{ name: string; result: unknown }>;
}

export interface ForkOrigin {
  runId: string;
  step: number;
  input?: string;
  context?: string;
  toolResults?: Record<string, unknown>;
}

/**
 * Where a run wrote in the memory of a thread: its entries follow `branchPoint`, the entry it went
 * on from (`null` at the root), and end at `leafId`.
 */
export interface MemoryPlace {
  threadId: string;
  branchPoint: string | null;
  leafId?: string;
}

/** An entry of a thread's memory, as the tree of the thread shows it. */
export interface TreeEntry {
  id: string;
  /** The entry it follows, `null` for a root. Missing when the memory keeps no tree. */
  parentId?: string | null;
  /** `message`, `tool_result`, or an event such as `model_change`, `approval` or `interrupt`. */
  type: string;
  role?: string;
  /** The text of the entry, cut short. */
  text: string;
  /** Names of the tools an assistant message called. */
  toolCalls?: string[];
  /** What an event entry recorded. */
  event?: unknown;
  createdAt: number;
  /** The run that wrote it, when the studio knows. */
  runId?: string;
  /** Whether it is a user message that names a file checkpoint, files a rewind can restore. */
  checkpoint?: boolean;
  /**
   * The files a rewind or a fork to it restores, as the runtime picks the checkpoint: `exact`,
   * as they were there, or `before`, as they were before its turn. Missing when there are none
   */
  files?: 'exact' | 'before';
}

/** Every branch of a thread's memory, with the one its next message goes on. */
export interface ThreadTree {
  threadId: string;
  activeLeafId?: string;
  /** Oldest first. */
  entries: TreeEntry[];
  /** Whether older entries were left out. */
  truncated: boolean;
  /** Whether the memory keeps entries as a tree, or only as a list. */
  branching: boolean;
}

/** An agent, workflow or swarm with what its runs did, for the overview. */
export interface TargetStats {
  target: string;
  kind: 'agent' | 'workflow' | 'swarm';
  /** Every run of it, the ones agent tools started included. */
  runs: number;
  failed: number;
  cost: number;
  priced: boolean;
  lastRunAt: number;
}

/** Aggregates over every run the studio keeps. */
export interface StudioStats {
  /** Runs started from the studio, nested ones not counted. */
  runs: number;
  byStatus: Record<RunStatus, number>;
  /** USD of every run, nested ones included. */
  cost: number;
  /** Whether any run had a known price. */
  priced: boolean;
  inputTokens: number;
  outputTokens: number;
  /** Wall time in ms of the finished runs started from the studio, `null` before the first. */
  duration: { p50: number; p95: number } | null;
  /** Runs started from the studio per local day, oldest first, today last. */
  activity: Array<{ day: number; runs: number; failed: number }>;
  /** Busiest first. */
  targets: TargetStats[];
}

/** A conversation with an agent across runs. */
export interface ThreadRecord {
  id: string;
  agent: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  runs: string[];
  /** Runs whose entries a rewind took off the active branch, kept to show faded. */
  rewoundRuns?: string[];
  /** The thread and entry this thread was forked from. */
  forkOf?: { threadId: string; entryId: string };
  /** The conversation a forked thread starts from, shown above its own turns. */
  base?: HistoryMessage[];
  /**
   * The thread as the studio's own memory last had it, its metadata and its active branch entry
   * by entry with ids and metadata, replayed into a fresh memory after a restart.
   */
  replay?: ThreadReplay;
}

/**
 * A thread of the studio's own memory as a fresh memory gets it back: its metadata (where it
 * was forked from among it, which file rewinds check) and its whole tree of entries.
 */
export interface ThreadReplay {
  metadata: Record<string, unknown>;
  /**
   * Every entry of the thread, every branch, oldest first: the entries forks of the thread
   * were copied from stay, also once a rewind took them off its active branch.
   */
  entries: ReplayEntry[];
  /** The entry the active branch ends at. */
  activeLeafId?: string;
}

/** A thread a forked thread comes from, replayed before it so the fork's provenance resolves. */
export interface ThreadLineage {
  threadId: string;
  /** The registry key of the thread's agent. */
  agent: string;
  history: HistoryMessage[];
  replay?: ThreadReplay;
}

/** An entry of a thread's active branch, as a fresh memory gets it back after a restart. */
export interface ReplayEntry {
  id: string;
  /** The entry it follows, `null` for a root. */
  parentId: string | null;
  type?: MemoryEntryType;
  message: Message;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  metadata?: Record<string, unknown>;
  event?: Record<string, unknown>;
}

/** What a file restore of a rewind or a fork changed, or would change in a dry run. */
export interface FileRestoreSummary {
  snapshotId: string;
  dryRun: boolean;
  /** Files written back as the checkpoint has them. */
  restored: string[];
  /** Files removed, as the checkpoint did not have them. */
  deleted: string[];
  unchanged: number;
  /** Paths left as they are, such as files the checkpoint skipped. */
  kept: string[];
  /** With a dry run: whether commands the workspace runs would refuse the restore now. */
  busy?: boolean;
  /** The snapshot of the files from right before the restore, to undo it. */
  safetySnapshotId?: string;
  /** The user message whose checkpoint it is. */
  entryId: string;
  /** Whether the checkpoint holds the files at that very point, not before the turn it is in. */
  exact: boolean;
  workspaceId: string;
}

/** What a rewind of a thread changed, or would change in a dry run. */
export interface RewindSummary {
  threadId: string;
  toEntryId: string;
  dryRun: boolean;
  conversation: {
    /** Whether the active leaf moved back. */
    rewound: boolean;
    /** The entries that leave the active branch, oldest first. */
    cut: string[];
    previousLeafId?: string;
  };
  /** Memory items that stood only on the entries cut off. */
  staleItems: number;
  files?: FileRestoreSummary;
  runs: {
    /** Runs going on in the thread when the rewind began. */
    going: string[];
    /** Runs the rewind aborted, with `force`. */
    interrupted: string[];
    /** Whether the paused run of the thread is dropped. */
    paused: boolean;
    /** Durable runs of the thread dropped. */
    durable: string[];
  };
  /** The thread after the rewind, when the studio keeps its own memory. */
  replay?: ThreadReplay;
}

/** A thread forked from another at an entry. */
export interface ForkSummary {
  threadId: string;
  /** Snapshots copied into the fork's workspace. */
  snapshotsCopied: string[];
  files?: FileRestoreSummary;
  /** The user and assistant messages of the forked branch, oldest first. */
  base: HistoryMessage[];
  /** The new thread, when the studio keeps its own memory. */
  replay?: ThreadReplay;
}

/** What a fork with its files would restore, made without a thread. */
export interface ForkPreview {
  dryRun: true;
  /** Snapshots the fork would copy into its workspace. */
  snapshotsCopied: string[];
  files?: FileRestoreSummary;
  /** Runs in the thread or the workspace that a fork with files has to wait for, or stop. */
  going: string[];
}

/** What a rewind is asked to do. */
export interface RewindRequest {
  entryId: string;
  files?: boolean;
  memory?: boolean;
  dryRun?: boolean;
  force?: boolean;
}

/** What a fork of a thread is asked to do. */
export interface ThreadForkRequest {
  entryId: string;
  files?: boolean;
  /** Only say what a fork with files would restore, make no thread. */
  dryRun?: boolean;
  /** Stop the runs in the way of a fork with files first. */
  force?: boolean;
}

export interface ForkRequest {
  step: number;
  input?: string;
  context?: string;
  toolResults?: Record<string, unknown>;
}

/** A Studio panel a plugin adds: a page shown in a sandboxed frame. */
export interface PluginPanelRecord {
  /** Unique within the plugin. */
  id: string;
  title: string;
  description?: string;
  /** Name of a Lucide icon. */
  icon?: string;
}

/** Something found wrong with a plugin, `error` kept it or one of its parts from loading. */
export interface PluginDiagnosticRecord {
  level: 'error' | 'warning';
  message: string;
  /** The file it is about. */
  path?: string;
}

/** What a loaded plugin added, by kind. */
export interface PluginContributionsRecord {
  tools: string[];
  skills: string[];
  agents: string[];
  commands: string[];
  /** Hook handlers, counted. */
  hooks: number;
  mcpServers: string[];
  llmBackends: string[];
  /** Run middleware, counted. */
  middleware: number;
  panels: PluginPanelRecord[];
  /** Routines, by id with `plugin:`. */
  routines: string[];
}

/**
 * Whether a plugin works: `active` (its generation is loaded), `disabled` (switched off),
 * `blocked` (a dependency is missing, off, of a wrong version or in a cycle), `failed` (it did
 * not load, see `error`), `unloaded` (the runtime's plugins were disposed).
 */
export type PluginStatusRecord = 'active' | 'disabled' | 'blocked' | 'failed' | 'unloaded';

/** A plugin of the project's runtime, as the plugins page shows it. */
export interface PluginRecord {
  /** `name@marketplace`, `name@inline` for a folder of the project, `name@code` for one in code. */
  id: string;
  name: string;
  displayName?: string;
  version?: string;
  description?: string;
  origin: 'core' | 'code' | 'dir' | 'installed';
  /** The manifest's format: Claude Code's, Cogitator's extension over it, or code. */
  format: 'claude' | 'cogitator' | 'code';
  root?: string;
  enabled: boolean;
  /** What decided `enabled`: a settings layer (`project`, `user` and the rest), or `default`. */
  enabledBy: string;
  status: PluginStatusRecord;
  /** Why it failed or is blocked. */
  error?: string;
  /** How many times it loaded: a reload that fails keeps the generation that works. */
  generation: number;
  /** Whether it runs in a process of its own. */
  isolated: boolean;
  dependencies: Array<{ name: string; marketplace?: string; version?: string }>;
  /** The permission rules it runs under, when it declares any. */
  permissions?: { allow: string[]; deny: string[] };
  contributions: PluginContributionsRecord;
  diagnostics: PluginDiagnosticRecord[];
}

/** The plugins of the project's runtime. */
export interface PluginsState {
  /** Whether the project's runtime has plugins at all: false with a core older than them. */
  available: boolean;
  /**
   * Whether the project configures `experimental_plugins`. Without it the runtime has only the
   * core's own plugin, and nothing can be reloaded, enabled or disabled.
   */
  configured: boolean;
  plugins: PluginRecord[];
}

/** How a reload went for one plugin. */
export interface PluginReloadRecord {
  id: string;
  ok: boolean;
  /** The generation that serves now: the new one, or the old one after a failure. */
  generation: number;
  error?: string;
}

/** What a reload, an enable or a disable did, with the plugins after it. */
export interface PluginActionResult {
  results: PluginReloadRecord[];
  plugins: PluginsState;
}

/** What a panel handler returned, as JSON. */
export interface PluginPanelCallResult {
  result: unknown;
}

/** A trigger of a routine, as the schedules page shows it, without its secrets. */
export interface TriggerRecord {
  /** `<routineId>.<triggerId>`, the id `POST /api/triggers/:id/fire` takes. */
  id: string;
  routineId: string;
  kind: TriggerKind;
  enabled: boolean;
  /** The spec without its secrets: `cron` and `timezone` of a schedule, `events` and the rest. */
  spec: Record<string, unknown>;
  fireCount: number;
  lastFiredAt?: number;
  lastError?: string;
  /** The next occurrence of a schedule. */
  nextFireAt?: number;
  /** The schedule entry of a cron trigger. */
  scheduleId?: string;
}

/** A routine of the project's runtime with its triggers and the runs of it going on. */
export interface RoutineRecord {
  id: string;
  name?: string;
  description?: string;
  /** The task each firing starts a session with. */
  prompt: string;
  target: { kind: 'agent' | 'workflow'; name: string };
  enabled: boolean;
  overlap: RoutineOverlap;
  maxConcurrent?: number;
  /** `new` for a thread per firing, else the thread every firing continues. */
  session: string;
  /** Where it is defined: in code, in the routine store or by a plugin. */
  origin: 'code' | 'store' | 'plugin';
  plugin?: string;
  triggers: TriggerRecord[];
  /** Runs of it going on. */
  active: number;
  /** Firings waiting for a run to end. */
  queued: number;
}

/** A pending entry of the schedules store the trigger manager runs. */
export interface ScheduleRecord {
  id: string;
  name?: string;
  type: 'fixed' | 'dynamic' | 'cron' | 'recurring';
  cron?: string;
  timezone?: string;
  /** Ms between the runs of a recurring entry. */
  interval?: number;
  firesAt: number;
  enabled: boolean;
  lastRunAt?: number;
  lastRunStatus?: 'ok' | 'error' | 'skipped';
  lastError?: string;
  consecutiveErrors?: number;
  /** What it runs: a trigger of a routine, or a task an agent gave itself. */
  owner:
    | { kind: 'routine'; routineId: string; triggerId: string }
    | { kind: 'agent'; agent: string; description?: string; threadId?: string };
}

/** The routines, schedules and recent history of the project's runtime. */
export interface TriggersState {
  /**
   * Whether the runtime has a trigger manager: false without `experimental_triggers` in its
   * config, or with a core from before triggers.
   */
  configured: boolean;
  /** Whether the manager polls its schedules: the studio starts it only when asked to. */
  started: boolean;
  routines: RoutineRecord[];
  schedules: ScheduleRecord[];
  /** The latest firings, newest first. */
  history: RoutineRunRecord[];
}

/** Which inbox items a listing returns. */
export interface InboxQuery {
  /** Every status when left out. */
  status?: InboxItemStatus[];
  /** Every kind when left out. */
  kind?: InboxItemKind[];
  limit?: number;
}

/** An inbox item with the pages of the studio it links to. */
export interface InboxItemRecord extends InboxItem {
  /** The studio's page of its run and its thread's chat, when the studio keeps them. */
  links?: { run?: string; thread?: { agent: string; threadId: string } };
}

/** The inbox of the project's runtime. */
export interface InboxListing {
  /** Whether the runtime has a trigger manager, and so an inbox. */
  configured: boolean;
  /** Newest first. */
  items: InboxItemRecord[];
  /** Unread items, counted up to `INBOX_UNREAD_CAP`: more than that are `INBOX_UNREAD_CAP + 1`. */
  unread: number;
}

/** How far the unread items of the inbox are counted. */
export const INBOX_UNREAD_CAP = 999;

/** What happened to an inbox item. */
export type InboxChangeRecord =
  | { type: 'added'; item: InboxItem }
  | { type: 'updated'; item: InboxItem }
  | { type: 'deleted'; id: string };

/** A decision on a tool call a routine's run waits on. */
export interface InboxDecision {
  approved: boolean;
  /** Why it was rejected, as the model reads it. */
  reason?: string;
}

/**
 * An answer to an inbox item that waits for a person: `decisions` for an agent's approvals by tool
 * call id, `responses` for its questions by interrupt id, `decision` for a workflow's approval.
 */
export interface InboxAnswer {
  decisions?: Record<string, InboxDecision>;
  defaultDecision?: InboxDecision;
  responses?: Record<string, unknown>;
  decision?: unknown;
  respondedBy?: string;
}

/** What `POST /api/approvals/:id` did: answered a chat's approval, a routine's, or nothing. */
export interface ApprovalOutcome {
  decided: boolean;
  /** The inbox item a routine's approval was answered through. */
  inboxItemId?: string;
  /** How the routine's run went on. */
  result?: TriggerFireResult;
}

/** What the host reports while it runs things. */
export type HostEvent =
  | {
      type: 'run.started';
      runId: string;
      kind: RunRecord['kind'];
      target: string;
      agentName?: string;
      input: string;
      threadId?: string;
      model?: string;
      rootRunId: string;
      startedAt: number;
      forkOf?: ForkOrigin;
      rerunOf?: { runId: string; fromNode: string };
    }
  | { type: 'run.token'; runId: string; text: string }
  | { type: 'run.reasoning'; runId: string; text: string }
  | { type: 'run.tool.call'; runId: string; call: { id: string; name: string; arguments: unknown } }
  | {
      type: 'run.tool.result';
      runId: string;
      callId: string;
      result: unknown;
      error?: string;
      details?: unknown;
      presentation?: ToolPresentationRecord;
    }
  | {
      type: 'run.tool.update';
      runId: string;
      callId: string;
      content?: unknown;
      details?: unknown;
      presentation?: ToolPresentationRecord;
    }
  | {
      type: 'run.approval';
      runId: string;
      approvalId: string;
      callId: string;
      toolName: string;
      arguments: unknown;
      description: string;
      askReason?: string;
      rule?: string;
      suggestedRule?: string;
    }
  | {
      type: 'run.approval.decided';
      runId: string;
      approvalId: string;
      approved: boolean;
      reason?: string;
    }
  | {
      type: 'run.approval.remembered';
      runId: string;
      callId: string;
      rule: string;
      layer: 'session' | 'local' | 'project' | 'user';
    }
  | { type: 'run.span'; runId: string; span: RawSpan }
  | { type: 'run.todos'; runId: string; todos: TodoRecord[] }
  | {
      type: 'run.completed';
      runId: string;
      output: string;
      usage: UsageInfo;
      endedAt: number;
      /** Every tool call of the run with its result, also those no callback reported. */
      toolCalls?: Array<{
        id: string;
        name: string;
        arguments: unknown;
        result?: unknown;
        error?: string;
      }>;
      steps?: StepRecord[];
      workflowRunId?: string;
      memory?: MemoryPlace;
    }
  | { type: 'run.failed'; runId: string; error: string; endedAt: number; stopped: boolean }
  | {
      type: 'workflow.node';
      runId: string;
      node: string;
      status: WorkflowNodeRecord['status'];
      at: number;
      duration?: number;
      output?: unknown;
      error?: string;
    }
  | { type: 'swarm.event'; runId: string; event: SwarmEventRecord }
  | { type: 'thread.replay'; threadId: string; replay: ThreadReplay };

/** An event of a swarm run as the swarm emitted it (`team:task-claimed` and the rest). */
export interface SwarmEventRecord {
  type: string;
  agentName?: string;
  data?: unknown;
  at: number;
}

/** A span as the runtime reports it. */
export interface RawSpan {
  id: string;
  traceId: string;
  parentId?: string;
  name: string;
  status: 'ok' | 'error' | 'unset';
  startTime: number;
  endTime: number;
  duration: number;
  attributes: Record<string, unknown>;
}

/** What the server pushes to the UI over server-sent events. */
export type StudioEvent =
  | { type: 'host'; status: HostStatus }
  | { type: 'run'; run: RunRecord }
  | { type: 'token'; runId: string; text: string; revision: number }
  | { type: 'reasoning'; runId: string; text: string; revision: number }
  | { type: 'thread'; thread: ThreadRecord }
  | { type: 'plugins'; plugins: PluginsState }
  | { type: 'inbox'; change: InboxChangeRecord; unread: number };

export type HostStatus =
  | { state: 'starting' }
  | { state: 'ready'; registry: RegistryInfo; memory: 'project' | 'studio'; loadedAt: number }
  | { state: 'failed'; error: string }
  | { state: 'restarting'; reason: string };

/** Requests the server sends the host. */
export type HostRequest =
  | {
      type: 'chat';
      requestId: string;
      agent: string;
      input: string;
      threadId: string;
      history: HistoryMessage[];
      replay?: ThreadReplay;
      /** The threads it was forked from, oldest first, to replay before it. */
      lineage?: ThreadLineage[];
    }
  | { type: 'stop'; requestId: string; runId: string }
  | {
      type: 'approve';
      requestId: string;
      approvalId: string;
      approved: boolean;
      reason?: string;
      /** Approve calls like this one from now on: save the approval's `suggestedRule`. */
      remember?: boolean;
    }
  | { type: 'fork'; requestId: string; run: RunRecord; fork: ForkRequest }
  | {
      type: 'thread.tree';
      requestId: string;
      threadId: string;
      agent: string;
      history: HistoryMessage[];
      replay?: ThreadReplay;
      /** The threads it was forked from, oldest first, to replay before it. */
      lineage?: ThreadLineage[];
    }
  | ({
      type: 'thread.rewind';
      requestId: string;
      threadId: string;
      agent: string;
      history: HistoryMessage[];
      replay?: ThreadReplay;
      /** The threads it was forked from, oldest first, to replay before it. */
      lineage?: ThreadLineage[];
    } & RewindRequest)
  | ({
      type: 'thread.fork';
      requestId: string;
      threadId: string;
      agent: string;
      newThreadId: string;
      history: HistoryMessage[];
      replay?: ThreadReplay;
      /** The threads it was forked from, oldest first, to replay before it. */
      lineage?: ThreadLineage[];
    } & ThreadForkRequest)
  | { type: 'workflow.run'; requestId: string; workflow: string; input: unknown }
  | { type: 'swarm.run'; requestId: string; swarm: string; input: string }
  | { type: 'workflow.rerun'; requestId: string; run: RunRecord; fromNode: string }
  | { type: 'plugins.list'; requestId: string }
  | { type: 'plugins.reload'; requestId: string; plugin: string }
  | { type: 'plugins.enable'; requestId: string; plugin: string; enabled: boolean }
  | { type: 'plugins.panel'; requestId: string; plugin: string; panel: string }
  | {
      type: 'plugins.call';
      requestId: string;
      plugin: string;
      panel: string;
      method: string;
      params?: unknown;
    }
  | { type: 'tools.app'; requestId: string; agent: string; tool: string }
  | {
      type: 'tools.app.call';
      requestId: string;
      agent: string;
      /** The tool whose app asks */
      tool: string;
      /** The tool the app calls */
      name: string;
      arguments: Record<string, unknown>;
      /** The person allowed the call, which the app's server marks as needing approval */
      approved?: boolean;
    }
  | { type: 'triggers.state'; requestId: string }
  | { type: 'triggers.start'; requestId: string }
  | { type: 'triggers.stop'; requestId: string }
  | { type: 'triggers.fire'; requestId: string; trigger: string; text?: string }
  | {
      type: 'schedules.run' | 'schedules.pause' | 'schedules.resume';
      requestId: string;
      /** A schedule entry, or for pause and resume also a trigger or a routine. */
      schedule: string;
    }
  | { type: 'inbox.list'; requestId: string; query: InboxQuery }
  | { type: 'inbox.update'; requestId: string; item: string; status: InboxItemStatus }
  | { type: 'inbox.respond'; requestId: string; item: string; answer: InboxAnswer }
  | {
      type: 'inbox.approve';
      requestId: string;
      /** A tool call id or a workflow's approval id of an inbox item, or the item's id. */
      approvalId: string;
      approved: boolean;
      reason?: string;
    };

/** A message of a thread, replayed into a fresh memory when the host restarts. */
export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Messages from the host to the server. */
export type HostMessage =
  | { type: 'ready'; registry: RegistryInfo; memory: 'project' | 'studio' }
  | { type: 'load-failed'; error: string }
  | { type: 'event'; event: HostEvent }
  | { type: 'plugins'; plugins: PluginsState }
  | { type: 'inbox'; change: InboxChangeRecord; unread: number }
  | { type: 'response'; requestId: string; ok: true; data: unknown }
  | {
      type: 'response';
      requestId: string;
      ok: false;
      error: string;
      /** The code of a runtime error, such as `THREAD_BUSY` or `VALIDATION_ERROR`. */
      code?: string;
    };
