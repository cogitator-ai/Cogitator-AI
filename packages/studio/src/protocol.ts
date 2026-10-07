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

export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: unknown;
  result?: unknown;
  error?: string;
  approval?: { id: string; status: 'waiting' | 'approved' | 'rejected'; reason?: string };
}

export type RunStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'stopped';

export interface WorkflowNodeRecord {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt?: number;
  duration?: number;
  output?: unknown;
  error?: string;
}

/** A run the studio keeps: an agent run, a workflow run, or a fork of an agent run. */
export interface RunRecord {
  id: string;
  kind: 'agent' | 'workflow' | 'fork';
  /** Registry key of the agent or workflow. */
  target: string;
  /** The agent's own name, which nested runs are found by. */
  agentName?: string;
  threadId?: string;
  input: string;
  output?: string;
  reasoning?: string;
  status: RunStatus;
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
  nodes?: WorkflowNodeRecord[];
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

/** An agent or workflow with what its runs did, for the overview. */
export interface TargetStats {
  target: string;
  kind: 'agent' | 'workflow';
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
  | { type: 'run.tool.result'; runId: string; callId: string; result: unknown; error?: string }
  | {
      type: 'run.approval';
      runId: string;
      approvalId: string;
      callId: string;
      toolName: string;
      arguments: unknown;
      description: string;
    }
  | {
      type: 'run.approval.decided';
      runId: string;
      approvalId: string;
      approved: boolean;
      reason?: string;
    }
  | { type: 'run.span'; runId: string; span: RawSpan }
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
    };

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
  | { type: 'token'; runId: string; text: string }
  | { type: 'reasoning'; runId: string; text: string }
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
  | { type: 'approve'; requestId: string; approvalId: string; approved: boolean; reason?: string }
  | { type: 'fork'; requestId: string; run: RunRecord; fork: ForkRequest }
  | { type: 'workflow.run'; requestId: string; workflow: string; input: unknown }
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
