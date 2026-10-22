export { cogitatorApp } from './app.js';

export type {
  AuthContext,
  AuthFunction,
  CogitatorAppOptions,
  CogitatorState,
  RouteContext,
  WebSocketConfig,
  WebSocketAuthFunction,
  WebSocketDepsFunction,
  DepsFunction,
  RunLimits,
  AnonymousPolicy,
  AuthorizeThread,
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
  WorkflowResumeRequest,
  WorkflowStatusResponse,
  SwarmListResponse,
  SwarmRunRequest,
  SwarmRunResponse,
  BlackboardResponse,
  HealthResponse,
  ReadinessResponse,
  ReadinessCheckStatus,
  ErrorResponse,
  SwaggerConfig,
  WebSocketMessage,
  WebSocketResponse,
  WebSocketRunPayload,
  WebSocketResumePayload,
} from './types.js';

export {
  createContextMiddleware,
  createAnonymousMiddleware,
  createAuthMiddleware,
  createBodyParser,
  createErrorHandler,
} from './middleware/index.js';

export type { BodyParserOptions } from './middleware/body-parser.js';

export {
  createHealthRoutes,
  createAgentRoutes,
  createThreadRoutes,
  createToolRoutes,
  createWorkflowRoutes,
  createSwarmRoutes,
} from './routes/index.js';

export { createSwaggerRoutes } from './swagger/index.js';

export { KoaStreamWriter, setupSSEHeaders } from './streaming/koa-stream-writer.js';
export type { KoaStreamWriterOptions } from './streaming/koa-stream-writer.js';

export {
  generateId,
  encodeSSE,
  encodeDone,
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
} from '@cogitator-ai/server-shared';

export type {
  StreamEvent,
  StartEvent,
  TextStartEvent,
  TextDeltaEvent,
  TextEndEvent,
  ReasoningStartEvent,
  ReasoningDeltaEvent,
  ReasoningEndEvent,
  ToolCallStartEvent,
  ToolCallDeltaEvent,
  ToolCallEndEvent,
  ToolResultEvent,
  ApprovalRequiredEvent,
  ErrorEvent,
  FinishEvent,
  Usage,
} from '@cogitator-ai/server-shared';

export { setupWebSocket } from './websocket/index.js';
