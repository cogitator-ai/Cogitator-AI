/**
 * What the studio's three parts say to each other: the runtime host (a child
 * process that runs the project), the server, and the UI in the browser. The
 * file has no imports, so the UI bundle can share it.
 */

export interface ToolInfo {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: unknown;
  requiresApproval: boolean;
}

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
}

export interface ForkRequest {
  step: number;
  input?: string;
  context?: string;
  toolResults?: Record<string, unknown>;
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
  | { type: 'swarm.event'; runId: string; event: SwarmEventRecord };

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
  | { type: 'thread'; thread: ThreadRecord };

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
    }
  | { type: 'workflow.run'; requestId: string; workflow: string; input: unknown }
  | { type: 'swarm.run'; requestId: string; swarm: string; input: string }
  | { type: 'workflow.rerun'; requestId: string; run: RunRecord; fromNode: string };

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
  | { type: 'response'; requestId: string; ok: true; data: unknown }
  | { type: 'response'; requestId: string; ok: false; error: string };
