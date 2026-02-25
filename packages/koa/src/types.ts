import type { Context } from 'koa';
import type { Cogitator, Agent } from '@cogitator-ai/core';
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

export interface WebSocketConfig {
  path?: string;
  pingInterval?: number;
  pingTimeout?: number;
  maxPayloadSize?: number;
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

export interface AgentRunResponse {
  output: string;
  threadId?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  toolCalls: ToolCall[];
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
  type: 'run' | 'stop' | 'ping';
  id?: string;
  payload?: unknown;
}

export interface WebSocketResponse {
  type: 'event' | 'error' | 'pong';
  id?: string;
  payload?: unknown;
  error?: string;
}
