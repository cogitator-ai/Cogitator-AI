import type { BaseCtx } from '@tetsujs/core';
import type { CallerHook } from './auth.js';
import type { z } from 'zod';
import type { Agent, Cogitator } from '@cogitator-ai/core';
import type { CheckpointStore, SwarmConfig, Workflow, WorkflowState } from '@cogitator-ai/types';
import type {
  AnonymousPolicy,
  AuthorizeThread as SharedAuthorizeThread,
  ContextPolicy,
  ResumableStreamOptions,
  RunLimits,
  ThreadMessageRole,
} from '@cogitator-ai/server-shared';
import type {
  AddMessageBody,
  AgentListResponse,
  AgentRunResponse,
  BlackboardResponse,
  HealthResponse,
  ResumeBody,
  RunBody,
  SocketMessage,
  SwarmListResponse,
  SwarmRunBody,
  SwarmRunResponse,
  ThreadResponse,
  ToolListResponse,
  WorkflowListResponse,
  WorkflowResumeBody,
  WorkflowRunBody,
  WorkflowRunResponse,
} from './schemas.js';

/**
 * Who is calling, as the `auth` function established it.
 *
 * `userId` scopes agent runs and the thread routes to the caller: a thread
 * belongs to the user who created it, and another user's thread answers
 * `403 THREAD_ACCESS_DENIED`. Callers without a `userId` share the threads
 * that have no owner.
 */
export interface AuthContext {
  userId?: string;
  roles?: string[];
  permissions?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Establishes the caller before the request body is read.
 *
 * Return the caller to let the request through, or `undefined` to refuse it
 * with `401 UNAUTHORIZED`; any other error it throws or rejects with (an expired
 * token, say) refuses it with `401` too. Throw an `HttpError` to answer with
 * another status. Return an empty object to accept anonymous callers, unless
 * `anonymous` is `'deny'`.
 */
export type Authenticate = (
  ctx: BaseCtx
) => AuthContext | undefined | Promise<AuthContext | undefined>;

/**
 * Decides whether the caller may read or write a memory thread, on top of the
 * ownership check every thread route and agent run makes.
 *
 * Checked on the thread routes and on every run, stream and WebSocket run
 * that names a `threadId`. A refusal answers `403 THREAD_FORBIDDEN`.
 */
export type AuthorizeThread = SharedAuthorizeThread<AuthContext>;

/**
 * Builds the `deps` of the agent runs and resumes of a request, which tools get as
 * `context.deps` and the model never sees: a database handle, a tenant, a client.
 */
export type DepsBuilder = (ctx: BaseCtx) => unknown | Promise<unknown>;

/**
 * A signal that ends open SSE streams and WebSocket connections, such as
 * `draining` from `@tetsujs/lifecycle`, or a function that returns it.
 */
export type ShutdownSignal = AbortSignal | (() => AbortSignal | undefined);

export interface WebSocketOptions {
  /** Path of the handshake. Default: `/ws`. */
  path?: `/${string}`;
  /**
   * Runs a socket may have going at once, told apart by the `id` of their frames. One more
   * gets an error with `code: 'TOO_MANY_RUNS'`. Default: `8`.
   */
  maxRuns?: number;
  /**
   * Bytes of frames that may wait for a client that reads slowly, once the socket pushes back.
   * Past them the socket is closed with `1008`, which cancels its runs. Default: 4 MiB.
   */
  maxBufferedBytes?: number;
}

/** What `cogitatorController()` is built from. */
export interface CogitatorDeps {
  cogitator: Cogitator;
  agents?: Record<string, Agent>;
  workflows?: Record<string, Workflow<WorkflowState>>;
  swarms?: Record<string, SwarmConfig>;
  /**
   * Establishes the caller before every route except `/health` and `/ready`, and
   * before the WebSocket handshake: a function, or a `callerHook()` wrapped in
   * `secured()` from `@tetsujs/openapi` to document it.
   */
  auth?: Authenticate | CallerHook;
  /**
   * Whether a caller without a `userId` may use the API: `'allow'` (the default) lets them
   * in, `'deny'` answers `401 UNAUTHORIZED`, on every route but `/health` and `/ready` and on
   * the WebSocket handshake. It covers callers `auth` returned `{}` for and, without `auth`,
   * every caller. `auth` returning `undefined` answers `401` under either policy.
   */
  anonymous?: AnonymousPolicy;
  authorizeThread?: AuthorizeThread;
  /**
   * Caps on what a request may ask a run for. A swarm run times out after at most
   * `swarmTimeout` ms and a workflow run takes at most `workflowMaxIterations` iterations and
   * `workflowMaxConcurrency` nodes at once, over HTTP, SSE and WebSocket alike. A request that
   * asks for more is held to the cap, one that asks for nothing gets it. Each limit must be a
   * positive integer, or building the controller throws.
   */
  limits?: RunLimits;
  /**
   * Builds the `deps` of the agent runs and resumes of a request (`RunOptions.deps`). Called
   * for each HTTP run with its request context, and once for a WebSocket connection with its
   * handshake, whose runs all get what it built. Deps never come from the request body.
   */
  deps?: DepsBuilder;
  /** Serve the WebSocket endpoint. Default: `false`. */
  websocket?: boolean | WebSocketOptions;
  /** Ends streams and sockets when the server starts draining. */
  until?: ShutdownSignal;
  /**
   * How often the SSE routes write a comment while a stream is open, in milliseconds.
   * Keeps a run that waits on a slow tool or model from being cut off by the idle
   * timeout of `Bun.serve` (10 s by default) or of a proxy. Default: 5000. `0` turns
   * heartbeats off.
   */
  sseHeartbeatMs?: number;
  /**
   * Keys of a run's `context` that clients may set. The run adds `context` to the system
   * prompt, so by default (`false`) a request with `context` is refused with
   * `400 VALIDATION_FAILED`. List the keys clients may send, or pass `true` only for clients
   * trusted like the server itself.
   */
  acceptContext?: ContextPolicy;
  /**
   * Roles clients may add with `POST /threads/:id/messages`. Default: `user` and
   * `assistant`. A `system` message is read by the model as operator instructions.
   */
  threadMessageRoles?: readonly ThreadMessageRole[];
  /**
   * Where workflow runs keep their checkpoints. With a store, a run with
   * `options.checkpoint: true` saves checkpoints owned by the caller, its answer names the
   * last one as `checkpointId`, and `POST /workflows/:name/resume` (and `/resume/stream`)
   * resumes from one of them. Without it such a run fails validation and every resume answers
   * `404 CHECKPOINT_NOT_FOUND`.
   */
  workflowCheckpoints?: CheckpointStore;
  /**
   * Keeps the streams of `/agents/:name/stream` and `/agents/:name/resume/stream` so a
   * client that loses one can resume it. Every event then carries an SSE `id`, and a client
   * that disconnects no longer stops the run: it goes on, and the same route with
   * `Last-Event-ID` (or `?lastEventId=`) replays what the client missed and follows the run to
   * its end. A run nobody follows for `detachedTimeoutMs` (5 minutes) is stopped, and so is
   * every run when `until` fires. `true` keeps the events in memory with the default limits.
   * Default: off, a client that disconnects stops the run.
   */
  resumableStreams?: boolean | ResumableStreamOptions;
}

export type AgentRunRequest = z.input<typeof RunBody>;
export type AgentResumeRequest = z.input<typeof ResumeBody>;
export type SwarmRunRequest = z.input<typeof SwarmRunBody>;
export type WorkflowRunRequest = z.input<typeof WorkflowRunBody>;
export type WorkflowResumeRequest = z.input<typeof WorkflowResumeBody>;
export type AddMessageRequest = z.input<typeof AddMessageBody>;
export type HealthResponseBody = z.output<typeof HealthResponse>;
export type AgentListResponseBody = z.output<typeof AgentListResponse>;
export type AgentRunResponseBody = z.output<typeof AgentRunResponse>;
export type ThreadResponseBody = z.output<typeof ThreadResponse>;
export type ToolListResponseBody = z.output<typeof ToolListResponse>;
export type WorkflowListResponseBody = z.output<typeof WorkflowListResponse>;
export type WorkflowRunResponseBody = z.output<typeof WorkflowRunResponse>;
export type SwarmListResponseBody = z.output<typeof SwarmListResponse>;
export type SwarmRunResponseBody = z.output<typeof SwarmRunResponse>;
export type BlackboardResponseBody = z.output<typeof BlackboardResponse>;
export type WebSocketClientMessage = z.input<typeof SocketMessage>;

/** A frame the server sends over the WebSocket. */
export interface WebSocketServerMessage {
  type: 'event' | 'error' | 'pong';
  id?: string;
  payload?: unknown;
  error?: string;
  code?: string;
}
