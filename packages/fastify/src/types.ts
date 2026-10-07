import type { FastifyRequest } from 'fastify';
import type { Cogitator, Agent } from '@cogitator-ai/core';
import {
  MAX_RUN_TIMEOUT_MS,
  NON_BLANK_PATTERN,
  RUN_INPUT_SCHEMA,
} from '@cogitator-ai/server-shared';
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
  AgentRunResponse,
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
  /**
   * Declare an optional bearer token so Swagger UI offers to send one.
   * Defaults to whether the plugin has `auth`.
   */
  auth?: boolean;
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

export interface CogitatorContext {
  runtime: Cogitator;
  agents: Record<string, Agent>;
  workflows: Record<string, Workflow<WorkflowState>>;
  swarms: Record<string, SwarmConfig>;
  /** The resolved `sseHeartbeatMs` option; the default applies when it is absent */
  sseHeartbeatMs?: number;
  /** The resolved `acceptContext` option. Default: no keys */
  acceptContext?: ContextPolicy;
  /** The resolved `threadMessageRoles` option. Default: `user` and `assistant` */
  threadMessageRoles?: readonly ThreadMessageRole[];
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

const NON_BLANK_STRING = { type: 'string', minLength: 1, pattern: NON_BLANK_PATTERN } as const;

const CONTEXT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  description:
    'Values the run adds to the system prompt as data; refused unless `acceptContext` allows the keys',
} as const;

export const AgentRunRequestSchema = {
  type: 'object',
  properties: {
    input: RUN_INPUT_SCHEMA,
    context: CONTEXT_SCHEMA,
    threadId: NON_BLANK_STRING,
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
        reasoningTokens: { type: 'number' },
        cachedInputTokens: { type: 'number' },
        cacheWriteTokens: { type: 'number' },
      },
    },
    toolCalls: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          arguments: { type: 'object', additionalProperties: true },
        },
        required: ['id', 'name', 'arguments'],
      },
    },
    reasoning: { type: 'string' },
    status: { type: 'string', enum: ['completed', 'paused'] },
    structured: {},
    structuredError: { type: 'string' },
    truncated: { type: 'boolean' },
    blocked: { type: 'string', enum: ['content_filter', 'refusal'] },
    iterationLimitReached: { type: 'boolean' },
    traceId: { type: 'string' },
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
  required: ['output', 'threadId', 'usage', 'toolCalls', 'status', 'traceId'],
} as const;

export const AddMessageRequestSchema = {
  type: 'object',
  properties: {
    role: {
      type: 'string',
      enum: ['user', 'assistant', 'system'],
      description: '`system` is refused unless `threadMessageRoles` allows it',
    },
    content: NON_BLANK_STRING,
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
        checkpoint: {
          type: 'boolean',
          enum: [false],
          description: 'Only `false`: the server keeps no checkpoint store',
        },
      },
      additionalProperties: false,
    },
  },
} as const;

export const SwarmRunRequestSchema = {
  type: 'object',
  properties: {
    input: RUN_INPUT_SCHEMA,
    context: CONTEXT_SCHEMA,
    threadId: NON_BLANK_STRING,
    timeout: { type: 'number', exclusiveMinimum: 0, maximum: MAX_RUN_TIMEOUT_MS },
  },
  required: ['input'],
} as const;
