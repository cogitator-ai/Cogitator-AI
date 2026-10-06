import type { IncomingMessage } from 'http';
import type { Context } from 'koa';
import type { Cogitator, Agent } from '@cogitator-ai/core';
import type {
  AgentRunResponse,
  ContextPolicy,
  PendingApproval,
  ThreadMessageRole,
  WorkflowRunRequestBody,
} from '@cogitator-ai/server-shared';
import type {
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

export interface WebSocketConfig {
  path?: string;
  pingInterval?: number;
  pingTimeout?: number;
  maxPayloadSize?: number;
  auth?: WebSocketAuthFunction;
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
}

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
