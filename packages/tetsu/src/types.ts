import type { BaseCtx } from '@tetsujs/core';
import type { CallerHook } from './auth.js';
import type { z } from 'zod';
import type { Agent, Cogitator } from '@cogitator-ai/core';
import type { SwarmConfig, Workflow, WorkflowState } from '@cogitator-ai/types';
import type {
  AddMessageBody,
  AgentListResponse,
  AgentRunResponse,
  BlackboardResponse,
  HealthResponse,
  RunBody,
  SocketMessage,
  SwarmListResponse,
  SwarmRunBody,
  SwarmRunResponse,
  ThreadResponse,
  ToolListResponse,
  WorkflowListResponse,
  WorkflowRunBody,
  WorkflowRunResponse,
} from './schemas.js';

/**
 * Who is calling, as the `auth` function established it.
 *
 * `userId` is passed to every agent run, so memory and cost tracking are
 * attributed to the caller.
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
 * with `401 UNAUTHORIZED`. Throw an `HttpError` to answer with another status.
 * Return an empty object to accept anonymous callers.
 */
export type Authenticate = (
  ctx: BaseCtx
) => AuthContext | undefined | Promise<AuthContext | undefined>;

/**
 * Decides whether the caller may read or write a memory thread.
 *
 * Checked on the thread routes and on every run, stream and WebSocket run
 * that names a `threadId`. A refusal answers `403 THREAD_FORBIDDEN`.
 */
export type AuthorizeThread = (
  auth: AuthContext | undefined,
  threadId: string
) => boolean | Promise<boolean>;

/**
 * A signal that ends open SSE streams and WebSocket connections, such as
 * `draining` from `@tetsujs/lifecycle`, or a function that returns it.
 */
export type ShutdownSignal = AbortSignal | (() => AbortSignal | undefined);

export interface WebSocketOptions {
  /** Path of the handshake. Default: `/ws`. */
  path?: `/${string}`;
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
  authorizeThread?: AuthorizeThread;
  /** Serve the WebSocket endpoint. Default: `false`. */
  websocket?: boolean | WebSocketOptions;
  /** Ends streams and sockets when the server starts draining. */
  until?: ShutdownSignal;
}

export type AgentRunRequest = z.input<typeof RunBody>;
export type SwarmRunRequest = z.input<typeof SwarmRunBody>;
export type WorkflowRunRequest = z.input<typeof WorkflowRunBody>;
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
