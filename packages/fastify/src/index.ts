export { cogitatorPlugin } from './plugin.js';

export type {
  CogitatorPluginOptions,
  CogitatorContext,
  AuthContext,
  AuthFunction,
  RateLimitConfig,
  SwaggerConfig,
  WebSocketConfig,
  AgentListResponse,
  AgentRunRequest,
  AgentRunResponse,
  AgentResumeRequest,
  PendingApproval,
  ThreadResponse,
  AddMessageRequest,
  ToolListResponse,
  WorkflowListResponse,
  WorkflowRunRequest,
  WorkflowRunResponse,
  WorkflowStatusResponse,
  SwarmListResponse,
  SwarmRunRequest,
  SwarmRunResponse,
  BlackboardResponse,
  HealthResponse,
  ErrorResponse,
  WebSocketMessage,
  WebSocketResponse,
  OpenAPISpec,
} from './types.js';

export {
  AgentRunRequestSchema,
  AgentRunResponseSchema,
  AgentResumeRequestSchema,
  AddMessageRequestSchema,
  WorkflowRunRequestSchema,
  SwarmRunRequestSchema,
} from './types.js';

export { FastifyStreamWriter } from './streaming/index.js';
export type { FastifyStreamWriterOptions } from './streaming/index.js';

export type { StreamEvent, Usage } from './streaming/protocol.js';

export {
  createStartEvent,
  createTextStartEvent,
  createTextDeltaEvent,
  createTextEndEvent,
  createReasoningStartEvent,
  createReasoningDeltaEvent,
  createReasoningEndEvent,
  createToolCallStartEvent,
  createToolCallDeltaEvent,
  createToolCallEndEvent,
  createToolResultEvent,
  createApprovalRequiredEvent,
  createErrorEvent,
  createFinishEvent,
  createWorkflowEvent,
  createSwarmEvent,
} from './streaming/protocol.js';

export { generateId, encodeSSE, encodeDone } from './streaming/helpers.js';
