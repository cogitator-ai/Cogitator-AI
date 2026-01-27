export { cogitatorApp } from './app.js';

export type {
  CogitatorAppOptions,
  CogitatorContext,
  HonoEnv,
  AuthContext,
  AuthFunction,
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
  WorkflowStatusResponse,
  SwarmListResponse,
  SwarmRunRequest,
  SwarmRunResponse,
  BlackboardResponse,
  HealthResponse,
  ErrorResponse,
  WebSocketMessage,
  WebSocketResponse,
} from './types.js';

export { HonoStreamWriter } from './streaming/hono-stream-writer.js';

export { createContextMiddleware } from './middleware/context.js';
export { createAuthMiddleware } from './middleware/auth.js';
export { errorHandler } from './middleware/error-handler.js';

export {
  createHealthRoutes,
  createAgentRoutes,
  createThreadRoutes,
  createToolRoutes,
  createWorkflowRoutes,
  createSwarmRoutes,
} from './routes/index.js';

export type { StreamEvent, Usage } from '@cogitator-ai/server-shared';

export {
  createStartEvent,
  createTextStartEvent,
  createTextDeltaEvent,
  createTextEndEvent,
  createToolCallStartEvent,
  createToolCallDeltaEvent,
  createToolCallEndEvent,
  createToolResultEvent,
  createErrorEvent,
  createFinishEvent,
  createWorkflowEvent,
  createSwarmEvent,
  generateId,
} from '@cogitator-ai/server-shared';
