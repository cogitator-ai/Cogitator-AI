export { cogitatorController } from './controller.js';
export { callerHook } from './auth.js';
export type { CallerFields, CallerHook } from './auth.js';
export {
  cogitatorErrors,
  cogitatorErrorResponse,
  cogitatorErrorStatus,
  describeError,
  CLIENT_CLOSED_REQUEST,
} from './errors.js';
export type { DescribedError } from './errors.js';

export {
  RunBody,
  SwarmRunBody,
  WorkflowRunBody,
  AddMessageBody,
  SocketMessage,
  AgentRunResponse,
  AgentListResponse,
  ThreadResponse,
  ToolListResponse,
  WorkflowListResponse,
  WorkflowRunResponse,
  SwarmListResponse,
  SwarmRunResponse,
  BlackboardResponse,
  HealthResponse,
} from './schemas.js';

export type {
  AuthContext,
  Authenticate,
  AuthorizeThread,
  CogitatorDeps,
  ShutdownSignal,
  WebSocketOptions,
  AgentRunRequest,
  SwarmRunRequest,
  WorkflowRunRequest,
  AddMessageRequest,
  HealthResponseBody,
  AgentListResponseBody,
  AgentRunResponseBody,
  ThreadResponseBody,
  ToolListResponseBody,
  WorkflowListResponseBody,
  WorkflowRunResponseBody,
  SwarmListResponseBody,
  SwarmRunResponseBody,
  BlackboardResponseBody,
  WebSocketClientMessage,
  WebSocketServerMessage,
} from './types.js';

export type { StreamEvent, Usage } from '@cogitator-ai/server-shared';
