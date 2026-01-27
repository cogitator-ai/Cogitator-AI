export { cogitatorApp } from './app.js';

export type {
  AuthContext,
  AuthFunction,
  CogitatorAppOptions,
  CogitatorState,
  RouteContext,
  WebSocketConfig,
  AgentListResponse,
  AgentRunRequest,
  AgentRunResponse,
  ThreadResponse,
  AddMessageRequest,
  ToolListResponse,
  WorkflowListResponse,
  WorkflowRunRequest,
  WorkflowRunResponse,
  SwarmListResponse,
  SwarmRunRequest,
  SwarmRunResponse,
  BlackboardResponse,
  HealthResponse,
  ErrorResponse,
  SwaggerConfig,
  WebSocketMessage,
  WebSocketResponse,
} from './types.js';

export {
  createContextMiddleware,
  createAuthMiddleware,
  createBodyParser,
  createErrorHandler,
} from './middleware/index.js';

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

export { generateId, encodeSSE, encodeDone } from '@cogitator-ai/server-shared';

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
} from '@cogitator-ai/server-shared';

export { setupWebSocket } from './websocket/index.js';
