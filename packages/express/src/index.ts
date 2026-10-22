export { CogitatorServer } from './server.js';

export type {
  AuthContext,
  AuthFunction,
  DepsFunction,
  WebSocketDepsFunction,
  CogitatorRequest,
  CogitatorServerConfig,
  RateLimitConfig,
  CorsConfig,
  SwaggerConfig,
  WebSocketConfig,
  RouteContext,
  ResolvedServerConfig,
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
  WebSocketMessage,
  WebSocketResponse,
  OpenAPISpec,
  ExpressMiddleware,
} from './types.js';

export {
  createAuthMiddleware,
  createAnonymousGuard,
  createRateLimitMiddleware,
  createCorsMiddleware,
  errorHandler,
  notFoundHandler,
} from './middleware/index.js';

export {
  createHealthRoutes,
  createAgentRoutes,
  createThreadRoutes,
  createToolRoutes,
  createWorkflowRoutes,
  createSwarmRoutes,
} from './routes/index.js';

export {
  ExpressStreamWriter,
  setupSSEHeaders,
  generateId,
  encodeSSE,
  encodeDone,
} from './streaming/index.js';
export type { ExpressStreamWriterOptions } from './streaming/index.js';

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
} from './streaming/protocol.js';

export { generateOpenAPISpec, serveSwaggerUI } from './swagger/index.js';

export { setupWebSocket } from './websocket/index.js';
