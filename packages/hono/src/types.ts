import type { Context as HonoContext } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import type { Cogitator, Agent } from '@cogitator-ai/core';
import type { PendingApproval, RunUsage } from '@cogitator-ai/server-shared';
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
  c: HonoContext<HonoEnv>
) => Promise<AuthContext | undefined> | AuthContext | undefined;

export interface WebSocketConfig {
  path?: string;
  maxPayloadSize?: number;
  upgradeWebSocket?: UpgradeWebSocket;
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
  enableWebSocket?: boolean;
  websocket?: WebSocketConfig;
  bodyLimit?: number;
  /**
   * How often the SSE routes write a comment while a stream is open, in milliseconds.
   * Keeps a run that waits on a slow tool or model from being cut off by an idle
   * timeout (`Bun.serve` closes a connection silent for 10 s, nginx one silent for
   * 60 s). Default: 5000. `0` turns heartbeats off.
   */
  sseHeartbeatMs?: number;
}

export interface CogitatorContext {
  runtime: Cogitator;
  agents: Record<string, Agent>;
  workflows: Record<string, Workflow<WorkflowState>>;
  swarms: Record<string, SwarmConfig>;
  /** The resolved `sseHeartbeatMs` option; the default applies when it is absent */
  sseHeartbeatMs?: number;
}

export type HonoEnv = {
  Variables: {
    cogitator: CogitatorContext;
    cogitatorAuth?: AuthContext;
    cogitatorRequestId: string;
    cogitatorStartTime: number;
  };
};

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

export interface AgentRunResponse {
  output: string;
  threadId?: string;
  usage: RunUsage;
  toolCalls: ToolCall[];
  reasoning?: string;
  status?: 'completed' | 'paused';
  pendingApprovals?: PendingApproval[];
}

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

export interface WorkflowRunRequest {
  input?: Record<string, unknown>;
  options?: {
    maxConcurrency?: number;
    maxIterations?: number;
    checkpoint?: boolean;
  };
}

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

export interface WebSocketClientState {
  id: string;
  auth?: AuthContext;
  abortController?: AbortController;
}

export interface WebSocketLike {
  send(data: string): void;
  close?(code?: number, reason?: string): void;
  readonly readyState: number;
}

export interface WebSocketResponse {
  type: 'event' | 'error' | 'pong';
  id?: string;
  payload?: unknown;
  error?: string;
}
