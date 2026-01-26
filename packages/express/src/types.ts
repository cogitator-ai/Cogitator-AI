import type { Request, Response, NextFunction, Router } from 'express';
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

export interface CogitatorRequest extends Request {
  cogitator?: {
    auth?: AuthContext;
    requestId: string;
    startTime: number;
  };
}

export type AuthFunction = (
  req: Request
) => Promise<AuthContext | undefined> | AuthContext | undefined;

export interface RateLimitConfig {
  windowMs: number;
  max: number;
  message?: string;
  keyGenerator?: (req: Request) => string;
  skip?: (req: Request) => boolean;
}

export interface CorsConfig {
  origin: string | string[] | ((origin: string | undefined) => boolean);
  credentials?: boolean;
  methods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  maxAge?: number;
}

export interface SwaggerConfig {
  title?: string;
  description?: string;
  version?: string;
  contact?: {
    name?: string;
    email?: string;
    url?: string;
  };
  license?: {
    name: string;
    url?: string;
  };
  servers?: Array<{ url: string; description?: string }>;
}

export interface WebSocketConfig {
  path?: string;
  pingInterval?: number;
  pingTimeout?: number;
  maxPayloadSize?: number;
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
    requestTimeout?: number;
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

export type ExpressMiddleware = (
  req: CogitatorRequest,
  res: Response,
  next: NextFunction
) => void | Promise<void>;

export interface RouteContext {
  cogitator: Cogitator;
  agents: Record<string, Agent>;
  workflows: Record<string, Workflow<WorkflowState>>;
  swarms: Record<string, SwarmConfig>;
  config: Required<NonNullable<CogitatorServerConfig['config']>>;
}

export interface WebSocketMessage {
  type: 'subscribe' | 'unsubscribe' | 'run' | 'stop' | 'ping';
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

export interface OpenAPISpec {
  openapi: string;
  info: {
    title: string;
    description?: string;
    version: string;
    contact?: {
      name?: string;
      email?: string;
      url?: string;
    };
    license?: {
      name: string;
      url?: string;
    };
  };
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
  security?: Array<Record<string, string[]>>;
  tags?: Array<{ name: string; description?: string }>;
}
