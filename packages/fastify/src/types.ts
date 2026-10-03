import type { FastifyRequest } from 'fastify';
import type { Cogitator, Agent } from '@cogitator-ai/core';
import type { PendingApproval } from '@cogitator-ai/server-shared';
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
  request: FastifyRequest
) => Promise<AuthContext | undefined> | AuthContext | undefined;

export interface RateLimitConfig {
  max: number;
  timeWindow: number | string;
  keyGenerator?: (request: FastifyRequest) => string;
  errorResponseBuilder?: (
    request: FastifyRequest,
    context: { max: number; ttl: number }
  ) => { statusCode: number; error: string; message: string };
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
}

export interface CogitatorPluginOptions {
  cogitator: Cogitator;
  agents?: Record<string, Agent>;
  workflows?: Record<string, Workflow<WorkflowState>>;
  swarms?: Record<string, SwarmConfig>;
  prefix?: string;
  auth?: AuthFunction;
  rateLimit?: RateLimitConfig;
  enableSwagger?: boolean;
  enableWebSocket?: boolean;
  swagger?: SwaggerConfig;
  websocket?: WebSocketConfig;
}

export interface CogitatorContext {
  runtime: Cogitator;
  agents: Record<string, Agent>;
  workflows: Record<string, Workflow<WorkflowState>>;
  swarms: Record<string, SwarmConfig>;
}

declare module 'fastify' {
  interface FastifyInstance {
    cogitator: CogitatorContext;
  }

  interface FastifyRequest {
    cogitatorAuth?: AuthContext;
    cogitatorRequestId: string;
    cogitatorStartTime: number;
  }
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

const NON_BLANK_STRING = { type: 'string', minLength: 1, pattern: '\\S' } as const;

export const AgentRunRequestSchema = {
  type: 'object',
  properties: {
    input: NON_BLANK_STRING,
    context: { type: 'object', additionalProperties: true },
    threadId: { type: 'string' },
  },
  required: ['input'],
} as const;

const ToolApprovalDecisionSchema = {
  type: 'object',
  properties: {
    approved: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['approved'],
  additionalProperties: false,
} as const;

export const AgentResumeRequestSchema = {
  type: 'object',
  properties: {
    threadId: NON_BLANK_STRING,
    decisions: { type: 'object', additionalProperties: ToolApprovalDecisionSchema },
    defaultDecision: ToolApprovalDecisionSchema,
  },
  required: ['threadId'],
} as const;

export const AgentRunResponseSchema = {
  type: 'object',
  properties: {
    output: { type: 'string' },
    threadId: { type: 'string' },
    usage: {
      type: 'object',
      properties: {
        inputTokens: { type: 'number' },
        outputTokens: { type: 'number' },
        totalTokens: { type: 'number' },
      },
    },
    toolCalls: { type: 'array' },
    reasoning: { type: 'string' },
    status: { type: 'string', enum: ['completed', 'paused'] },
    pendingApprovals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          toolCallId: { type: 'string' },
          toolName: { type: 'string' },
          arguments: { type: 'object', additionalProperties: true },
          description: { type: 'string' },
          sideEffects: { type: 'array', items: { type: 'string' } },
        },
        required: ['toolCallId', 'toolName', 'arguments', 'description'],
      },
    },
  },
} as const;

export const AddMessageRequestSchema = {
  type: 'object',
  properties: {
    role: { type: 'string', enum: ['user', 'assistant', 'system'] },
    content: { type: 'string', minLength: 1 },
    metadata: { type: 'object', additionalProperties: true },
  },
  required: ['role', 'content'],
} as const;

export const WorkflowRunRequestSchema = {
  type: 'object',
  properties: {
    input: { type: 'object', additionalProperties: true },
    options: {
      type: 'object',
      properties: {
        maxConcurrency: { type: 'integer', minimum: 1 },
        maxIterations: { type: 'integer', minimum: 1 },
        checkpoint: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
} as const;

export const SwarmRunRequestSchema = {
  type: 'object',
  properties: {
    input: NON_BLANK_STRING,
    context: { type: 'object', additionalProperties: true },
    threadId: { type: 'string' },
    timeout: { type: 'number', exclusiveMinimum: 0 },
  },
  required: ['input'],
} as const;
