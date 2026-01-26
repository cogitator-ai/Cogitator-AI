export { CogitatorServer } from './server.js';

export type {
  AuthContext,
  AuthFunction,
  CogitatorRequest,
  CogitatorServerConfig,
  RateLimitConfig,
  CorsConfig,
  SwaggerConfig,
  WebSocketConfig,
  RouteContext,
  AgentListResponse,
  AgentRunRequest,
  AgentRunResponse,
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
  createAuthMiddleware,
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

export type {
  StreamEvent,
  StartEvent,
  TextStartEvent,
  TextDeltaEvent,
  TextEndEvent,
  ToolCallStartEvent,
  ToolCallDeltaEvent,
  ToolCallEndEvent,
  ToolResultEvent,
  ErrorEvent,
  FinishEvent,
  Usage,
} from './streaming/protocol.js';

export { generateOpenAPISpec, serveSwaggerUI } from './swagger/index.js';

export { setupWebSocket } from './websocket/index.js';
