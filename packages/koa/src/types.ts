import type { IncomingMessage } from 'http';
import type { Context } from 'koa';
import type { Cogitator, Agent } from '@cogitator-ai/core';
import type {
  AgentRunResponse,
  AnonymousPolicy,
  AuthorizeThread,
  ContextPolicy,
  PendingApproval,
  ReadinessCheckStatus,
  ReadinessResponse,
  RunLimits,
  ThreadMessageRole,
  WorkflowResumeRequestBody,
  WorkflowRunRequestBody,
} from '@cogitator-ai/server-shared';
import type {
  CheckpointStore,
  Message,
  ToolCall,
  ToolResult,
  RunResult,
  Workflow,
  WorkflowResult,
  WorkflowState,
  SwarmConfig,
  SwarmResult,
  SwarmRunOptions,
  StreamingWorkflowEvent,
  SwarmEvent,
  SwarmMessage,
  ToolApprovalDecision,
} from '@cogitator-ai/types';

export type {
  Message,
  ToolCall,
  ToolResult,
  RunResult,
  Workflow,
  WorkflowResult,
  WorkflowState,
  SwarmConfig,
  SwarmResult,
  SwarmRunOptions,
  StreamingWorkflowEvent,
  SwarmEvent,
  SwarmMessage,
  ToolApprovalDecision,
  PendingApproval,
  ReadinessResponse,
  ReadinessCheckStatus,
  RunLimits,
  AnonymousPolicy,
  AuthorizeThread,
};

export interface AuthContext {
  userId?: string;
  roles?: string[];
  permissions?: string[];
  metadata?: Record<string, unknown>;
}

export type AuthFunction = (
  ctx: Context
) => Promise<AuthContext | undefined> | AuthContext | undefined;

export type WebSocketAuthFunction = (
  req: IncomingMessage
) => Promise<AuthContext | undefined> | AuthContext | undefined;

/** Builds the `deps` an agent run of a request passes to its tools (`RunOptions.deps`) */
export type DepsFunction = (ctx: Context) => unknown | Promise<unknown>;

/** Builds the `deps` an agent run on a WebSocket connection passes to its tools */
export type WebSocketDepsFunction = (req: IncomingMessage) => unknown | Promise<unknown>;

export interface WebSocketConfig {
  path?: string;
  pingInterval?: number;
  pingTimeout?: number;
  maxPayloadSize?: number;
  auth?: WebSocketAuthFunction;
  /**
   * Whether a connection without a `userId` from `auth` may open: `'allow'` lets it in,
   * `'deny'` refuses the upgrade with `401`. Default: the `anonymous` of the route context,
   * else `'allow'`
   */
  anonymous?: AnonymousPolicy;
  /**
   * Builds the `deps` of the agent runs and resumes on a connection, from its upgrade request,
   * called for each run. Deps never come from a message.
   */
  deps?: WebSocketDepsFunction;
}

export type { SwaggerConfig } from '@cogitator-ai/server-shared';
import type { SwaggerConfig } from '@cogitator-ai/server-shared';

export interface CogitatorAppOptions {
  cogitator: Cogitator;
  agents?: Record<string, Agent>;
  workflows?: Record<string, Workflow<WorkflowState>>;
  swarms?: Record<string, SwarmConfig>;
  auth?: AuthFunction;
  enableSwagger?: boolean;
  swagger?: SwaggerConfig;
  bodyLimit?: number;
  /**
   * How often the SSE routes write a comment while a stream is open, in milliseconds,
   * so proxies and load balancers do not close a stream that waits on a slow tool or
   * model. Default: 5000. `0` turns heartbeats off.
   */
  sseHeartbeatMs?: number;
  /**
   * Keys of a run's `context` that clients may set. The run adds `context` to the system
   * prompt, so by default (`false`) a request with `context` is refused with 400. List the
   * keys clients may send, or pass `true` only for clients trusted like the server itself.
   */
  acceptContext?: ContextPolicy;
  /**
   * Roles clients may add with `POST /threads/:id/messages`. Default: `user` and
   * `assistant`. A `system` message is read by the model as operator instructions.
   */
  threadMessageRoles?: readonly ThreadMessageRole[];
  /**
   * Caps on what a request may ask a run for. A swarm run times out after at most
   * `swarmTimeout` ms and a workflow run takes at most `workflowMaxIterations` iterations and
   * `workflowMaxConcurrency` nodes at once, over HTTP and SSE (WebSocket runs take the
   * `limits` of the `RouteContext` given to `setupWebSocket`). A request that asks for more is
   * held to the cap, one that asks for nothing gets it. Each limit must be a positive integer,
   * or creating the router throws.
   */
  limits?: RunLimits;
  /**
   * Whether a caller without a `userId` may use the API: `'allow'` (the default) lets them
   * in, `'deny'` answers `401 UNAUTHORIZED`. `/health`, `/ready`, `/openapi.json` and `/docs`
   * stay open either way.
   */
  anonymous?: AnonymousPolicy;
  /**
   * Decides whether a caller may touch a thread, on top of the ownership check of core:
   * called with what `auth` returned and the thread a request names, on agent runs, streams
   * and resumes, swarm runs and the thread routes. `false` answers `403 THREAD_FORBIDDEN` and
   * starts no run.
   */
  authorizeThread?: AuthorizeThread<AuthContext>;
  /**
   * Builds the `deps` of the agent runs and resumes of a request, which tools get as
   * `context.deps` and the model never sees: a database handle, a tenant, a client. Deps
   * never come from the request body. WebSocket runs use `WebSocketConfig.deps`.
   */
  deps?: DepsFunction;
  /**
   * Where workflow runs keep their checkpoints. With a store, a run with
   * `options.checkpoint: true` saves checkpoints owned by the caller, its answer names the
   * last one as `checkpointId`, and `POST /workflows/:name/resume` (and `/resume/stream`)
   * resumes from one of them. Without it such a run is refused with 400 and every resume
   * answers 404 `CHECKPOINT_NOT_FOUND`.
   */
  workflowCheckpoints?: CheckpointStore;
}

export interface CogitatorState {
  cogitator: RouteContext;
  auth?: AuthContext;
  requestId: string;
  startTime: number;
}

export interface RouteContext {
  runtime: Cogitator;
  agents: Record<string, Agent>;
  workflows: Record<string, Workflow<WorkflowState>>;
  swarms: Record<string, SwarmConfig>;
  /** The resolved `sseHeartbeatMs` option; the default applies when it is absent */
  sseHeartbeatMs?: number;
  /** Keys of `context` clients may set, see `CogitatorAppOptions.acceptContext`. Default: none */
  acceptContext?: ContextPolicy;
  /** Roles clients may add to threads. Default: `user` and `assistant` */
  threadMessageRoles?: readonly ThreadMessageRole[];
  /** Caps on what a request may ask a run for, see `CogitatorAppOptions.limits`. Default: none */
  limits?: RunLimits;
  /**
   * Who may touch a thread, see `CogitatorAppOptions.authorizeThread`. Default: every caller
   * may touch the threads core lets them
   */
  authorizeThread?: AuthorizeThread<AuthContext>;
  /**
   * Whether a caller without a `userId` may use the API, see `CogitatorAppOptions.anonymous`.
   * `setupWebSocket` applies it to the handshake when `WebSocketConfig.anonymous` is not set.
   * Default: `'allow'`
   */
  anonymous?: AnonymousPolicy;
  /**
   * Builds the `deps` of HTTP agent runs, see `CogitatorAppOptions.deps`. It gets the Koa
   * `Context` of a request, which a WebSocket upgrade does not have, so `setupWebSocket` does
   * not use it: WebSocket runs take `WebSocketConfig.deps`. Default: none
   */
  deps?: DepsFunction;
  /** The `workflowCheckpoints` option. Default: none, workflow runs keep no checkpoints */
  workflowCheckpoints?: CheckpointStore;
}

export interface AgentListResponse {
  agents: Array<{
    name: string;
    description?: string;
    tools: string[];
  }>;
}

export interface AgentRunRequest {
  input: string;
  context?: Record<string, unknown>;
  threadId?: string;
}

export type { AgentRunResponse };

export interface AgentResumeRequest {
  threadId: string;
  decisions?: Record<string, ToolApprovalDecision>;
  defaultDecision?: ToolApprovalDecision;
}

export interface ThreadResponse {
  id: string;
  messages: Message[];
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  /** Pass as `cursor` to read the page before this one, absent at the thread's start */
  nextCursor?: string;
}

export interface AddMessageRequest {
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ToolListResponse {
  tools: Array<{
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  }>;
}

export interface WorkflowListResponse {
  workflows: Array<{
    name: string;
    entryPoint: string;
    nodes: string[];
  }>;
}

export type WorkflowRunRequest = WorkflowRunRequestBody;

export interface WorkflowRunResponse {
  workflowId: string;
  workflowName: string;
  state: WorkflowState;
  duration: number;
  nodeResults: Record<string, { output: unknown; duration: number }>;
  /** The last checkpoint of a run with `options.checkpoint` or of a resume */
  checkpointId?: string;
}

export type WorkflowResumeRequest = WorkflowResumeRequestBody;

export interface WorkflowStatusResponse {
  runId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  currentNode?: string;
  progress?: number;
  error?: string;
}

export interface SwarmListResponse {
  swarms: Array<{
    name: string;
    strategy: string;
    agents: string[];
  }>;
}

export interface SwarmRunRequest {
  input: string;
  context?: Record<string, unknown>;
  threadId?: string;
  timeout?: number;
}

export interface SwarmRunResponse {
  swarmId: string;
  swarmName: string;
  strategy: string;
  output: unknown;
  agentResults: Record<string, unknown>;
  usage: {
    totalTokens: number;
    totalCost: number;
    elapsedTime: number;
  };
}

export interface BlackboardResponse {
  sections: Record<string, unknown>;
}

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  version?: string;
  uptime: number;
  timestamp: number;
  checks?: Record<
    string,
    {
      status: 'ok' | 'error';
      message?: string;
    }
  >;
}

export interface ErrorResponse {
  error: {
    message: string;
    code?: string;
    details?: unknown;
  };
}

export interface WebSocketMessage {
  type: 'run' | 'resume' | 'stop' | 'ping';
  id?: string;
  payload?: unknown;
}

export interface WebSocketRunPayload {
  type: 'agent' | 'workflow' | 'swarm';
  name: string;
  input: string;
  context?: Record<string, unknown>;
  threadId?: string;
}

export interface WebSocketResumePayload extends AgentResumeRequest {
  name: string;
}

export interface WebSocketResponse {
  type: 'event' | 'error' | 'pong';
  id?: string;
  payload?: unknown;
  error?: string;
}
