import type { IncomingMessage } from 'http';
import type { Request, Response, NextFunction, Router } from 'express';
import type { Cogitator, Agent } from '@cogitator-ai/core';
import type {
  AgentRunResponse,
  AnonymousPolicy,
  AuthorizeThread,
  ContextPolicy,
  PendingApproval,
  PendingInterrupt,
  ResumableStreamOptions,
  ResumableStreams,
  RunLimits,
  SwaggerConfig,
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
  MultitaskStrategy,
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
  PendingInterrupt,
  AgentRunResponse,
};

export interface AuthContext {
  userId?: string;
  roles?: string[];
  permissions?: string[];
  metadata?: Record<string, unknown>;
}

export interface CogitatorRequest<P = Request['params']> extends Request<P> {
  cogitator?: {
    auth?: AuthContext;
    requestId: string;
    startTime: number;
  };
}

export type AuthFunction = (
  req: Request
) => Promise<AuthContext | undefined> | AuthContext | undefined;

/** Builds the `deps` an agent run of an HTTP request passes to its tools */
export type DepsFunction = (req: Request) => unknown | Promise<unknown>;

/**
 * Builds the `deps` an agent run on a WebSocket connection passes to its tools, from the
 * upgrade request
 */
export type WebSocketDepsFunction = (req: IncomingMessage) => unknown | Promise<unknown>;

export interface RateLimitConfig {
  windowMs: number;
  max: number;
  message?: string;
  keyGenerator?: (req: Request) => string;
  skip?: (req: Request) => boolean;
  trustProxy?: boolean;
}

export interface CorsConfig {
  origin: string | string[] | ((origin: string | undefined) => boolean);
  credentials?: boolean;
  methods?: string[];
  /**
   * Request headers a preflight allows. Default: `CORS_ALLOWED_HEADERS` of
   * `@cogitator-ai/server-shared` (`Content-Type`, `Authorization`, `X-Request-ID`,
   * `Last-Event-ID`). A list of your own replaces it: keep `Last-Event-ID` in it for clients on
   * another origin that reconnect to resumable streams
   */
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  maxAge?: number;
}

export type { SwaggerConfig } from '@cogitator-ai/server-shared';

export interface WebSocketConfig {
  path?: string;
  pingInterval?: number;
  maxPayloadSize?: number;
  /**
   * Builds the `deps` of each agent run and resume on a connection, from its upgrade request.
   * That request is a plain Node `IncomingMessage` that never went through Express, so it has
   * `headers`, `url` and `socket` but no `req.get()` and nothing a middleware adds. Default:
   * WebSocket runs get no deps. deps never come from a message.
   */
  deps?: WebSocketDepsFunction;
}

export interface CogitatorServerConfig {
  app: Router;
  cogitator: Cogitator;
  agents?: Record<string, Agent>;
  workflows?: Record<string, Workflow<WorkflowState>>;
  swarms?: Record<string, SwarmConfig>;
  config?: {
    basePath?: string;
    enableWebSocket?: boolean;
    enableSwagger?: boolean;
    auth?: AuthFunction;
    rateLimit?: RateLimitConfig;
    cors?: CorsConfig;
    swagger?: SwaggerConfig;
    websocket?: WebSocketConfig;
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
     * Caps on what a request may ask a run for: a swarm's `timeout`, a workflow's
     * `maxIterations` and `maxConcurrency`. A request asking for more gets the cap, one asking
     * for nothing gets the cap too. Checked when the server is created.
     */
    limits?: RunLimits;
    /**
     * Whether a caller without a user id may use the API. `'allow'` (the default) lets them
     * in, `'deny'` answers `401 UNAUTHORIZED` on every route but health, ready and the docs.
     */
    anonymous?: AnonymousPolicy;
    /**
     * Decides whether a caller may touch a thread, on top of the ownership check of core:
     * called with what `auth` returned and the thread a request names, on every route and
     * WebSocket run that names one. Answering `false` refuses with `403 THREAD_FORBIDDEN`
     * before any run starts.
     */
    authorizeThread?: AuthorizeThread<AuthContext>;
    /**
     * Builds the `deps` an agent run, stream or resume gets for an HTTP request (tools read
     * them as `context.deps`). deps never come from the request body. WebSocket runs use
     * `websocket.deps`, since their upgrade request is not an Express `Request`.
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
    /**
     * Keeps the streams of `/agents/:name/stream` and `/agents/:name/resume/stream` so a
     * client that loses one can resume it. Every event then carries an SSE `id`, and a client
     * that disconnects no longer stops the run: it goes on, and the same route with
     * `Last-Event-ID` (or `?lastEventId=`) replays what the client missed and follows the run to
     * its end, and `DELETE /agents/:name/stream/:streamId` cancels the run. Only the caller who
     * started a stream (every field of what `auth` returned, see `owner`) may reconnect to it or
     * cancel its run, after `authorizeThread` on its thread. A run nobody follows for
     * `detachedTimeoutMs` (5 minutes) is stopped, and every run when `until` aborts. `true` keeps
     * the events in memory with the default limits. Default: off, a client that disconnects
     * stops the run.
     */
    resumableStreams?: boolean | ResumableStreamOptions<AuthContext>;
  };
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
  /** What the run does when its thread has a run going on. Default: the Cogitator's `multitaskStrategy` */
  multitaskStrategy?: MultitaskStrategy;
}

export interface AgentResumeRequest {
  threadId: string;
  decisions?: Record<string, ToolApprovalDecision>;
  defaultDecision?: ToolApprovalDecision;
  /** Answers to the paused run's interrupts, by interrupt id */
  responses?: Record<string, unknown>;
}

export interface ThreadResponse {
  id: string;
  messages: Message[];
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  /** Pass as `cursor` to read the page before this one, absent at the start of the thread */
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

export type ExpressMiddleware = (
  req: CogitatorRequest,
  res: Response,
  next: NextFunction
) => void | Promise<void>;

type ServerOptions = NonNullable<CogitatorServerConfig['config']>;

/** The options that stay unset when the server is not given them */
type UnsetServerOptions =
  'limits' | 'authorizeThread' | 'deps' | 'workflowCheckpoints' | 'resumableStreams';

/** The server's options with their defaults applied */
export type ResolvedServerConfig = Required<Omit<ServerOptions, UnsetServerOptions>> &
  Pick<ServerOptions, UnsetServerOptions>;

export interface RouteContext {
  cogitator: Cogitator;
  agents: Record<string, Agent>;
  workflows: Record<string, Workflow<WorkflowState>>;
  swarms: Record<string, SwarmConfig>;
  config: ResolvedServerConfig;
  /** The streams kept for clients to resume, when `resumableStreams` is on */
  resumableStreams?: ResumableStreams<AuthContext>;
}

export interface WebSocketMessage {
  type: 'subscribe' | 'unsubscribe' | 'run' | 'resume' | 'stop' | 'ping';
  id?: string;
  channel?: string;
  payload?: unknown;
}

export interface WebSocketResponse {
  type: 'subscribed' | 'unsubscribed' | 'event' | 'error' | 'pong';
  id?: string;
  channel?: string;
  payload?: unknown;
  error?: string;
}

export type {
  OpenAPISpec,
  ReadinessResponse,
  ReadinessCheckStatus,
} from '@cogitator-ai/server-shared';
