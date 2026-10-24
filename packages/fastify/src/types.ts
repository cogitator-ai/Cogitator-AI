import type { FastifyRequest } from 'fastify';
import type { Cogitator, Agent } from '@cogitator-ai/core';
import {
  MAX_RUN_TIMEOUT_MS,
  MAX_THREAD_PAGE_LIMIT,
  MULTITASK_STRATEGIES,
  NON_BLANK_PATTERN,
  RUN_INPUT_SCHEMA,
} from '@cogitator-ai/server-shared';
import type {
  AgentRunResponse,
  AnonymousPolicy,
  AuthorizeThread,
  ContextPolicy,
  PendingApproval,
  PendingInterrupt,
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
  ReadinessResponse,
  ReadinessCheckStatus,
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
  /**
   * Caps on what a request may ask a run for: a swarm's `timeout`, a workflow's
   * `maxIterations` and `maxConcurrency`. A request asking for more gets the cap, one asking
   * for nothing gets the cap too. Checked when the plugin is registered.
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
   * Builds the `deps` an agent run, stream or resume gets for a request (tools read them as
   * `context.deps`), over HTTP and WebSocket. deps never come from the request body.
   */
  deps?: (request: FastifyRequest) => unknown | Promise<unknown>;
  /**
   * Where workflow runs keep their checkpoints. With a store, a run with
   * `options.checkpoint: true` saves checkpoints owned by the caller, its answer names the
   * last one as `checkpointId`, and `POST /workflows/:name/resume` (and `/resume/stream`)
   * resumes from one of them. Without it such a run is refused with 400 and every resume
   * answers 404 `CHECKPOINT_NOT_FOUND`.
   */
  workflowCheckpoints?: CheckpointStore;
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
  /** The checked `limits` option */
  limits?: RunLimits;
  /** The `authorizeThread` option */
  authorizeThread?: AuthorizeThread<AuthContext>;
  /** The `deps` option */
  deps?: (request: FastifyRequest) => unknown | Promise<unknown>;
  /** The `workflowCheckpoints` option */
  workflowCheckpoints?: CheckpointStore;
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

export interface ThreadPageQuery {
  limit?: number;
  cursor?: string;
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

const MULTITASK_STRATEGY_SCHEMA = {
  type: 'string',
  enum: MULTITASK_STRATEGIES,
  description:
    "What the run does when its thread has a run going on: wait (`enqueue`), fail with 409 THREAD_BUSY (`reject`), stop that run (`interrupt`), or stop it and branch from where it started (`rollback`). Default: the server's `multitaskStrategy`",
} as const;

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
    multitaskStrategy: MULTITASK_STRATEGY_SCHEMA,
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
    responses: {
      type: 'object',
      additionalProperties: true,
      description: "Answers to the paused run's interrupts, by interrupt id",
    },
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
    interrupts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', enum: ['approval', 'input'] },
          reason: { type: 'string' },
          message: { type: 'string' },
          responseSchema: { type: 'object', additionalProperties: true },
          expiresAt: { type: 'string' },
          toolCallId: { type: 'string' },
          toolName: { type: 'string' },
        },
        required: ['id', 'kind', 'reason', 'message'],
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

/**
 * A field the operator may cap: a larger value is held to the cap rather than refused, so
 * the schema gives the cap as the default and says so, without a `maximum`
 */
function limitedInteger(cap: number | undefined) {
  return {
    type: 'integer',
    minimum: 1,
    ...(cap !== undefined && {
      default: cap,
      description: `Held to ${cap}, the server's limit, which is also the default`,
    }),
  } as const;
}

const CHECKPOINT_SCHEMA = {
  type: 'boolean',
  description: 'Save checkpoints of the run to resume it from with `/resume`',
} as const;

const NO_CHECKPOINT_SCHEMA = {
  type: 'boolean',
  enum: [false],
  description: 'Only `false`: the server keeps no checkpoint store (`workflowCheckpoints`)',
} as const;

/**
 * The workflow run body, with the operator's limits on its options. `checkpoints` says the
 * server keeps a checkpoint store, so `options.checkpoint` may be `true`
 */
export function workflowRunRequestSchema(limits?: RunLimits, checkpoints = false) {
  return {
    type: 'object',
    properties: {
      input: { type: 'object', additionalProperties: true },
      options: {
        type: 'object',
        properties: {
          maxConcurrency: limitedInteger(limits?.workflowMaxConcurrency),
          maxIterations: limitedInteger(limits?.workflowMaxIterations),
          checkpoint: checkpoints ? CHECKPOINT_SCHEMA : NO_CHECKPOINT_SCHEMA,
        },
        additionalProperties: false,
      },
    },
  } as const;
}

export const WorkflowRunRequestSchema = workflowRunRequestSchema();

/** The workflow resume body, with the operator's limits on its options */
export function workflowResumeRequestSchema(limits?: RunLimits) {
  return {
    type: 'object',
    properties: {
      checkpointId: {
        ...NON_BLANK_STRING,
        description: 'A checkpoint of this workflow that belongs to the caller',
      },
      options: {
        type: 'object',
        properties: {
          maxConcurrency: limitedInteger(limits?.workflowMaxConcurrency),
          maxIterations: limitedInteger(limits?.workflowMaxIterations),
        },
        additionalProperties: false,
      },
    },
    required: ['checkpointId'],
  } as const;
}

export const WorkflowResumeRequestSchema = workflowResumeRequestSchema();

/** The swarm run body, with the operator's limit on its timeout */
export function swarmRunRequestSchema(limits?: RunLimits) {
  return {
    type: 'object',
    properties: {
      input: RUN_INPUT_SCHEMA,
      context: CONTEXT_SCHEMA,
      threadId: NON_BLANK_STRING,
      timeout: {
        type: 'number',
        exclusiveMinimum: 0,
        maximum: MAX_RUN_TIMEOUT_MS,
        ...(limits?.swarmTimeout !== undefined && {
          default: limits.swarmTimeout,
          description: `Held to ${limits.swarmTimeout} ms, the server's limit, which is also the default`,
        }),
      },
    },
    required: ['input'],
  } as const;
}

export const SwarmRunRequestSchema = swarmRunRequestSchema();

export const ThreadPageQuerySchema = {
  type: 'object',
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_THREAD_PAGE_LIMIT,
      description:
        'Answer the newest `limit` messages of what is left and a `nextCursor`, without it the whole thread',
    },
    cursor: {
      type: 'string',
      description: 'The `nextCursor` of the page after the one to read',
    },
  },
} as const;

export const ThreadResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    messages: { type: 'array', items: {} },
    metadata: { type: 'object', additionalProperties: true },
    createdAt: { type: 'number' },
    updatedAt: { type: 'number' },
    nextCursor: {
      type: 'string',
      description: 'Pass as `cursor` to read the page before this one, absent at the start',
    },
  },
  required: ['id', 'messages', 'createdAt', 'updatedAt'],
} as const;
