/**
 * @cogitator-ai/openai-compat - OpenAI API Compatibility
 *
 * This package provides:
 * - REST API server: registered Cogitator agents over the Chat Completions and Responses APIs
 *   (the agent is the `model`), plus the deprecated Assistants API
 * - OpenAI SDK adapter: the Assistants API implementation behind the server
 */

export { OpenAIServer, createOpenAIServer } from './server/api-server';
export type { OpenAIServerConfig } from './server/api-server';
export { formatOpenAIError } from './server/middleware/error-handler';
export type { AuthConfig } from './server/middleware/auth';

export { OpenAIAdapter, createOpenAIAdapter, COGITATOR_MODEL_ID } from './client/openai-adapter';
export type {
  StreamEventType,
  StreamEventData,
  StreamEmitterEvents,
  RunStreamEvent,
  OpenAIAdapterOptions,
} from './client/openai-adapter';
export { InvalidRequestError } from './client/errors';
export { AgentTurnRunner, renderConversation } from './server/agents/agent-turn';
export type {
  AgentTurnRequest,
  AgentTurnResult,
  AgentTurnRunnerOptions,
  AgentTurnUsage,
  ClientFunction,
  ClientFunctionCall,
  ConversationItem,
  TurnToolChoice,
} from './server/agents/agent-turn';
export { ThreadManager } from './client/thread-manager';
export type {
  StoredThread,
  StoredAssistant,
  LLMThreadMessage,
  CreateAssistantParams,
  UpdateAssistantParams,
} from './client/thread-manager';

export {
  InMemoryThreadStorage,
  RedisThreadStorage,
  PostgresThreadStorage,
  createThreadStorage,
} from './client/storage';
export type {
  ThreadStorage,
  StoredFile,
  RedisThreadStorageConfig,
  PostgresThreadStorageConfig,
} from './client/storage';

export type {
  OpenAIError,
  ListResponse,
  Assistant,
  AssistantTool,
  FunctionDefinition,
  ResponseFormat,
  CreateAssistantRequest,
  UpdateAssistantRequest,
  Thread,
  ToolResources,
  CreateThreadRequest,
  Message,
  MessageIncompleteReason,
  MessageContent,
  TextContent,
  TextAnnotation,
  Attachment,
  CreateMessageRequest,
  MessageContentPart,
  Run,
  RunStatus,
  RequiredAction,
  ToolCall,
  RunError,
  Usage,
  ToolChoice,
  CreateRunRequest,
  SubmitToolOutputsRequest,
  ToolOutput,
  RunStep,
  StepDetails,
  StepToolCall,
  FileObject,
  FilePurpose,
  UploadFileRequest,
  StreamEvent,
  MessageDelta,
  RunStepDelta,
  MessageContentDelta,
  ImageFileContent,
  ImageUrlContent,
  JsonSchema,
  IncompleteDetails,
  TruncationStrategy,
} from './types/openai-types';
